import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { courses, creditLedger, students } from '../db/schema.js';
import { actorId, type Actor, type Ctx } from './context.js';
import { audit } from './audit.js';
import { addMonths, monthOf, type Month } from '../lib/time.js';
import { getSettings } from './settings.js';
import { invalid } from './errors.js';

// 回数の数え方（3.4）
// - 回数は「レッスン日が属する月」の回数から使う
// - 残り回数は credit_ledger のその月の合計（OP-04: 増減はすべて履歴に残る）
// - 翌月分は、自動課金が有効な生徒に限り、月額コースの回数を上限に先に予約できる

type Student = typeof students.$inferSelect;
type LedgerReason = (typeof creditLedger.$inferInsert)['reason'];

export async function balance(db: Db, studentId: string, month: Month): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${creditLedger.delta}), 0)::int` })
    .from(creditLedger)
    .where(and(eq(creditLedger.studentId, studentId), eq(creditLedger.month, month)));
  return row?.total ?? 0;
}

/** 自動課金（カード等で毎月1日に課金）が有効か */
export function hasAutopay(student: Student): boolean {
  return student.billingMethod === 'card' && student.stripeSubscriptionId != null;
}

async function hasMonthlyGrant(db: Db, studentId: string, month: Month): Promise<boolean> {
  const rows = await db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.studentId, studentId),
        eq(creditLedger.month, month),
        inArray(creditLedger.reason, ['grant_monthly']),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * その月にあと何回予約できるか。
 * 翌月分で、まだ月額の付与がなく自動課金が有効なら、コースの回数を先に使える（3.4）。
 */
export async function availableCredits(db: Db, student: Student, month: Month, now: Date): Promise<number> {
  const bal = await balance(db, student.id, month);
  if (month !== addMonths(monthOf(now), 1)) return bal;
  if (!hasAutopay(student) || !student.courseId) return bal;
  if (await hasMonthlyGrant(db, student.id, month)) return bal;
  const [course] = await db.select().from(courses).where(eq(courses.id, student.courseId));
  return bal + (course?.lessonsPerMonth ?? 0);
}

export async function addLedger(
  db: Db,
  entry: {
    studentId: string;
    month: Month;
    delta: number;
    reason: LedgerReason;
    reservationId?: string | null;
    paymentId?: string | null;
    actor: Actor;
    note?: string;
  },
): Promise<void> {
  await db.insert(creditLedger).values({
    studentId: entry.studentId,
    month: entry.month,
    delta: entry.delta,
    reason: entry.reason,
    reservationId: entry.reservationId ?? null,
    paymentId: entry.paymentId ?? null,
    actorAccountId: actorId(entry.actor),
    note: entry.note ?? '',
  });
}

/** 管理者の手動調整（OP-03、OP-04）。理由を必ず残す */
export async function adjustCredits(
  ctx: Ctx,
  actor: Actor,
  input: { studentId: string; month: Month; delta: number; note: string },
): Promise<number> {
  if (!Number.isInteger(input.delta) || input.delta === 0) throw invalid('増減する回数を入力してください');
  if (!input.note.trim()) throw invalid('調整の理由を入力してください');
  return ctx.db.transaction(async (tx) => {
    await addLedger(tx, { ...input, reason: 'adjust', actor });
    await audit(tx, actor, 'credits.adjust', 'student', input.studentId, input);
    return balance(tx, input.studentId, input.month);
  });
}

/** 生徒ごとの回数の履歴（OP-04「なぜ今この回数なのか」） */
export async function ledgerOf(db: Db, studentId: string) {
  return db
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.studentId, studentId))
    .orderBy(creditLedger.createdAt);
}

/**
 * 月が変わったときの失効と繰越（PY-07）。month は終わった月。
 * 余った回数は月末で失効し、繰越が有効なら上限までを翌月に移す。何度呼んでも結果は同じ。
 */
export async function closeMonth(ctx: Ctx, month: Month): Promise<void> {
  const settings = await getSettings(ctx.db);
  const next = addMonths(month, 1);
  const rows = await ctx.db
    .select({ studentId: creditLedger.studentId, total: sql<number>`sum(${creditLedger.delta})::int` })
    .from(creditLedger)
    .where(eq(creditLedger.month, month))
    .groupBy(creditLedger.studentId);
  // すでにこの月から繰り越した回数。締めたあとの返金などで再び締めても、上限を超えて繰り越さない
  const carried = await ctx.db
    .select({ studentId: creditLedger.studentId, total: sql<number>`sum(${creditLedger.delta})::int` })
    .from(creditLedger)
    .where(and(eq(creditLedger.month, next), eq(creditLedger.reason, 'carryover')))
    .groupBy(creditLedger.studentId);
  const carriedOf = new Map(carried.map((c) => [c.studentId, c.total]));
  for (const r of rows) {
    if (r.total <= 0) continue;
    const room = Math.max(0, settings.carryoverMax - (carriedOf.get(r.studentId) ?? 0));
    const carry = settings.carryoverEnabled ? Math.min(r.total, room) : 0;
    await ctx.db.transaction(async (tx) => {
      await addLedger(tx, {
        studentId: r.studentId,
        month,
        delta: -r.total,
        reason: 'expire',
        actor: { kind: 'system' },
        note: `${month}末で失効`,
      });
      if (carry > 0) {
        await addLedger(tx, {
          studentId: r.studentId,
          month: next,
          delta: carry,
          reason: 'carryover',
          actor: { kind: 'system' },
          note: `${month}から繰越`,
        });
      }
    });
  }
}
