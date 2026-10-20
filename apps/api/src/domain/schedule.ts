import { and, asc, count, eq, gte, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  availabilityExceptions,
  availabilityRules,
  closures,
  lessonTypes,
  reservations,
  students,
  teachers,
} from '../db/schema.js';
import { addMonths, dateOf, jst, minutesOf, startOfMonth, type Month } from '../lib/time.js';
import { assertAdmin, assertTeacherSelfOrAdmin } from './access.js';
import { audit } from './audit.js';
import { isCoveredByAvailability } from './availability.js';
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
    kind: z.enum(['block', 'extra']),
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
  .refine((e) => e.kind === 'block' || (e.startTime && e.lessonTypeId), {
    message: '追加の空き時間には時刻とレッスン種別が必要です',
  });

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
  const out: Reservation[] = [];
  for (const r of future) {
    if (!(await isCoveredByAvailability(db, r, dateOf(r.startsAt)))) out.push(r);
  }
  return out;
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
export async function createClosure(ctx: Ctx, actor: Actor, raw: z.input<typeof closureInput>) {
  assertAdmin(actor);
  const parsed = closureInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? '入力に誤りがあります');
  const c = parsed.data;
  const from = jst(c.date, c.startTime ?? '00:00');
  const to = c.endTime ? jst(c.date, c.endTime) : new Date(jst(c.date).getTime() + 24 * 3600 * 1000);
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
        ),
      );
    const overlapping = hit.filter((r) => r.startsAt < to && from < r.endsAt);
    const notices = await cancelForCause(tx, overlapping, 'school', actor, ctx.now());
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

