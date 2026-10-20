import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import { courses, lessonTypes, payments, reservations, students, teachers } from '../db/schema.js';
import { addMonths, monthOf } from '../lib/time.js';
import { studentForActor } from './access.js';
import { studentBlocker } from './booking.js';
import type { Actor, Ctx } from './context.js';
import { needsCard, unpaidCardMonth, unpaidLinkMonth } from './billing.js';
import { availableCredits, hasAutopay } from './credits.js';
import { getSettings } from './settings.js';

// 生徒のトップ（MB-01）: 今月の残り回数、次の予約、お支払い状況を1画面で

/** 保護者アカウントの子ども一覧（ST-04 の切り替え用） */
export async function myStudents(ctx: Ctx, actor: Actor) {
  if (actor.kind !== 'account') return [];
  return ctx.db
    .select({ id: students.id, name: students.name, status: students.status })
    .from(students)
    .where(eq(students.accountId, actor.accountId))
    .orderBy(asc(students.createdAt));
}

export type PaymentState = 'paid' | 'confirming' | 'unpaid' | 'failed' | 'none';

export async function studentHome(ctx: Ctx, actor: Actor, studentId: string) {
  const s = await studentForActor(ctx.db, actor, studentId);
  const now = ctx.now();
  const month = monthOf(now);
  const settings = await getSettings(ctx.db);
  const [next] = await ctx.db
    .select({
      id: reservations.id,
      startsAt: reservations.startsAt,
      endsAt: reservations.endsAt,
      status: reservations.status,
      teacherName: teachers.name,
      lessonTypeName: lessonTypes.name,
    })
    .from(reservations)
    .innerJoin(teachers, eq(teachers.id, reservations.teacherId))
    .innerJoin(lessonTypes, eq(lessonTypes.id, reservations.lessonTypeId))
    .where(
      and(
        eq(reservations.studentId, s.id),
        inArray(reservations.status, ['pending', 'confirmed']),
        gte(reservations.endsAt, now),
      ),
    )
    .orderBy(asc(reservations.startsAt))
    .limit(1);

  const paymentRows = await ctx.db
    .select()
    .from(payments)
    .where(and(eq(payments.studentId, s.id), inArray(payments.status, ['pending', 'failed', 'succeeded'])));
  const monthly = paymentRows.find((p) => p.kind === 'monthly' && p.month === month);
  const enrollment = paymentRows.find((p) => p.kind === 'enrollment');
  // 決済画面から戻っても、入金確定の通知が届くまでは「確認中」（PY-05）
  let payment: PaymentState = 'none';
  const target = monthly ?? (s.status === 'enrolling' ? enrollment : undefined);
  const cardDue = await unpaidCardMonth(ctx, s);
  const linkDue = await unpaidLinkMonth(ctx, s);
  if (target) {
    payment =
      target.status === 'succeeded'
        ? 'paid'
        : target.status === 'failed'
          ? 'failed'
          : target.kind === 'enrollment'
            ? target.stripeCheckoutSessionId
              ? 'confirming'
              : 'unpaid'
            : // 月謝: 自動課金が払う月は通知を待つ。自分で払う月（コンビニ・PayPay、自動課金の対象外のカード払い）は未払い
              target.method === 'card' && !cardDue
              ? 'confirming'
              : 'unpaid';
  }
  const [course] = s.courseId ? await ctx.db.select().from(courses).where(eq(courses.id, s.courseId)) : [];

  return {
    student: { id: s.id, name: s.name, status: s.status, scheduledStatus: s.scheduledStatus, scheduledStatusAt: s.scheduledStatusAt },
    month,
    remaining: Math.max(0, await availableCredits(ctx.db, s, month, now)),
    nextMonth: { month: addMonths(month, 1), remaining: Math.max(0, await availableCredits(ctx.db, s, addMonths(month, 1), now)) },
    nextReservation: next ?? null,
    payment,
    autopay: hasAutopay(s),
    /** カード払いなのにカードが未登録。トップで登録をお願いする（PY-03） */
    needsCard: needsCard(s),
    /** 今月分のカード払いを、自動課金ではなく自分で払う（カードの登録と一緒、または月をまたいで登録した月） */
    cardPaymentDue: cardDue !== null,
    /** コンビニ・PayPay の今月分が未払いで、決済画面を開ける（PY-16） */
    paymentLinkAvailable: linkDue !== null,
    course: course ? { name: course.name, lessonsPerMonth: course.lessonsPerMonth } : null,
    /** 予約できない理由（RS-02）。予約ボタンを押せなくして表示する */
    blocker: await studentBlocker(ctx.db, s, now, settings),
  };
}
