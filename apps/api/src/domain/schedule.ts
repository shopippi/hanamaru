import { and, asc, count, eq, gte, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  availabilityExceptions,
  availabilityRules,
  closures,
  lessonTypes,
  reservations,
  schoolHours,
  students,
  teachers,
} from '../db/schema.js';
import { addDays, addMonths, dateOf, jst, minutesOf, startOfMonth, timeFromMinutes, type DateStr, type Month } from '../lib/time.js';
import { assertAdmin, assertTeacherSelfOrAdmin } from './access.js';
import { audit } from './audit.js';
import { availabilityChecker, schoolWindowsOf, teacherWindowsOf } from './availability.js';
import { cancelForCause, sendNotices, type Reservation } from './booking.js';
import type { Actor, Ctx } from './context.js';
import { invalid } from './errors.js';

// 講師の空き時間の変更（AV-01〜03）と休講（AV-04）、講師都合キャンセルの集計（AV-05）

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '時刻は 15:00 の形で入力してください');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ruleInput = z
  .object({
    weekday: z.number().int().min(0).max(6),
    startTime: time,
    endTime: time,
    lessonTypeId: z.string().uuid(),
    roomId: z.string().uuid().nullable().default(null),
    forTrial: z.boolean().default(false),
  })
  .refine((r) => minutesOf(r.startTime) < minutesOf(r.endTime), { message: '終了は開始より後にしてください' });

export const exceptionInput = z
  .object({
    date,
    kind: z.enum(['block', 'extra', 'override']),
    startTime: time.nullable().default(null),
    endTime: time.nullable().default(null),
    lessonTypeId: z.string().uuid().nullable().default(null),
    roomId: z.string().uuid().nullable().default(null),
    forTrial: z.boolean().default(false),
  })
  .refine((e) => (e.startTime === null) === (e.endTime === null), { message: '開始と終了の両方を入力してください' })
  .refine((e) => !e.startTime || !e.endTime || minutesOf(e.startTime) < minutesOf(e.endTime), {
    message: '終了は開始より後にしてください',
  })
  .refine((e) => e.kind !== 'extra' || (e.startTime && e.lessonTypeId), {
    message: '追加の空き時間には時刻とレッスン種別が必要です',
  })
  .refine((e) => e.kind !== 'override' || e.startTime === null, { message: '日ごとの設定の目印に時刻は入れません' });

export const availabilityChange = z.object({
  /** 指定すると曜日ごとの空き時間をこの内容に置き換える */
  rules: z.array(ruleInput).optional(),
  addExceptions: z.array(exceptionInput).default([]),
  removeExceptionIds: z.array(z.string().uuid()).default([]),
});
export type AvailabilityChange = z.input<typeof availabilityChange>;

export interface AffectedReservation {
  reservationId: string;
  studentName: string;
  startsAt: Date;
}

/** 影響する予約があるのに確認がないときに、変更を取り消すための目印 */
class NeedsConfirmation extends Error {
  constructor(readonly affected: AffectedReservation[]) {
    super('needs confirmation');
  }
}

async function affectedReservations(db: Db, teacherId: string, now: Date): Promise<Reservation[]> {
  const future = await db
    .select()
    .from(reservations)
    .where(
      and(
        eq(reservations.teacherId, teacherId),
        inArray(reservations.status, ['pending', 'confirmed']),
        gte(reservations.startsAt, now),
      ),
    )
    .orderBy(asc(reservations.startsAt));
  if (future.length === 0) return [];
  // 空き時間は期間の分をまとめて1回だけ読む（講師のロック中に何度も読まない）
  const isCovered = await availabilityChecker(db, teacherId, dateOf(future[0]!.startsAt), dateOf(future.at(-1)!.startsAt));
  return future.filter((r) => !isCovered(r, dateOf(r.startsAt)));
}

async function toAffected(db: Db, list: Reservation[]): Promise<AffectedReservation[]> {
  const out: AffectedReservation[] = [];
  for (const r of list) {
    const [s] = r.studentId ? await db.select({ name: students.name }).from(students).where(eq(students.id, r.studentId)) : [];
    out.push({ reservationId: r.id, studentName: s?.name ?? '体験', startsAt: r.startsAt });
  }
  return out;
}

/**
 * 講師本人か管理者が空き時間を変える（AV-01）。
 * 予約が入っている時間帯にかかる場合、confirm=false なら何も変えずに影響する予約を返す（AV-02）。
 * confirm=true なら変更し、影響する予約を「講師都合のキャンセル」として取り消す（AV-03）。
 */
export async function changeAvailability(
  ctx: Ctx,
  actor: Actor,
  teacherId: string,
  rawChange: AvailabilityChange,
  confirm: boolean,
): Promise<{ applied: boolean; affected: AffectedReservation[] }> {
  await assertTeacherSelfOrAdmin(ctx.db, actor, teacherId);
  const parsed = availabilityChange.safeParse(rawChange);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? '入力に誤りがあります', parsed.error.issues);
  const change = parsed.data;
  const typeIds = [
    ...(change.rules ?? []).map((r) => r.lessonTypeId),
    ...change.addExceptions.map((e) => e.lessonTypeId).filter((x): x is string => !!x),
  ];
  if (typeIds.length) {
    const found = await ctx.db.select({ id: lessonTypes.id }).from(lessonTypes).where(inArray(lessonTypes.id, typeIds));
    if (found.length !== new Set(typeIds).size) throw invalid('レッスン種別が見つかりません');
  }
  const now = ctx.now();
  try {
    const result = await ctx.db.transaction(async (tx) => {
      await tx.select({ id: teachers.id }).from(teachers).where(eq(teachers.id, teacherId)).for('update');
      if (change.rules) {
        await tx.delete(availabilityRules).where(eq(availabilityRules.teacherId, teacherId));
        if (change.rules.length) {
          await tx.insert(availabilityRules).values(change.rules.map((r) => ({ ...r, teacherId })));
        }
      }
      if (change.removeExceptionIds.length) {
        await tx
          .delete(availabilityExceptions)
          .where(and(eq(availabilityExceptions.teacherId, teacherId), inArray(availabilityExceptions.id, change.removeExceptionIds)));
      }
      if (change.addExceptions.length) {
        await tx.insert(availabilityExceptions).values(change.addExceptions.map((e) => ({ ...e, teacherId })));
      }
      const affected = await affectedReservations(tx, teacherId, now);
      if (affected.length && !confirm) throw new NeedsConfirmation(await toAffected(tx, affected));
      const notices = await cancelForCause(tx, affected, 'teacher', actor, now);
      await audit(tx, actor, 'availability.change', 'teacher', teacherId, {
        change: rawChange,
        cancelled: affected.map((r) => r.id),
      });
      return { affected: await toAffected(tx, affected), notices };
    });
    await sendNotices(ctx, result.notices);
    return { applied: true, affected: result.affected };
  } catch (e) {
    if (e instanceof NeedsConfirmation) return { applied: false, affected: e.affected };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// カレンダー（AV-06〜08）: 教室の受付時間と、講師の日ごとの空き時間
// ---------------------------------------------------------------------------

const windowInput = z
  .object({ startTime: time, endTime: time })
  .refine((w) => minutesOf(w.startTime) < minutesOf(w.endTime), { message: '終了は開始より後にしてください' });

/** 時間帯が重ならないこと */
const noOverlap = (ws: { startTime: string; endTime: string }[]) => {
  const sorted = [...ws].sort((a, b) => minutesOf(a.startTime) - minutesOf(b.startTime));
  return sorted.every((w, i) => i === 0 || minutesOf(sorted[i - 1]!.endTime) <= minutesOf(w.startTime));
};

export const schoolHoursInput = z.object({
  dates: z.array(date).min(1, '日付を選んでください').max(93),
  /** 空にすると、その日は受け付けない（休み） */
  windows: z.array(windowInput).max(6).refine(noOverlap, { message: '時間帯が重なっています' }),
});

/** その日の時間帯の中に、予約がまるごと収まっているか */
const fitsIn = (r: { startsAt: Date; endsAt: Date }, windows: { start: number; end: number }[]) => {
  const day = jst(dateOf(r.startsAt)).getTime();
  const s = (r.startsAt.getTime() - day) / 60000;
  const e = (r.endsAt.getTime() - day) / 60000;
  return windows.some((w) => w.start <= s && e <= w.end);
};

/**
 * 教室の受付時間を日付ごとに決める（AV-06）。選んだ日の時間帯を、まとめて同じ内容に置き換える。
 * 受付時間の外になる予約があれば、confirm=false では何も変えずに一覧を返し（AV-02 と同じ）、
 * confirm=true なら「教室都合のキャンセル」として取り消して回数を戻す（AV-04 と同じ）。
 */
export async function setSchoolHours(
  ctx: Ctx,
  actor: Actor,
  raw: unknown,
  confirm: boolean,
): Promise<{ applied: boolean; affected: AffectedReservation[] }> {
  assertAdmin(actor);
  const parsed = schoolHoursInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? '入力に誤りがあります', parsed.error.issues);
  const { windows } = parsed.data;
  const dates = [...new Set(parsed.data.dates)].sort();
  const now = ctx.now();
  if (dates[0]! < dateOf(now)) throw invalid('過ぎた日の受付時間は変えられません');
  const intervals = windows.map((w) => ({ start: minutesOf(w.startTime), end: minutesOf(w.endTime) }));
  try {
    const result = await ctx.db.transaction(async (tx) => {
      // 予約と同時に変えても食い違わないよう、講師の行をすべてロックする（予約は講師の行をロックしてから空きを確かめる）
      await tx.select({ id: teachers.id }).from(teachers).orderBy(asc(teachers.id)).for('update');
      await tx.delete(schoolHours).where(inArray(schoolHours.date, dates));
      if (windows.length) {
        await tx.insert(schoolHours).values(
          dates.flatMap((d) => windows.map((w) => ({ date: d, ...w, updatedBy: actor.kind === 'account' ? actor.accountId : null }))),
        );
      }
      const hit = await tx
        .select()
        .from(reservations)
        .where(
          and(
            inArray(reservations.status, ['pending', 'confirmed']),
            gte(reservations.startsAt, jst(dates[0]!)),
            lt(reservations.startsAt, jst(addDays(dates.at(-1)!, 1))),
            // 始まったレッスンは取り消さない
            gte(reservations.startsAt, now),
          ),
        )
        .orderBy(asc(reservations.startsAt));
      const affected = hit.filter((r) => dates.includes(dateOf(r.startsAt)) && !fitsIn(r, intervals));
      if (affected.length && !confirm) throw new NeedsConfirmation(await toAffected(tx, affected));
      const notices = await cancelForCause(tx, affected, 'school', actor, now);
      await audit(tx, actor, 'school_hours.set', 'school_hours', null, { dates, windows, cancelled: affected.map((r) => r.id) });
      return { affected: await toAffected(tx, affected), notices };
    });
    await sendNotices(ctx, result.notices);
    return { applied: true, affected: result.affected };
  } catch (e) {
    if (e instanceof NeedsConfirmation) return { applied: false, affected: e.affected };
    throw e;
  }
}

const hhmm = (w: { start: number; end: number }) => ({ startTime: timeFromMinutes(w.start), endTime: timeFromMinutes(w.end) });

function* monthDates(month: Month): Generator<DateStr> {
  const first = `${month}-01` as DateStr;
  for (let d = first; d.startsWith(month); d = addDays(d, 1)) yield d;
}

/** 教室の受付時間のカレンダー（管理者）。日ごとの時間帯・休講・入っている予約の件数 */
export async function schoolCalendar(ctx: Ctx, actor: Actor, month: Month) {
  assertAdmin(actor);
  const from = `${month}-01`;
  const to = `${addMonths(month, 1)}-01`;
  const [rows, closureRows, resv] = await Promise.all([
    ctx.db.select().from(schoolHours).where(and(gte(schoolHours.date, from), lt(schoolHours.date, to))),
    ctx.db.select().from(closures).where(and(gte(closures.date, from), lt(closures.date, to))),
    ctx.db
      .select({ startsAt: reservations.startsAt })
      .from(reservations)
      .where(
        and(
          inArray(reservations.status, ['pending', 'confirmed']),
          gte(reservations.startsAt, startOfMonth(month)),
          lt(reservations.startsAt, startOfMonth(addMonths(month, 1))),
        ),
      ),
  ]);
  return {
    month,
    today: dateOf(ctx.now()),
    days: [...monthDates(month)].map((d) => ({
      date: d,
      windows: schoolWindowsOf(rows, d).map(hhmm),
      closures: closureRows.filter((c) => c.date === d).map((c) => ({ startTime: c.startTime, endTime: c.endTime, reason: c.reason })),
      reservations: resv.filter((r) => dateOf(r.startsAt) === d).length,
    })),
  };
}

/**
 * 講師の空き時間のカレンダー（AV-07）。日ごとに、講師の空き時間・日ごとに決めたか・教室の受付時間を返す。
 * 講師本人と管理者が見られる（ほかの講師は見つからない扱い）
 */
export async function teacherCalendar(ctx: Ctx, actor: Actor, teacherId: string, month: Month) {
  await assertTeacherSelfOrAdmin(ctx.db, actor, teacherId);
  const from = `${month}-01`;
  const to = `${addMonths(month, 1)}-01`;
  const [rules, exceptions, school, closureRows, resv] = await Promise.all([
    ctx.db.select().from(availabilityRules).where(eq(availabilityRules.teacherId, teacherId)),
    ctx.db
      .select()
      .from(availabilityExceptions)
      .where(and(eq(availabilityExceptions.teacherId, teacherId), gte(availabilityExceptions.date, from), lt(availabilityExceptions.date, to))),
    ctx.db.select().from(schoolHours).where(and(gte(schoolHours.date, from), lt(schoolHours.date, to))),
    ctx.db.select().from(closures).where(and(gte(closures.date, from), lt(closures.date, to))),
    ctx.db
      .select({ startsAt: reservations.startsAt })
      .from(reservations)
      .where(
        and(
          eq(reservations.teacherId, teacherId),
          inArray(reservations.status, ['pending', 'confirmed']),
          gte(reservations.startsAt, startOfMonth(month)),
          lt(reservations.startsAt, startOfMonth(addMonths(month, 1))),
        ),
      ),
  ]);
  return {
    month,
    today: dateOf(ctx.now()),
    days: [...monthDates(month)].map((d) => {
      const t = teacherWindowsOf(rules, exceptions, teacherId, d);
      return {
        date: d,
        overridden: t.overridden,
        windows: t.windows.map((w) => ({ ...hhmm(w), lessonTypeId: w.lessonTypeId, roomId: w.roomId, forTrial: w.forTrial })),
        blocks: exceptions
          .filter((e) => e.date === d && e.kind === 'block')
          .map((e) => ({ startTime: e.startTime, endTime: e.endTime })),
        school: schoolWindowsOf(school, d).map(hhmm),
        closures: closureRows.filter((c) => c.date === d).map((c) => ({ startTime: c.startTime, endTime: c.endTime, reason: c.reason })),
        reservations: resv.filter((r) => dateOf(r.startsAt) === d).length,
      };
    }),
  };
}

export const teacherDayInput = z.object({
  date,
  /** null で「毎週の型に戻す」。空の配列なら、その日は空いていない */
  windows: z
    .array(
      z
        .object({
          startTime: time,
          endTime: time,
          lessonTypeId: z.string().uuid(),
          roomId: z.string().uuid().nullable().default(null),
          forTrial: z.boolean().default(false),
        })
        .refine((w) => minutesOf(w.startTime) < minutesOf(w.endTime), { message: '終了は開始より後にしてください' }),
    )
    .max(10)
    .nullable(),
});

/**
 * 講師のある日の空き時間を、その日だけ決める（AV-07）。その日は毎週の型を使わない。
 * windows=null なら、その日の設定を消して毎週の型に戻す。予約への影響は AV-02・AV-03 と同じ
 */
export async function setTeacherDay(ctx: Ctx, actor: Actor, teacherId: string, raw: unknown, confirm: boolean) {
  await assertTeacherSelfOrAdmin(ctx.db, actor, teacherId);
  const parsed = teacherDayInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? '入力に誤りがあります', parsed.error.issues);
  const { date: d, windows } = parsed.data;
  if (d < dateOf(ctx.now())) throw invalid('過ぎた日の空き時間は変えられません');
  const existing = await ctx.db
    .select({ id: availabilityExceptions.id })
    .from(availabilityExceptions)
    .where(and(eq(availabilityExceptions.teacherId, teacherId), eq(availabilityExceptions.date, d)));
  return changeAvailability(
    ctx,
    actor,
    teacherId,
    {
      removeExceptionIds: existing.map((e) => e.id),
      addExceptions:
        windows === null
          ? []
          : [{ date: d, kind: 'override' as const }, ...windows.map((w) => ({ date: d, kind: 'extra' as const, ...w }))],
    },
    confirm,
  );
}

export async function availabilityOf(db: Db, teacherId: string) {
  const [rules, exceptions] = await Promise.all([
    db.select().from(availabilityRules).where(eq(availabilityRules.teacherId, teacherId)),
    db
      .select()
      .from(availabilityExceptions)
      .where(and(eq(availabilityExceptions.teacherId, teacherId), gte(availabilityExceptions.date, dateOf(new Date()))))
      .orderBy(asc(availabilityExceptions.date)),
  ]);
  return { rules, exceptions };
}

export const closureInput = z
  .object({
    date,
    startTime: time.nullable().default(null),
    endTime: time.nullable().default(null),
    reason: z.string().max(200).default(''),
  })
  .refine((c) => (c.startTime === null) === (c.endTime === null), { message: '開始と終了の両方を入力してください' });

/** 休講日・臨時休講（AV-04）。既存の予約は「教室都合のキャンセル」として取り消し、回数を戻す */
export async function createClosure(ctx: Ctx, actor: Actor, raw: unknown) {
  assertAdmin(actor);
  const parsed = closureInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? '入力に誤りがあります');
  const c = parsed.data;
  const now = ctx.now();
  if (c.date < dateOf(now)) throw invalid('過ぎた日は休講にできません');
  const from = jst(c.date, c.startTime ?? '00:00');
  const to = c.endTime ? jst(c.date, c.endTime) : new Date(jst(c.date).getTime() + 24 * 3600 * 1000);
  if (to <= now) throw invalid('過ぎた時間は休講にできません');
  const result = await ctx.db.transaction(async (tx) => {
    const [row] = await tx.insert(closures).values({ ...c, createdBy: actor.kind === 'account' ? actor.accountId : null }).returning();
    const hit = await tx
      .select()
      .from(reservations)
      .where(
        and(
          inArray(reservations.status, ['pending', 'confirmed']),
          lt(reservations.startsAt, to),
          gte(reservations.endsAt, from),
          // 始まったレッスンは取り消さない（受講済みの回数を戻さない）
          gte(reservations.startsAt, now),
        ),
      );
    const overlapping = hit.filter((r) => r.startsAt < to && from < r.endsAt);
    const notices = await cancelForCause(tx, overlapping, 'school', actor, now);
    await audit(tx, actor, 'closure.create', 'closure', row!.id, { ...c, cancelled: overlapping.map((r) => r.id) });
    return { closure: row!, cancelled: overlapping.length, notices };
  });
  await sendNotices(ctx, result.notices);
  return { closure: result.closure, cancelled: result.cancelled };
}

export async function deleteClosure(ctx: Ctx, actor: Actor, closureId: string): Promise<void> {
  assertAdmin(actor);
  await ctx.db.transaction(async (tx) => {
    await tx.delete(closures).where(eq(closures.id, closureId));
    await audit(tx, actor, 'closure.delete', 'closure', closureId);
  });
}

/** 講師別の、その月のレッスン数と講師都合キャンセルの件数（AV-05、DB-04） */
export async function teacherMonthStats(db: Db, month: Month) {
  const from = startOfMonth(month);
  const to = startOfMonth(addMonths(month, 1));
  const ts = await db.select({ id: teachers.id, name: teachers.name }).from(teachers).orderBy(asc(teachers.name));
  const lessons = await db
    .select({ teacherId: reservations.teacherId, n: count() })
    .from(reservations)
    .where(and(inArray(reservations.status, ['pending', 'confirmed']), gte(reservations.startsAt, from), lt(reservations.startsAt, to)))
    .groupBy(reservations.teacherId);
  const cancels = await db
    .select({ teacherId: reservations.teacherId, n: count() })
    .from(reservations)
    .where(and(eq(reservations.cancelKind, 'teacher'), gte(reservations.startsAt, from), lt(reservations.startsAt, to)))
    .groupBy(reservations.teacherId);
  const lmap = new Map(lessons.map((l) => [l.teacherId, l.n]));
  const cmap = new Map(cancels.map((c) => [c.teacherId, c.n]));
  return ts.map((t) => ({ teacherId: t.id, name: t.name, lessons: lmap.get(t.id) ?? 0, teacherCancels: cmap.get(t.id) ?? 0 }));
}

