import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  creditLedger,
  lessonTypes,
  payments,
  reservations,
  reservationSeries,
  rooms,
  students,
  teachers,
} from '../db/schema.js';
import { addDays, dateOf, DAY_MS, HOUR_MS, jst, monthOf, startOfMonth, weekdayOf, type DateStr, type Month } from '../lib/time.js';
import {
  adminRecipients,
  assertAdmin,
  isAssigned,
  loadStudent,
  recipientOfStudent,
  studentForActor,
  type Student,
} from './access.js';
import { audit } from './audit.js';
import { actorId, type Actor, type Ctx } from './context.js';
import { addLedger, availableCredits } from './credits.js';
import { conflict, forbidden, notFound, ruleViolation } from './errors.js';
import { listSlots, type Slot } from './availability.js';
import { CANCEL_REASON_LABEL, messages } from './messages.js';
import { getSettings, type Settings } from './settings.js';
import type { Recipient, Message } from './notify.js';
import type { NotificationType } from './settings.js';

// 予約・変更・キャンセルのルール（3.4）。予約できるかどうかの判定はこのファイルにだけ置く（2章の6）。

export type Reservation = typeof reservations.$inferSelect;
type CancelKind = NonNullable<Reservation['cancelKind']>;

/** 処理が確定してから送る通知 */
type Notice = { type: NotificationType; to: Recipient; message: Message };

async function flush(ctx: Ctx, notices: Notice[]): Promise<void> {
  for (const n of notices) await ctx.notifier.send(n.type, n.to, n.message);
}

const monthLabel = (m: Month) => `${Number(m.slice(5))}月`;

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

/** 未払いのまま猶予期間（PY-10）を過ぎた月額の請求があるか */
export async function hasUnpaidPastGrace(db: Db, studentId: string, now: Date, graceDays: number): Promise<boolean> {
  const rows = await db
    .select({ month: payments.month })
    .from(payments)
    .where(
      and(
        eq(payments.studentId, studentId),
        eq(payments.kind, 'monthly'),
        inArray(payments.status, ['pending', 'failed']),
      ),
    );
  return rows.some((r) => r.month && startOfMonth(r.month).getTime() + graceDays * DAY_MS < now.getTime());
}

/**
 * 日時によらない、生徒が今予約できない理由（RS-02）。予約できるなら null。
 * 画面では予約ボタンを押せなくし、この理由を表示する。
 */
export async function studentBlocker(db: Db, student: Student, now: Date, settings: Settings): Promise<string | null> {
  if (!student.approved) return '教室の承認待ちのため、まだ予約できません';
  switch (student.status) {
    case 'suspended':
      return '休会中のため予約できません';
    case 'withdrawn':
      return '退会済みのため予約できません';
    case 'trial':
    case 'enrolling':
      return '入会手続きが終わると予約できます';
    case 'active':
      break;
  }
  if (await hasUnpaidPastGrace(db, student.id, now, settings.graceDays)) {
    return 'お支払いが確認できていないため予約できません。教室にご連絡ください';
  }
  return null;
}

/** 生徒が startsAt の枠を予約できない理由。予約できるなら null */
export async function studentBookingBlocker(
  db: Db,
  student: Student,
  startsAt: Date,
  now: Date,
  settings: Settings,
): Promise<string | null> {
  const blocker = await studentBlocker(db, student, now, settings);
  if (blocker) return blocker;
  if (
    student.scheduledStatus &&
    student.scheduledStatusAt &&
    (student.scheduledStatus === 'suspended' || student.scheduledStatus === 'withdrawn') &&
    startsAt >= student.scheduledStatusAt
  ) {
    const label = student.scheduledStatus === 'suspended' ? '休会' : '退会';
    return `${monthLabel(monthOf(student.scheduledStatusAt))}から${label}のため、この日は予約できません`;
  }
  if (startsAt.getTime() - now.getTime() < settings.reserveDeadlineHours * HOUR_MS) {
    return `予約の締切（レッスンの${settings.reserveDeadlineHours}時間前）を過ぎています`;
  }
  if (startsAt.getTime() > now.getTime() + settings.publishWeeks * 7 * DAY_MS) {
    return 'まだ予約を受け付けていない日です';
  }
  const month = monthOf(startsAt);
  if ((await availableCredits(db, student, month, now)) <= 0) {
    return month === monthOf(now) ? '今月の回数を使い切りました' : `${monthLabel(month)}の回数を使い切りました`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 内部の処理（トランザクションの中で呼ぶ）
// ---------------------------------------------------------------------------

/** 同じ講師（と部屋）への同時の予約を順番に処理する */
async function lockTeacher(db: Db, teacherId: string, roomId: string | null): Promise<void> {
  await db.select({ id: teachers.id }).from(teachers).where(eq(teachers.id, teacherId)).for('update');
  if (roomId) await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId)).for('update');
}

async function findOpenSlot(
  db: Db,
  input: { teacherId: string; lessonTypeId: string; startsAt: Date },
): Promise<Slot | null> {
  const date = dateOf(input.startsAt);
  const slots = await listSlots(db, { teacherIds: [input.teacherId], from: date, to: date, forTrial: false });
  return (
    slots.find(
      (s) =>
        s.lessonTypeId === input.lessonTypeId &&
        s.startsAt.getTime() === input.startsAt.getTime() &&
        s.booked < s.capacity,
    ) ?? null
  );
}

async function insertReservation(
  db: Db,
  student: Student,
  slot: Slot,
  status: 'pending' | 'confirmed',
  actor: Actor,
  seriesId: string | null = null,
): Promise<Reservation> {
  const [r] = await db
    .insert(reservations)
    .values({
      studentId: student.id,
      teacherId: slot.teacherId,
      lessonTypeId: slot.lessonTypeId,
      roomId: slot.roomId,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      lessonMonth: monthOf(slot.startsAt),
      status,
      seriesId,
      createdBy: actorId(actor),
    })
    .returning();
  // 予約すると、レッスン日の月の回数を1つ使う（RS-01）
  await addLedger(db, {
    studentId: student.id,
    month: r!.lessonMonth,
    delta: -1,
    reason: 'consume',
    reservationId: r!.id,
    actor,
  });
  return r!;
}

async function describe(db: Db, r: Reservation) {
  const [t] = await db.select({ name: teachers.name }).from(teachers).where(eq(teachers.id, r.teacherId));
  const s = r.studentId ? await loadStudent(db, r.studentId) : null;
  return { studentName: s?.name ?? '体験', teacherName: t?.name ?? '', startsAt: r.startsAt, student: s };
}

/** 予約を取り消す。refund なら使った回数を戻す（RS-04、PY-08） */
async function cancelInTx(
  db: Db,
  r: Reservation,
  kind: CancelKind,
  refund: boolean,
  actor: Actor,
  now: Date,
): Promise<{ refunded: boolean }> {
  const updated = await db
    .update(reservations)
    .set({ status: 'cancelled', cancelKind: kind, cancelledAt: now, cancelledBy: actorId(actor) })
    .where(and(eq(reservations.id, r.id), inArray(reservations.status, ['pending', 'confirmed'])))
    .returning({ id: reservations.id });
  if (updated.length === 0) throw conflict('この予約はすでに取り消されています');
  if (!refund || !r.studentId) return { refunded: false };
  const consumed = await db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.reservationId, r.id), eq(creditLedger.reason, 'consume')));
  if (consumed.length === 0) return { refunded: false };
  await addLedger(db, {
    studentId: r.studentId,
    month: r.lessonMonth,
    delta: 1,
    reason: 'refund',
    reservationId: r.id,
    actor,
    note: CANCEL_REASON_LABEL[kind] ?? kind,
  });
  return { refunded: true };
}

async function cancelNotices(db: Db, r: Reservation, kind: CancelKind, refunded: boolean, toAdmins: boolean): Promise<Notice[]> {
  const d = await describe(db, r);
  const notices: Notice[] = [];
  const message = messages.reservationCancelled(d, CANCEL_REASON_LABEL[kind] ?? kind, refunded);
  if (d.student) notices.push({ type: 'reservation_cancelled', to: await recipientOfStudent(db, d.student), message });
  if (toAdmins) {
    for (const to of await adminRecipients(db)) notices.push({ type: 'reservation_cancelled', to, message });
  }
  return notices;
}

/** 講師都合・教室都合などで、まとめて取り消す（AV-03、AV-04）。回数は戻す */
export async function cancelForCause(
  db: Db,
  list: Reservation[],
  kind: 'teacher' | 'school' | 'unpaid',
  actor: Actor,
  now: Date,
): Promise<Notice[]> {
  const notices: Notice[] = [];
  for (const r of list) {
    const { refunded } = await cancelInTx(db, r, kind, true, actor, now);
    notices.push(...(await cancelNotices(db, r, kind, refunded, kind !== 'unpaid')));
  }
  return notices;
}

export { flush as sendNotices };

// ---------------------------------------------------------------------------
// 生徒の操作
// ---------------------------------------------------------------------------

export interface BookInput {
  studentId: string;
  teacherId: string;
  lessonTypeId: string;
  startsAt: Date;
}

async function bookStudentInTx(db: Db, ctx: Ctx, student: Student, input: BookInput, actor: Actor): Promise<Reservation> {
  const settings = await getSettings(db);
  const now = ctx.now();
  const reason = await studentBookingBlocker(db, student, input.startsAt, now, settings);
  if (reason) throw ruleViolation(reason);
  const slot = await findOpenSlot(db, input);
  if (!slot) throw ruleViolation('この枠は予約できません。ほかの時間を選んでください');
  await lockTeacher(db, slot.teacherId, slot.roomId);
  // ロックを取ってから、もう一度空きを確かめる
  const again = await findOpenSlot(db, input);
  if (!again) throw ruleViolation('この枠は先に予約されました。ほかの時間を選んでください');
  // 承認制のときは仮予約（RS-06）
  return insertReservation(db, student, again, settings.approvalRequired ? 'pending' : 'confirmed', actor);
}

/** 生徒（保護者）が担当講師の枠を予約する（RS-01） */
export async function bookAsStudent(ctx: Ctx, actor: Actor, input: BookInput): Promise<Reservation> {
  const student = await studentForActor(ctx.db, actor, input.studentId);
  // 担当外の講師はサーバー側で拒否する（TC-03）。担当を外した講師も同じ（TC-04）
  if (!(await isAssigned(ctx.db, student.id, input.teacherId))) throw forbidden('この講師の枠は予約できません');
  const r = await ctx.db.transaction((tx) => bookStudentInTx(tx, ctx, student, input, actor));
  const d = await describe(ctx.db, r);
  await flush(ctx, [
    {
      type: 'reservation_confirmed',
      to: await recipientOfStudent(ctx.db, student),
      message: messages.reservationConfirmed(d, r.status === 'pending'),
    },
  ]);
  return r;
}

export async function loadReservation(db: Db, id: string): Promise<Reservation> {
  const [r] = await db.select().from(reservations).where(eq(reservations.id, id));
  if (!r) throw notFound('予約が見つかりません');
  return r;
}

/** 生徒の予約を、本人（保護者）・管理者だけが読み込める。他人の予約は存在しない扱い */
async function reservationForStudentActor(db: Db, actor: Actor, id: string): Promise<Reservation> {
  const r = await loadReservation(db, id);
  if (!r.studentId) throw notFound('予約が見つかりません');
  await studentForActor(db, actor, r.studentId).catch(() => {
    throw notFound('予約が見つかりません');
  });
  if (actor.kind === 'account' && actor.role === 'teacher') throw notFound('予約が見つかりません');
  return r;
}

/** キャンセルの確認画面（UI-15）に出す内容。締切後なら回数が戻らないことを伝える */
export async function cancelPreview(ctx: Ctx, actor: Actor, reservationId: string) {
  const r = await reservationForStudentActor(ctx.db, actor, reservationId);
  const settings = await getSettings(ctx.db);
  const deadline = new Date(r.startsAt.getTime() - settings.cancelDeadlineHours * HOUR_MS);
  const late = ctx.now() > deadline;
  return { reservationId: r.id, startsAt: r.startsAt, deadline, refund: !late };
}

/** 生徒のキャンセル。締切前なら回数を戻し（RS-04）、締切後は戻さない（RS-05） */
export async function cancelAsStudent(ctx: Ctx, actor: Actor, reservationId: string): Promise<{ refunded: boolean }> {
  const r = await reservationForStudentActor(ctx.db, actor, reservationId);
  const now = ctx.now();
  if (r.status === 'cancelled') throw conflict('この予約はすでに取り消されています');
  if (r.startsAt <= now) throw ruleViolation('開始時刻を過ぎた予約は取り消せません。教室にご連絡ください');
  const settings = await getSettings(ctx.db);
  const late = now.getTime() > r.startsAt.getTime() - settings.cancelDeadlineHours * HOUR_MS;
  const kind: CancelKind = late ? 'student_late' : 'student';
  const result = await ctx.db.transaction((tx) => cancelInTx(tx, r, kind, !late, actor, now));
  await flush(ctx, await cancelNotices(ctx.db, r, kind, result.refunded, false));
  return result;
}

/** 生徒の日時変更。変更の締切より前だけ受け付け、回数は新しい予約へ移す（RS-04） */
export async function changeAsStudent(
  ctx: Ctx,
  actor: Actor,
  reservationId: string,
  next: { teacherId: string; lessonTypeId: string; startsAt: Date },
): Promise<Reservation> {
  const r = await reservationForStudentActor(ctx.db, actor, reservationId);
  const now = ctx.now();
  if (r.status === 'cancelled') throw conflict('この予約はすでに取り消されています');
  const settings = await getSettings(ctx.db);
  if (now.getTime() > r.startsAt.getTime() - settings.changeDeadlineHours * HOUR_MS) {
    throw ruleViolation(`変更の締切（レッスンの${settings.changeDeadlineHours}時間前）を過ぎています`);
  }
  const student = await loadStudent(ctx.db, r.studentId!);
  if (!(await isAssigned(ctx.db, student.id, next.teacherId))) throw forbidden('この講師の枠は予約できません');
  const created = await ctx.db.transaction(async (tx) => {
    await cancelInTx(tx, r, 'rescheduled', true, actor, now);
    return bookStudentInTx(tx, ctx, student, { studentId: student.id, ...next }, actor);
  });
  const d = await describe(ctx.db, created);
  await flush(ctx, [
    { type: 'reservation_changed', to: await recipientOfStudent(ctx.db, student), message: messages.reservationChanged(d, r.startsAt) },
  ]);
  return created;
}

/** 生徒の画面に出す、担当講師の予約できる枠（TC-02、RS-03） */
export async function slotsForStudent(
  ctx: Ctx,
  actor: Actor,
  studentId: string,
  teacherId: string,
  from: DateStr,
  to: DateStr,
): Promise<Slot[]> {
  const student = await studentForActor(ctx.db, actor, studentId);
  if (!(await isAssigned(ctx.db, student.id, teacherId))) throw forbidden('この講師の枠は表示できません');
  const settings = await getSettings(ctx.db);
  const now = ctx.now();
  const earliest = new Date(now.getTime() + settings.reserveDeadlineHours * HOUR_MS);
  const latest = new Date(now.getTime() + settings.publishWeeks * 7 * DAY_MS);
  const start = from < dateOf(now) ? dateOf(now) : from;
  const end = to > dateOf(latest) ? dateOf(latest) : to;
  if (start > end) return [];
  const slots = await listSlots(ctx.db, { teacherIds: [teacherId], from: start, to: end, forTrial: false });
  return slots.filter((s) => s.booked < s.capacity && s.startsAt >= earliest && s.startsAt <= latest);
}

/** 生徒の予約一覧（レッスン記録は含めない: SR-05） */
export async function reservationsOfStudent(ctx: Ctx, actor: Actor, studentId: string, opts: { from?: Date } = {}) {
  const student = await studentForActor(ctx.db, actor, studentId);
  const conds = [eq(reservations.studentId, student.id)];
  if (opts.from) conds.push(gte(reservations.endsAt, opts.from));
  return ctx.db
    .select({
      id: reservations.id,
      teacherId: reservations.teacherId,
      teacherName: teachers.name,
      lessonTypeName: lessonTypes.name,
      startsAt: reservations.startsAt,
      endsAt: reservations.endsAt,
      status: reservations.status,
      cancelKind: reservations.cancelKind,
      attendance: reservations.attendance,
    })
    .from(reservations)
    .innerJoin(teachers, eq(teachers.id, reservations.teacherId))
    .innerJoin(lessonTypes, eq(lessonTypes.id, reservations.lessonTypeId))
    .where(and(...conds))
    .orderBy(asc(reservations.startsAt));
}

// ---------------------------------------------------------------------------
// 管理者の操作
// ---------------------------------------------------------------------------

async function shortageWarning(db: Db, student: Student, month: Month, now: Date): Promise<string | null> {
  const available = await availableCredits(db, student, month, now);
  return available < 0 ? `${monthLabel(month)}の回数が${-available}回足りません` : null;
}

/**
 * 管理者の代理予約。公開期間より先や締切後でも入れられる（RS-07）。
 * 回数が足りなくても予約し、警告を返す。
 */
export async function bookAsAdmin(
  ctx: Ctx,
  actor: Actor,
  input: BookInput,
): Promise<{ reservation: Reservation; warning: string | null }> {
  assertAdmin(actor);
  const student = await loadStudent(ctx.db, input.studentId);
  if (student.status === 'withdrawn') throw ruleViolation('退会した生徒は予約できません');
  if (!(await isAssigned(ctx.db, student.id, input.teacherId))) {
    throw ruleViolation('担当講師ではありません。先に担当講師に設定してください');
  }
  const reservation = await ctx.db.transaction(async (tx) => {
    const slot = await findOpenSlot(tx, input);
    if (!slot) throw ruleViolation('この枠は予約できません（空き時間外か、埋まっています）');
    await lockTeacher(tx, slot.teacherId, slot.roomId);
    const again = await findOpenSlot(tx, input);
    if (!again) throw ruleViolation('この枠は先に予約されました');
    const r = await insertReservation(tx, student, again, 'confirmed', actor);
    await audit(tx, actor, 'reservation.create', 'reservation', r.id, { studentId: student.id, startsAt: r.startsAt });
    return r;
  });
  const d = await describe(ctx.db, reservation);
  await flush(ctx, [
    { type: 'reservation_confirmed', to: await recipientOfStudent(ctx.db, student), message: messages.reservationConfirmed(d, false) },
  ]);
  return { reservation, warning: await shortageWarning(ctx.db, student, reservation.lessonMonth, ctx.now()) };
}

/** 管理者の取消。refund=false は「締切後の連絡」として回数を戻さない */
export async function cancelAsAdmin(
  ctx: Ctx,
  actor: Actor,
  reservationId: string,
  opts: { refund: boolean },
): Promise<{ refunded: boolean }> {
  assertAdmin(actor);
  const r = await loadReservation(ctx.db, reservationId);
  const kind: CancelKind = opts.refund ? 'admin' : 'student_late';
  const result = await ctx.db.transaction(async (tx) => {
    const res = await cancelInTx(tx, r, kind, opts.refund, actor, ctx.now());
    await audit(tx, actor, 'reservation.cancel', 'reservation', r.id, { refund: opts.refund });
    return res;
  });
  await flush(ctx, await cancelNotices(ctx.db, r, kind, result.refunded, false));
  return result;
}

/** 承認制の仮予約を承認・却下する（RS-06）。却下すると回数を戻す */
export async function decidePending(ctx: Ctx, actor: Actor, reservationId: string, approve: boolean): Promise<void> {
  assertAdmin(actor);
  const r = await loadReservation(ctx.db, reservationId);
  if (r.status !== 'pending') throw conflict('仮予約ではありません');
  if (approve) {
    await ctx.db.transaction(async (tx) => {
      await tx.update(reservations).set({ status: 'confirmed' }).where(eq(reservations.id, r.id));
      await audit(tx, actor, 'reservation.approve', 'reservation', r.id);
    });
    const d = await describe(ctx.db, r);
    if (d.student) {
      await flush(ctx, [
        { type: 'reservation_confirmed', to: await recipientOfStudent(ctx.db, d.student), message: messages.reservationApproved(d) },
      ]);
    }
    return;
  }
  const result = await ctx.db.transaction(async (tx) => {
    const res = await cancelInTx(tx, r, 'rejected', true, actor, ctx.now());
    await audit(tx, actor, 'reservation.reject', 'reservation', r.id);
    return res;
  });
  await flush(ctx, await cancelNotices(ctx.db, r, 'rejected', result.refunded, false));
}

/** 出欠を付ける。無断欠席でも予約時に使った回数は戻らない（RS-05） */
export async function markAttendance(
  ctx: Ctx,
  actor: Actor,
  reservationId: string,
  attendance: 'attended' | 'no_show' | 'scheduled',
): Promise<void> {
  assertAdmin(actor);
  const r = await loadReservation(ctx.db, reservationId);
  if (r.status === 'cancelled') throw conflict('取り消された予約です');
  await ctx.db.transaction(async (tx) => {
    await tx.update(reservations).set({ attendance }).where(eq(reservations.id, r.id));
    await audit(tx, actor, 'reservation.attendance', 'reservation', r.id, { attendance });
  });
}

export interface SeriesInput {
  studentId: string;
  teacherId: string;
  lessonTypeId: string;
  weekday: number;
  startTime: string;
  startDate: DateStr;
  endDate: DateStr;
}

/**
 * 毎週の繰り返し予約（RS-07）。各回は通常の予約として作り、各月の回数から使う。
 * 予約できなかった日と、回数が足りない月を返す（管理画面で警告する）。
 */
export async function createSeries(ctx: Ctx, actor: Actor, input: SeriesInput) {
  assertAdmin(actor);
  const student = await loadStudent(ctx.db, input.studentId);
  if (!(await isAssigned(ctx.db, student.id, input.teacherId))) {
    throw ruleViolation('担当講師ではありません。先に担当講師に設定してください');
  }
  const [series] = await ctx.db
    .insert(reservationSeries)
    .values({ ...input, roomId: null, createdBy: actorId(actor) })
    .returning();
  const created: Reservation[] = [];
  const skipped: { date: DateStr; reason: string }[] = [];
  for (let d = input.startDate; d <= input.endDate; d = addDays(d, 1)) {
    if (weekdayOf(d) !== input.weekday) continue;
    const startsAt = jst(d, input.startTime);
    try {
      const r = await ctx.db.transaction(async (tx) => {
        const slot = await findOpenSlot(tx, { ...input, startsAt });
        if (!slot) throw ruleViolation('空き時間外か、埋まっています');
        await lockTeacher(tx, slot.teacherId, slot.roomId);
        return insertReservation(tx, student, slot, 'confirmed', actor, series!.id);
      });
      created.push(r);
    } catch (e) {
      skipped.push({ date: d, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  await audit(ctx.db, actor, 'reservation.series.create', 'reservation_series', series!.id, {
    ...input,
    created: created.length,
    skipped,
  });
  const months = [...new Set(created.map((r) => r.lessonMonth))];
  const warnings: string[] = [];
  for (const m of months) {
    const w = await shortageWarning(ctx.db, student, m, ctx.now());
    if (w) warnings.push(w);
  }
  return { seriesId: series!.id, created, skipped, warnings };
}

/** 回数が足りない月の一覧（管理画面の警告。RS-07） */
export async function creditShortages(db: Db, now: Date) {
  const cur = monthOf(now);
  const rows = await db
    .select({ studentId: creditLedger.studentId, month: creditLedger.month, total: sql<number>`sum(${creditLedger.delta})::int` })
    .from(creditLedger)
    .where(gte(creditLedger.month, cur))
    .groupBy(creditLedger.studentId, creditLedger.month);
  const out: { studentId: string; studentName: string; month: Month; shortBy: number }[] = [];
  for (const r of rows) {
    const [s] = await db.select().from(students).where(eq(students.id, r.studentId));
    if (!s) continue;
    const available = await availableCredits(db, s, r.month, now);
    if (available < 0) out.push({ studentId: s.id, studentName: s.name, month: r.month, shortBy: -available });
  }
  return out;
}


/** 今後の有効な予約（講師・期間で絞る） */
export async function activeReservationsBetween(db: Db, opts: { teacherId?: string; from: Date; to?: Date }) {
  const conds = [inArray(reservations.status, ['pending', 'confirmed'] as const), gte(reservations.startsAt, opts.from)];
  if (opts.teacherId) conds.push(eq(reservations.teacherId, opts.teacherId));
  if (opts.to) conds.push(lt(reservations.startsAt, opts.to));
  return db.select().from(reservations).where(and(...conds)).orderBy(asc(reservations.startsAt));
}
