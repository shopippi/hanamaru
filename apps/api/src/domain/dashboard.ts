import { and, asc, count, eq, gte, inArray, lt } from 'drizzle-orm';
import { lessonTypes, payments, reservations, rooms, students, teachers, trialRequests } from '../db/schema.js';
import { addDays, dateOf, DAY_MS, jst, monthOf, startOfMonth, weekdayOf, type Month } from '../lib/time.js';
import { assertAdmin } from './access.js';
import { creditShortages } from './booking.js';
import type { Actor, Ctx } from './context.js';
import { teacherMonthStats } from './schedule.js';
import { getSettings } from './settings.js';

// 管理者のダッシュボード（3.10）。管理画面を開いたときに最初に出す

const STATUSES = ['trial', 'enrolling', 'active', 'suspended', 'withdrawn'] as const;

/** DB-01: 状態別の人数。生徒一覧（状態で絞った件数）と同じ数え方 */
async function statusCounts(ctx: Ctx) {
  const rows = await ctx.db.select({ status: students.status, n: count() }).from(students).groupBy(students.status);
  return Object.fromEntries(STATUSES.map((s) => [s, rows.find((r) => r.status === s)?.n ?? 0])) as Record<(typeof STATUSES)[number], number>;
}

/** DB-02: 今日と今週の予約。講師別・教室別に切り替えられるよう、両方の名前を付ける */
async function upcoming(ctx: Ctx) {
  const now = ctx.now();
  const today = dateOf(now);
  // 週は月曜はじまり
  const monday = addDays(today, -((weekdayOf(today) + 6) % 7));
  const from = jst(monday);
  const to = jst(addDays(monday, 7));
  const rows = await ctx.db
    .select({
      id: reservations.id,
      startsAt: reservations.startsAt,
      endsAt: reservations.endsAt,
      status: reservations.status,
      teacherId: reservations.teacherId,
      teacherName: teachers.name,
      roomId: reservations.roomId,
      roomName: rooms.name,
      studentName: students.name,
      trialName: trialRequests.name,
      lessonTypeName: lessonTypes.name,
      online: lessonTypes.online,
    })
    .from(reservations)
    .innerJoin(teachers, eq(teachers.id, reservations.teacherId))
    .innerJoin(lessonTypes, eq(lessonTypes.id, reservations.lessonTypeId))
    .leftJoin(rooms, eq(rooms.id, reservations.roomId))
    .leftJoin(students, eq(students.id, reservations.studentId))
    .leftJoin(trialRequests, eq(trialRequests.id, reservations.trialRequestId))
    .where(and(inArray(reservations.status, ['pending', 'confirmed']), gte(reservations.startsAt, from), lt(reservations.startsAt, to)))
    .orderBy(asc(reservations.startsAt));
  const list = rows.map((r) => ({ ...r, studentName: r.studentName ?? `体験: ${r.trialName ?? ''}`, trialName: undefined }));
  return {
    today: list.filter((r) => dateOf(r.startsAt) === today),
    week: list,
    weekStart: monday,
  };
}

/** DB-03: 未払い・決済失敗の生徒と、猶予期間の残り日数。入金済みにすると消える */
async function unpaid(ctx: Ctx) {
  const settings = await getSettings(ctx.db);
  const rows = await ctx.db
    .select({
      paymentId: payments.id,
      studentId: students.id,
      studentName: students.name,
      month: payments.month,
      method: payments.method,
      amount: payments.amount,
      status: payments.status,
    })
    .from(payments)
    .innerJoin(students, eq(students.id, payments.studentId))
    .where(and(eq(payments.kind, 'monthly'), inArray(payments.status, ['pending', 'failed'])))
    .orderBy(asc(payments.month), asc(students.name));
  const now = ctx.now().getTime();
  return rows.map((r) => ({
    ...r,
    graceDaysLeft: Math.max(0, Math.ceil((startOfMonth(r.month!).getTime() + settings.graceDays * DAY_MS - now) / DAY_MS)),
  }));
}

export async function dashboard(ctx: Ctx, actor: Actor, opts: { month?: Month } = {}) {
  assertAdmin(actor);
  const month = opts.month ?? monthOf(ctx.now());
  const [counts, reservationsView, unpaidList, teacherStats, shortages, pendingApproval, pendingReservations, newTrials] =
    await Promise.all([
      statusCounts(ctx),
      upcoming(ctx),
      unpaid(ctx),
      teacherMonthStats(ctx.db, month),
      creditShortages(ctx.db, ctx.now()),
      ctx.db.select({ n: count() }).from(students).where(eq(students.approved, false)),
      ctx.db.select({ n: count() }).from(reservations).where(eq(reservations.status, 'pending')),
      ctx.db.select({ n: count() }).from(trialRequests).where(eq(trialRequests.status, 'new')),
    ]);
  return {
    studentCounts: counts,
    reservations: reservationsView,
    unpaid: unpaidList,
    teacherStats: { month, teachers: teacherStats },
    // 対応が必要なもの（ST-02 の承認、RS-06 の仮予約、TR-01 の申込、RS-07 の回数不足）
    todo: {
      pendingApproval: pendingApproval[0]?.n ?? 0,
      pendingReservations: pendingReservations[0]?.n ?? 0,
      newTrialRequests: newTrials[0]?.n ?? 0,
      creditShortages: shortages,
    },
  };
}
