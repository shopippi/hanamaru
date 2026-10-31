import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  chargeItems,
  charges,
  coursePrices,
  courses,
  creditLedger,
  enrollmentPackages,
  payments,
  priceChanges,
  reservations,
  stripeEvents,
  stripeSubscriptions,
  students,
} from '../db/schema.js';
import { toCsv } from '../lib/csv.js';
import { addMonths, billingAnchor, billingMonthOf, DAY_MS, formatJa, monthOf, startOfMonth, type Month } from '../lib/time.js';
import { adminRecipients, assertAdmin, loadStudent, recipientOfStudent, studentForActor, type Student } from './access.js';
import { audit } from './audit.js';
import { cancelForCause, sendNotices } from './booking.js';
import { SYSTEM, type Actor, type Ctx } from './context.js';
import { addLedger } from './credits.js';
import { conflict, invalid, notFound, ruleViolation } from './errors.js';
import type { InvoiceStatus, OnlineMethod, PaymentEvent } from './payment-gateway.js';
import { cancelDeadlineLabel, enabledBillingMethods, getSettings } from './settings.js';
import type { Message, Recipient } from './notify.js';
import type { NotificationType } from './settings.js';

// 回数券と決済（3.5）。回数は入金が確定してから付ける（PY-05: 決済画面から戻っただけでは付けない）

type Payment = typeof payments.$inferSelect;
type Notice = { type: NotificationType; to: Recipient; message: Message };

const yen = (n: number) => `${n.toLocaleString('ja-JP')}円`;
const monthLabel = (m: Month) => `${Number(m.slice(0, 4))}年${Number(m.slice(5))}月`;
const SIGNATURE = '\n\n--\nはなまる音楽教室';

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw invalid(r.error.issues[0]?.message ?? '入力に誤りがあります', r.error.issues);
  return r.data;
}

// ---------------------------------------------------------------------------
// 料金の設定（PY-01、PY-02、PY-14）
// ---------------------------------------------------------------------------

export const packageInput = z.object({
  name: z.string().trim().min(1, '名前を入力してください').max(100),
  admissionFee: z.number().int().min(0),
  lessonCount: z.number().int().min(0).max(20),
  lessonsPrice: z.number().int().min(0),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

/** 入会セット（PY-01）。含める回数ごとに価格を変えられるよう、セットを複数作れる */
export async function savePackage(ctx: Ctx, actor: Actor, id: string | null, raw: unknown) {
  assertAdmin(actor);
  const input = parse(packageInput, raw);
  const [row] = id
    ? await ctx.db.update(enrollmentPackages).set(input).where(eq(enrollmentPackages.id, id)).returning()
    : await ctx.db.insert(enrollmentPackages).values(input).returning();
  if (!row) throw notFound();
  await audit(ctx.db, actor, id ? 'package.update' : 'package.create', 'enrollment_package', row.id, input);
  return row;
}

export function listPackages(db: Db, opts: { activeOnly?: boolean } = {}) {
  return db
    .select()
    .from(enrollmentPackages)
    .where(opts.activeOnly ? eq(enrollmentPackages.active, true) : undefined)
    .orderBy(asc(enrollmentPackages.sortOrder), asc(enrollmentPackages.lessonCount));
}

export const courseInput = z.object({
  name: z.string().trim().min(1, '名前を入力してください').max(100),
  lessonsPerMonth: z.number().int().min(1).max(31),
  amount: z.number().int().min(0),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

/** 月額コース（PY-02） */
export async function createCourse(ctx: Ctx, actor: Actor, raw: unknown) {
  assertAdmin(actor);
  const input = parse(courseInput, raw);
  return ctx.db.transaction(async (tx) => {
    const [course] = await tx
      .insert(courses)
      .values({ name: input.name, lessonsPerMonth: input.lessonsPerMonth, active: input.active, sortOrder: input.sortOrder })
      .returning();
    await tx.insert(coursePrices).values({ courseId: course!.id, amount: input.amount, isCurrent: true });
    await audit(tx, actor, 'course.create', 'course', course!.id, input);
    return course!;
  });
}

export async function updateCourse(ctx: Ctx, actor: Actor, id: string, raw: unknown) {
  assertAdmin(actor);
  const input = parse(courseInput.omit({ amount: true }).partial(), raw);
  const [row] = await ctx.db.update(courses).set(input).where(eq(courses.id, id)).returning();
  if (!row) throw notFound();
  await audit(ctx.db, actor, 'course.update', 'course', id, input);
  return row;
}

export async function listCourses(db: Db) {
  const rows = await db.select().from(courses).orderBy(asc(courses.sortOrder), asc(courses.lessonsPerMonth));
  const prices = await db.select().from(coursePrices).where(eq(coursePrices.isCurrent, true));
  return rows.map((c) => ({ ...c, amount: prices.find((p) => p.courseId === c.id)?.amount ?? null }));
}

async function currentPrice(db: Db, courseId: string) {
  const [p] = await db
    .select()
    .from(coursePrices)
    .where(and(eq(coursePrices.courseId, courseId), eq(coursePrices.isCurrent, true)))
    .orderBy(desc(coursePrices.createdAt))
    .limit(1);
  if (!p) throw ruleViolation('コースの料金が設定されていません');
  return p;
}

/** 生徒に適用する料金。未設定なら新規の生徒向けの料金を割り当てる */
async function priceForStudent(db: Db, student: Student) {
  if (!student.courseId) throw ruleViolation('月額コースが設定されていません。教室にお問い合わせください');
  if (student.coursePriceId) {
    const [p] = await db.select().from(coursePrices).where(eq(coursePrices.id, student.coursePriceId));
    if (p) return p;
  }
  const p = await currentPrice(db, student.courseId);
  await db.update(students).set({ coursePriceId: p.id }).where(eq(students.id, student.id));
  return p;
}

async function stripePriceId(ctx: Ctx, db: Db, price: typeof coursePrices.$inferSelect): Promise<string> {
  if (price.stripePriceId) return price.stripePriceId;
  const [course] = await db.select().from(courses).where(eq(courses.id, price.courseId));
  const id = await ctx.payments.createMonthlyPrice({ coursePriceId: price.id, courseName: course!.name, amount: price.amount });
  await db.update(coursePrices).set({ stripePriceId: id }).where(eq(coursePrices.id, price.id));
  return id;
}

export const priceRevisionInput = z.object({
  amount: z.number().int().min(0),
  /** true: 既存の生徒にも適用日から適用する。false: 新規の生徒だけ */
  applyToExisting: z.boolean(),
  effectiveMonth: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

/**
 * 月額料金の改定（PY-14）。新規の生徒には今後この料金を使う。
 * 既存の生徒にも適用する場合は、適用月の前日に各生徒の料金を切り替える（次回以降の課金から変わる）。
 */
export async function revisePrice(ctx: Ctx, actor: Actor, courseId: string, raw: unknown) {
  assertAdmin(actor);
  const input = parse(priceRevisionInput, raw);
  if (input.applyToExisting && !input.effectiveMonth) throw invalid('既存の生徒に適用する月を指定してください');
  if (input.effectiveMonth && input.effectiveMonth <= monthOf(ctx.now())) throw invalid('適用する月は来月以降にしてください');
  return ctx.db.transaction(async (tx) => {
    await tx.update(coursePrices).set({ isCurrent: false }).where(eq(coursePrices.courseId, courseId));
    const [price] = await tx.insert(coursePrices).values({ courseId, amount: input.amount, isCurrent: true }).returning();
    if (input.applyToExisting) {
      await tx.insert(priceChanges).values({
        courseId,
        toPriceId: price!.id,
        effectiveMonth: input.effectiveMonth!,
        createdBy: actor.kind === 'account' ? actor.accountId : null,
      });
    }
    await audit(tx, actor, 'course.price', 'course', courseId, input);
    return price!;
  });
}

/** 適用月の前日になった料金改定を、既存の生徒に反映する（定期処理） */
export async function applyPriceChanges(ctx: Ctx): Promise<number> {
  const now = ctx.now();
  const due = await ctx.db.select().from(priceChanges).where(sql`${priceChanges.appliedAt} is null`);
  let n = 0;
  for (const change of due) {
    if (now.getTime() < startOfMonth(change.effectiveMonth).getTime() - DAY_MS) continue;
    await ctx.db.transaction(async (tx) => {
      const [price] = await tx.select().from(coursePrices).where(eq(coursePrices.id, change.toPriceId));
      const affected = await tx.select().from(students).where(eq(students.courseId, change.courseId));
      for (const s of affected) {
        await tx.update(students).set({ coursePriceId: price!.id }).where(eq(students.id, s.id));
        if (s.stripeSubscriptionId) {
          await ctx.payments.changeSubscriptionPrice(s.stripeSubscriptionId, await stripePriceId(ctx, tx, price!));
        }
      }
      await tx.update(priceChanges).set({ appliedAt: now }).where(eq(priceChanges.id, change.id));
      await audit(tx, SYSTEM, 'course.price.apply', 'course', change.courseId, { students: affected.length });
      n++;
    });
  }
  return n;
}

// ---------------------------------------------------------------------------
// 月額のサブスクリプション（PY-03、PY-12）
// ---------------------------------------------------------------------------

/**
 * startAt（翌月1日）から毎月課金するサブスクリプションを用意し、生徒の今の自動課金にする。
 * 途中で処理が失敗して再送されたときに二重に作らないよう、止めていないものが Stripe にあればそれを使う。
 */
async function startSubscription(ctx: Ctx, db: Db, student: Student, startAt: Date, paymentMethodId: string | null): Promise<string> {
  const price = await priceForStudent(db, student);
  const priceId = await stripePriceId(ctx, db, price);
  const id =
    (await ctx.payments.findLiveSubscription(student.stripeCustomerId!, student.id)) ??
    (await ctx.payments.createSubscription({ customerId: student.stripeCustomerId!, priceId, startAt, paymentMethodId, studentId: student.id }));
  await db
    .insert(stripeSubscriptions)
    .values({ id, studentId: student.id, createdAt: ctx.now() })
    .onConflictDoUpdate({ target: stripeSubscriptions.id, set: { stoppedAt: null } });
  await db.update(students).set({ stripeSubscriptionId: id }).where(eq(students.id, student.id));
  return id;
}

/** Stripe のサブスクリプションから生徒を探す。止めたあとに届いた通知も、履歴から探す */
async function studentOfSubscription(db: Db, subscriptionId: string): Promise<Student | null> {
  const [current] = await db.select().from(students).where(eq(students.stripeSubscriptionId, subscriptionId));
  if (current) return current;
  const [past] = await db.select().from(stripeSubscriptions).where(eq(stripeSubscriptions.id, subscriptionId));
  if (!past) return null;
  const [s] = await db.select().from(students).where(eq(students.id, past.studentId));
  return s ?? null;
}

/** 生徒のこれまでのサブスクリプション（今のものを先に） */
async function subscriptionsOf(db: Db, student: Student): Promise<string[]> {
  const rows = await db
    .select({ id: stripeSubscriptions.id })
    .from(stripeSubscriptions)
    .where(eq(stripeSubscriptions.studentId, student.id))
    .orderBy(desc(stripeSubscriptions.createdAt));
  return [...new Set([student.stripeSubscriptionId, ...rows.map((r) => r.id)].filter((x): x is string => !!x))];
}

// ---------------------------------------------------------------------------
// 入会（PY-03〜05）
// ---------------------------------------------------------------------------

async function ensureCustomer(ctx: Ctx, db: Db, student: Student): Promise<string> {
  if (student.stripeCustomerId) return student.stripeCustomerId;
  const to = await recipientOfStudent(db, student);
  const id = await ctx.payments.createCustomer({ name: student.name, email: to.email, studentId: student.id });
  await db.update(students).set({ stripeCustomerId: id }).where(eq(students.id, student.id));
  return id;
}

/** 入会画面に出す内容。自動課金を「おすすめ」として最初に出す（PY-04） */
export async function enrollmentOptions(ctx: Ctx, actor: Actor, studentId: string) {
  const s = await studentForActor(ctx.db, actor, studentId);
  const packages = await listPackages(ctx.db, { activeOnly: true });
  const course = s.courseId ? (await ctx.db.select().from(courses).where(eq(courses.id, s.courseId)))[0] : null;
  const price = s.courseId ? await currentPrice(ctx.db, s.courseId).catch(() => null) : null;
  const settings = await getSettings(ctx.db);
  return {
    status: s.status,
    /** 入会画面で同意を取る契約の内容に使う値（3.8 の設定値）。未払いの扱いは未確定のため出さない（PY-10 の処理は変えない） */
    terms: {
      cancelDeadlineHours: settings.cancelDeadlineHours,
      cancelDeadline: cancelDeadlineLabel(settings),
      carryover: settings.carryoverEnabled && settings.carryoverMax > 0,
    },
    packages: packages.map((p) => ({
      id: p.id,
      name: p.name,
      lessonCount: p.lessonCount,
      admissionFee: p.admissionFee,
      lessonsPrice: p.lessonsPrice,
      total: p.admissionFee + p.lessonsPrice,
    })),
    course: course ? { name: course.name, lessonsPerMonth: course.lessonsPerMonth, amount: price?.amount ?? null } : null,
    // 設定で止めている支払い方法は出さない（PY-04）
    methods: (
      [
        { method: 'card', label: 'クレジットカード・Apple Pay・Google Pay（毎月1日に自動でお支払い）', recommended: true },
        { method: 'konbini', label: 'コンビニ払い（毎月1日にお支払い用のリンクをお送りします）', recommended: false },
        { method: 'paypay', label: 'PayPay（毎月1日にお支払い用のリンクをお送りします）', recommended: false },
      ] as const
    ).filter((m) => enabledBillingMethods(settings).includes(m.method)),
  };
}

/**
 * 入会セットの支払いを始める（PY-03）。Stripe の決済画面の URL を返す。
 * カード払いはカードを保存し、入金確定後に翌月1日開始のサブスクリプションを作る。
 */
export async function startEnrollment(
  ctx: Ctx,
  actor: Actor,
  studentId: string,
  input: { packageId: string; method: OnlineMethod; agreed: boolean },
): Promise<{ url: string }> {
  const s = await studentForActor(ctx.db, actor, studentId);
  if (s.status !== 'enrolling') throw ruleViolation('入会手続きはすでに済んでいます');
  // 契約の内容（期間・自動課金・退会と休会・キャンセル）と利用規約への同意を、お支払いの前に取る
  if (input.agreed !== true) throw invalid('契約の内容と利用規約への同意が必要です');
  if (!enabledBillingMethods(await getSettings(ctx.db)).includes(input.method)) throw invalid('この支払い方法は、いまは使えません');
  if (!s.approved) throw ruleViolation('教室の承認後に入会手続きができます');
  if (!s.courseId) throw ruleViolation('月額コースが設定されていません。教室にお問い合わせください');
  const [pkg] = await ctx.db.select().from(enrollmentPackages).where(eq(enrollmentPackages.id, input.packageId));
  if (!pkg || !pkg.active) throw notFound('入会セットが見つかりません');
  const amount = pkg.admissionFee + pkg.lessonsPrice;
  const customerId = await ensureCustomer(ctx, ctx.db, s);
  const [payment] = await ctx.db
    .insert(payments)
    .values({ studentId: s.id, kind: 'enrollment', method: input.method, amount, enrollmentPackageId: pkg.id, createdAt: ctx.now() })
    .returning();
  const session = await ctx.payments.createCheckout({
    customerId,
    paymentId: payment!.id,
    amount,
    description: `入会セット（${pkg.name}）`,
    method: input.method,
    saveCard: input.method === 'card',
    // 支払い後は生徒のトップに戻り「お支払いを確認中」を出す（PW-06）
    successUrl: `${ctx.urls.student}/?checkout=done`,
    cancelUrl: `${ctx.urls.student}/enroll?checkout=cancel`,
  });
  await ctx.db
    .update(payments)
    .set({ stripeCheckoutSessionId: session.id, paymentUrl: session.url })
    .where(eq(payments.id, payment!.id));
  await ctx.db.update(students).set({ billingMethod: input.method }).where(eq(students.id, s.id));
  // いつ同意したかを残す（入会時の同意の記録）
  await audit(ctx.db, actor, 'student.terms_agreed', 'student', s.id, { paymentId: payment!.id, packageId: pkg.id, method: input.method });
  return { url: session.url };
}

/** 現金での入会（PY-06）。管理者が「入金済み」にすると回数が付く */
export async function recordCashEnrollment(ctx: Ctx, actor: Actor, studentId: string, packageId: string) {
  assertAdmin(actor);
  const s = await loadStudent(ctx.db, studentId);
  if (s.status !== 'enrolling') throw ruleViolation('入会手続き中の生徒ではありません');
  const [pkg] = await ctx.db.select().from(enrollmentPackages).where(eq(enrollmentPackages.id, packageId));
  if (!pkg) throw notFound('入会セットが見つかりません');
  const notices = await ctx.db.transaction(async (tx) => {
    const [payment] = await tx
      .insert(payments)
      .values({
        studentId: s.id,
        kind: 'enrollment',
        method: 'cash',
        amount: pkg.admissionFee + pkg.lessonsPrice,
        enrollmentPackageId: pkg.id,
        status: 'succeeded',
        recordedBy: actor.kind === 'account' ? actor.accountId : null,
        paidAt: ctx.now(),
      })
      .returning();
    await tx.update(students).set({ billingMethod: 'cash' }).where(eq(students.id, s.id));
    await audit(tx, actor, 'payment.cash', 'payment', payment!.id, { studentId, kind: 'enrollment', amount: payment!.amount });
    return completePayment(ctx, tx, payment!, null);
  });
  await sendNotices(ctx, notices);
}

// ---------------------------------------------------------------------------
// 入金の確定
// ---------------------------------------------------------------------------

/** 入金が確定したときの処理。回数の付与は (入金, 理由) で一意なので、二度呼んでも二重に付かない（OP-02） */
async function completePayment(ctx: Ctx, db: Db, payment: Payment, paymentMethodId: string | null): Promise<Notice[]> {
  const student = await loadStudent(db, payment.studentId);
  const notices: Notice[] = [];
  const to = await recipientOfStudent(db, student);
  const already = await db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.paymentId, payment.id)));
  if (already.length > 0) return notices;

  if (payment.kind === 'enrollment') {
    // 入会の支払いをやり直して、2回とも払われた: 2回目は回数を付けず、教室に返金を知らせる
    const [other] = await db
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.studentId, student.id), eq(payments.kind, 'enrollment'), eq(payments.status, 'succeeded'), sql`${payments.id} <> ${payment.id}`));
    if (other) {
      return doublePaymentNotices(db, payment, '【要確認】入会の支払いが二重にありました', `入会セットの支払い（Stripe の決済画面 ${payment.stripeCheckoutSessionId ?? ''}）`);
    }
    const [pkg] = payment.enrollmentPackageId
      ? await db.select().from(enrollmentPackages).where(eq(enrollmentPackages.id, payment.enrollmentPackageId))
      : [];
    const month = monthOf(ctx.now());
    if (pkg && pkg.lessonCount > 0) {
      await addLedger(db, {
        studentId: student.id,
        month,
        delta: pkg.lessonCount,
        reason: 'grant_enrollment',
        paymentId: payment.id,
        actor: SYSTEM,
        note: pkg.name,
      });
    }
    // 入会セットの支払いが確定したら「在籍中」にする（SR-02）
    if (student.status === 'enrolling') {
      await db.update(students).set({ status: 'active' }).where(eq(students.id, student.id));
      await audit(db, SYSTEM, 'student.status', 'student', student.id, { from: 'enrolling', to: 'active', reason: 'enrollment_paid' });
    }
    // カード払いは、翌月1日開始の月額サブスクリプションを作る（PY-03、日割りなし）
    if (payment.method === 'card' && student.stripeCustomerId && !student.stripeSubscriptionId) {
      await startSubscription(ctx, db, student, billingAnchor(addMonths(month, 1)), paymentMethodId);
    }
  } else if (payment.kind === 'monthly' && payment.month) {
    const [course] = student.courseId ? await db.select().from(courses).where(eq(courses.id, student.courseId)) : [];
    if (course) {
      await addLedger(db, {
        studentId: student.id,
        month: payment.month,
        delta: course.lessonsPerMonth,
        reason: 'grant_monthly',
        paymentId: payment.id,
        actor: SYSTEM,
        note: `${course.name}（${monthLabel(payment.month)}分）`,
      });
    }
    // カードの登録と一緒に今月分を払ったときは、翌月1日から自動課金を始める（PY-03）
    // 開始は「今」の翌月1日。月をまたいで前の月の分を払ったときに、過去の日時や払い済みの月から始めない
    if (payment.method === 'card' && paymentMethodId && needsCard(student) && student.stripeCustomerId) {
      await startSubscription(ctx, db, student, billingAnchor(addMonths(monthOf(ctx.now()), 1)), paymentMethodId);
      await db.update(students).set({ cardSetupSessionId: null }).where(eq(students.id, student.id));
    }
  } else if (payment.kind === 'one_off' && payment.chargeItemId) {
    await db.update(chargeItems).set({ paid: true, paymentId: payment.id }).where(eq(chargeItems.id, payment.chargeItemId));
  }
  // 領収は Stripe の自動送信メールで送る（MB-07）。こちらは回数が付いたことを知らせる
  notices.push({
    type: 'payment_succeeded',
    to,
    message: {
      subject: '【お支払い確認】お支払いを確認しました',
      body:
        `${student.name} 様\n\n${yen(payment.amount)}（税込）のお支払いを確認しました。` +
        (payment.kind === 'one_off' ? '' : '\nレッスンの回数をお付けしました。予約画面からご予約ください。') +
        SIGNATURE,
    },
  });
  return notices;
}

async function markFailed(db: Db, payment: Payment, reason: string): Promise<void> {
  if (payment.status === 'succeeded') return;
  await db.update(payments).set({ status: 'failed', failureReason: reason }).where(eq(payments.id, payment.id));
}

async function monthlyPaymentForInvoice(
  db: Db,
  ev: { subscriptionId: string; invoiceId: string; periodStart: Date; amount: number },
): Promise<{ payment: Payment; student: Student; sameInvoice: boolean } | null> {
  const student = await studentOfSubscription(db, ev.subscriptionId);
  if (!student) return null;
  // 課金日が日本時間の1日 0:00 からずれても、いちばん近い月の月謝として扱う
  const month = billingMonthOf(ev.periodStart);
  const [existing] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.studentId, student.id), eq(payments.kind, 'monthly'), eq(payments.month, month)));
  if (existing) {
    const sameInvoice = existing.stripeInvoiceId === ev.invoiceId;
    // 入金済みの行（現金や決済画面で払った月）は書き換えない
    if (existing.status === 'succeeded') return { payment: existing, student, sameInvoice };
    if (!existing.stripeInvoiceId) {
      await db.update(payments).set({ stripeInvoiceId: ev.invoiceId, amount: ev.amount }).where(eq(payments.id, existing.id));
    }
    return { payment: { ...existing, stripeInvoiceId: existing.stripeInvoiceId ?? ev.invoiceId, amount: ev.amount }, student, sameInvoice };
  }
  const [created] = await db
    .insert(payments)
    .values({ studentId: student.id, kind: 'monthly', method: 'card', month, amount: ev.amount, stripeInvoiceId: ev.invoiceId })
    .returning();
  return { payment: created!, student, sameInvoice: true };
}

/**
 * Stripe の通知を処理する（PY-05）。同じ通知が2回届いても二重に処理しない（OP-02）。
 * 処理に失敗したら例外にして、Stripe に再送させる。
 */
export async function handlePaymentEvent(ctx: Ctx, ev: PaymentEvent): Promise<'processed' | 'duplicate' | 'ignored'> {
  const result = await ctx.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(stripeEvents)
      .values({ id: ev.id, type: ev.type })
      .onConflictDoNothing()
      .returning({ id: stripeEvents.id });
    if (inserted.length === 0) return { status: 'duplicate' as const, notices: [] as Notice[] };

    switch (ev.type) {
      case 'checkout_paid':
      case 'checkout_failed': {
        const [p] = await tx.select().from(payments).where(eq(payments.id, ev.paymentId)).for('update');
        if (!p) return { status: 'ignored' as const, notices: [] };
        if (ev.type === 'checkout_failed') {
          // 作り直したあとの古い画面の期限切れは、今の画面には関係しない
          if (p.stripeCheckoutSessionId && p.stripeCheckoutSessionId !== ev.sessionId) return { status: 'processed' as const, notices: [] };
          await markFailed(tx, p, 'checkout_failed');
          return { status: 'processed' as const, notices: [] };
        }
        if (p.status === 'succeeded') {
          // 同じ画面の通知の重複（Webhook と照合など）は何もしない。
          // 現金で入金済みの月や、別の画面・自動課金で払い済みの月にまた払われたら、二重の入金なので教室に知らせる
          if (p.method !== 'cash' && p.stripeCheckoutSessionId === ev.sessionId) return { status: 'processed' as const, notices: [] };
          return {
            status: 'processed' as const,
            notices: await doublePaymentNotices(tx, p, '【要確認】入金済みの月に、もう一度お支払いがありました', `決済画面での支払い（Stripe の決済画面 ${ev.sessionId}）`),
          };
        }
        // どの画面で払われたかを残す（あとで別の画面からも払われたら、二重の入金と分かるように）
        const [taken] = await tx
          .select({ id: payments.id })
          .from(payments)
          .where(and(eq(payments.stripeCheckoutSessionId, ev.sessionId), sql`${payments.id} <> ${p.id}`));
        await tx
          .update(payments)
          .set({ status: 'succeeded', paidAt: ctx.now(), failureReason: null, ...(taken ? {} : { stripeCheckoutSessionId: ev.sessionId }) })
          .where(eq(payments.id, p.id));
        return { status: 'processed' as const, notices: await completePayment(ctx, tx, p, ev.paymentMethodId) };
      }
      case 'invoice_paid': {
        if (ev.amount === 0) return { status: 'ignored' as const, notices: [] };
        const found = await monthlyPaymentForInvoice(tx, ev);
        if (!found) return { status: 'ignored' as const, notices: [] };
        const p = found.payment;
        if (p.status === 'succeeded') {
          // 同じ請求の通知の重複は何もしない。現金や決済画面で入金済みの月にカードの課金もされたら、
          // 二重の入金なので、教室に知らせて返金してもらう
          if (found.sameInvoice && p.method !== 'cash') return { status: 'processed' as const, notices: [] };
          return {
            status: 'processed' as const,
            notices: await doublePaymentNotices(tx, p, '【要確認】入金済みの月にカードの課金がありました', `カードの自動課金（Stripe の請求 ${ev.invoiceId}）`),
          };
        }
        await tx.update(payments).set({ status: 'succeeded', paidAt: ctx.now(), failureReason: null }).where(eq(payments.id, p.id));
        const notices = await completePayment(ctx, tx, p, null);
        // 休会・退会のあとに課金された（月末で止める前の請求など）: 教室に知らせて返金を確かめてもらう（ST-05）
        if (found.student.status === 'suspended' || found.student.status === 'withdrawn') {
          notices.push(...(await leftStudentChargedNotices(tx, found.student, p, ev.invoiceId)));
        }
        return { status: 'processed' as const, notices };
      }
      case 'card_registered': {
        const [s] = await tx.select().from(students).where(eq(students.id, ev.studentId)).for('update');
        if (!s) return { status: 'ignored' as const, notices: [] };
        await tx.update(students).set({ cardSetupSessionId: null }).where(eq(students.id, s.id));
        // 登録が済んだら、翌月1日から自動課金を始める（PY-03、日割りなし）
        if (needsCard(s) && s.stripeCustomerId) {
          await startSubscription(ctx, tx, s, billingAnchor(addMonths(monthOf(ctx.now()), 1)), ev.paymentMethodId);
        }
        return { status: 'processed' as const, notices: [] };
      }
      case 'subscription_deleted': {
        // Stripe 側で終わった自動課金は、もう自動課金として扱わない（3.4 の先行予約など）。
        // 終わったあとに残りの請求が払われることもあるので、履歴には必ず残す
        const [owner] = await tx.select().from(students).where(eq(students.stripeSubscriptionId, ev.subscriptionId));
        if (owner) {
          await tx
            .insert(stripeSubscriptions)
            .values({ id: ev.subscriptionId, studentId: owner.id, createdAt: ctx.now(), stoppedAt: ctx.now() })
            .onConflictDoNothing();
        }
        await tx
          .update(stripeSubscriptions)
          .set({ stoppedAt: ctx.now() })
          .where(and(eq(stripeSubscriptions.id, ev.subscriptionId), isNull(stripeSubscriptions.stoppedAt)));
        await tx.update(students).set({ stripeSubscriptionId: null }).where(eq(students.stripeSubscriptionId, ev.subscriptionId));
        return { status: 'processed' as const, notices: [] };
      }
      case 'invoice_failed': {
        const found = await monthlyPaymentForInvoice(tx, ev);
        if (!found) return { status: 'ignored' as const, notices: [] };
        const p = found.payment;
        // 通知の順番は保証されない。入金済みの月に遅れて失敗の通知が届いても、失敗のメールは送らない
        if (p.status === 'succeeded') return { status: 'processed' as const, notices: [] };
        // Stripe は失敗した請求を何度か引き落とし直す。メールは最初に失敗したときの1通だけにする
        const alreadyNotified = p.status === 'failed';
        await markFailed(tx, p, 'invoice_payment_failed');
        if (alreadyNotified) return { status: 'processed' as const, notices: [] };
        const student = await loadStudent(tx, p.studentId);
        const settings = await getSettings(tx);
        // 猶予期間の最後の日（その翌日 0:00 に取り消す。PY-10）
        const deadline = new Date(startOfMonth(p.month!).getTime() + settings.graceDays * DAY_MS - 1);
        // カードの更新や再認証ができる画面へのリンクを送る（PY-11）
        const notice: Notice = {
          type: 'payment_failed',
          to: await recipientOfStudent(tx, student),
          message: {
            subject: '【重要】月謝のお支払いができませんでした',
            body:
              `${student.name} 様\n\n${monthLabel(p.month!)}分の月謝（${yen(p.amount)}・税込）をカードでお支払いできませんでした。\n` +
              `お手数ですが、次のリンクからカードの更新または再認証をお願いします。\n\n` +
              (ev.hostedUrl ? `お支払い画面: ${ev.hostedUrl}\n` : '') +
              `カードの変更: ${ctx.urls.student}/?billing=update\n\n` +
              `${formatJa(deadline, false)}までにお支払いが確認できない場合、レッスンの予約ができなくなり、${monthLabel(p.month!)}分のご予約は取り消しとなります。` +
              SIGNATURE,
          },
        };
        return { status: 'processed' as const, notices: [notice] };
      }
    }
  });
  await sendNotices(ctx, result.notices);
  return result.status;
}

async function doublePaymentNotices(db: Db, p: Payment, subject: string, source: string): Promise<Notice[]> {
  const student = await loadStudent(db, p.studentId);
  const what = p.kind === 'enrollment' ? '入会セット' : `${monthLabel(p.month!)}分`;
  const how = p.method === 'cash' ? '現金' : 'ほかの方法';
  const message: Message = {
    subject,
    body:
      `${student.name} さんの${what}は${p.kind === 'enrollment' ? 'すでに' : `${how}で`}入金済みですが、${source}もありました。\n` +
      `二重のお支払いになっているため、Stripe の管理画面から返金してください。回数は二重には付けていません。` +
      SIGNATURE,
  };
  return (await adminRecipients(db)).map((to) => ({ type: 'payment_succeeded' as const, to, message }));
}

/** 休会・退会のあとの課金を教室に知らせる（ST-05: 翌月1日から課金を止める） */
async function leftStudentChargedNotices(db: Db, student: Student, p: Payment, invoiceId: string): Promise<Notice[]> {
  const label = student.status === 'suspended' ? '休会' : '退会';
  const message: Message = {
    subject: `【要確認】${label}中の生徒にカードの課金がありました`,
    body:
      `${student.name} さんは${label}中ですが、${monthLabel(p.month!)}分のカードの自動課金（Stripe の請求 ${invoiceId}、${yen(p.amount)}）がありました。\n` +
      `返金が必要か確かめ、必要なら Stripe の管理画面から返金してください。` +
      SIGNATURE,
  };
  return (await adminRecipients(db)).map((to) => ({ type: 'payment_succeeded' as const, to, message }));
}

/** 現金の入金を記録する（PY-06）。日時・金額・方法「現金」・操作した人が残る */
export async function recordCashPayment(ctx: Ctx, actor: Actor, input: { studentId: string; month: Month; amount?: number }) {
  assertAdmin(actor);
  const s = await loadStudent(ctx.db, input.studentId);
  const result = await ctx.db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.studentId, s.id), eq(payments.kind, 'monthly'), eq(payments.month, input.month)))
      .for('update');
    if (existing?.status === 'succeeded') throw conflict('この月はすでに入金済みです');
    const amount = input.amount ?? existing?.amount ?? (await priceForStudent(tx, s)).amount;
    const values = {
      method: 'cash' as const,
      amount,
      status: 'succeeded' as const,
      recordedBy: actor.kind === 'account' ? actor.accountId : null,
      paidAt: ctx.now(),
      failureReason: null,
    };
    const [payment] = existing
      ? await tx.update(payments).set(values).where(eq(payments.id, existing.id)).returning()
      : await tx.insert(payments).values({ ...values, studentId: s.id, kind: 'monthly', month: input.month }).returning();
    await audit(tx, actor, 'payment.cash', 'payment', payment!.id, { studentId: s.id, month: input.month, amount });
    const done = await completePayment(ctx, tx, payment!, null);
    return { notices: done, invoiceId: existing?.method === 'card' ? existing.stripeInvoiceId : null };
  });
  const notices = result.notices;
  // カードの請求が残っていれば取り消す。あとから再試行で引き落とされ、二重の入金にならないように
  if (result.invoiceId) {
    try {
      await ctx.payments.voidInvoice(result.invoiceId);
    } catch (e) {
      const message: Message = {
        subject: '【要確認】カードの請求を取り消せませんでした',
        body:
          `${s.name} さんの${monthLabel(input.month)}分を現金で入金済みにしましたが、カードの請求（${result.invoiceId}）を取り消せませんでした。\n` +
          `Stripe の管理画面で請求を取り消してください（${e instanceof Error ? e.message : String(e)}）。` +
          SIGNATURE,
      };
      for (const to of await adminRecipients(ctx.db)) notices.push({ type: 'payment_failed', to, message });
    }
  }
  await sendNotices(ctx, notices);
}

// ---------------------------------------------------------------------------
// 毎月の処理
// ---------------------------------------------------------------------------

/**
 * 月初の準備。在籍中の生徒ごとに、その月の月額の請求を1件用意する（PY-09 の一覧の元）。
 * - カード: Stripe が毎月1日に課金する。通知で入金済み・失敗になる
 * - コンビニ払い・PayPay: 支払いリンクを作ってメールで送る（PY-16）
 * - 現金: 管理者が「入金済み」にするまで未払い（PY-06）
 * 何度呼んでも、1人1か月に1件しか作らない。
 */
export async function prepareMonth(ctx: Ctx, month: Month): Promise<{ created: number; linksSent: number }> {
  const targets = await ctx.db
    .select()
    .from(students)
    .where(and(eq(students.status, 'active'), isNotNull(students.courseId)));
  let created = 0;
  let linksSent = 0;
  const errors: string[] = [];
  for (const s of targets) {
    try {
      const r = await prepareStudentMonth(ctx, s, month);
      if (r.created) created++;
      if (r.linkSent) linksSent++;
    } catch (e) {
      // 1人の失敗でほかの生徒の請求を止めない。支払いリンクは次の実行で作り直す
      errors.push(`${s.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (errors.length) throw new Error(`月初の請求の準備に失敗した生徒がいます: ${errors.join(' / ')}`);
  return { created, linksSent };
}

async function prepareStudentMonth(ctx: Ctx, s: Student, month: Month): Promise<{ created: boolean; linkSent: boolean }> {
  let [payment] = await ctx.db
    .select()
    .from(payments)
    .where(and(eq(payments.studentId, s.id), eq(payments.kind, 'monthly'), eq(payments.month, month)));
  let created = false;
  if (!payment) {
    // 入会した月の分は入会セットで払い済み
    const [enrolledThisMonth] = await ctx.db
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.studentId, s.id),
          eq(payments.kind, 'enrollment'),
          eq(payments.status, 'succeeded'),
          gte(payments.paidAt, startOfMonth(month)),
        ),
      );
    if (enrolledThisMonth) return { created: false, linkSent: false };
    const price = await priceForStudent(ctx.db, s);
    [payment] = await ctx.db
      .insert(payments)
      .values({ studentId: s.id, kind: 'monthly', method: s.billingMethod, month, amount: price.amount, createdAt: ctx.now() })
      .onConflictDoNothing()
      .returning();
    if (!payment) return { created: false, linkSent: false };
    created = true;
  }
  // コンビニ・PayPay は支払いリンクを送る。前回 Stripe の呼び出しに失敗してリンクがない請求も、ここで作り直す
  // （決済画面の作成は payments.id で冪等なので、作り直しても二重にならない）
  const method = payment.method;
  if ((method !== 'konbini' && method !== 'paypay') || payment.status !== 'pending' || payment.stripeCheckoutSessionId) {
    return { created, linkSent: false };
  }
  const session = await ctx.payments.createCheckout({
    customerId: await ensureCustomer(ctx, ctx.db, s),
    paymentId: payment.id,
    amount: payment.amount,
    description: `${monthLabel(month)}分 月謝`,
    method,
    saveCard: false,
    successUrl: `${ctx.urls.student}/?checkout=done`,
    cancelUrl: `${ctx.urls.student}/`,
  });
  await ctx.db
    .update(payments)
    .set({ stripeCheckoutSessionId: session.id, paymentUrl: session.url })
    .where(eq(payments.id, payment.id));
  const label = method === 'konbini' ? 'コンビニ' : 'PayPay';
  await ctx.notifier.send('payment_link', await recipientOfStudent(ctx.db, s), {
    subject: `【はなまる音楽教室】${monthLabel(month)}分 月謝のお支払いのお願い`,
    body:
      `${s.name} 様\n\n${monthLabel(month)}分の月謝（${yen(payment.amount)}・税込）のお支払いをお願いします。\n` +
      `次のリンクから${label}でお支払いください。お支払いを確認してから、今月のレッスンを予約できます。\n\n${session.url}\n\n` +
      `リンクの期限（24時間）が切れた場合は、次のリンクからアプリを開くと、お支払いの画面を開き直せます。\n${ctx.urls.student}/?billing=pay` +
      SIGNATURE,
  });
  return { created, linkSent: true };
}

/**
 * 未払いのまま猶予期間（PY-10）を過ぎた月の予約を取り消す（3.4）。
 * 予約時に使った回数は、付与されていない月の分なので戻す。
 */
export async function expireUnpaid(ctx: Ctx): Promise<number> {
  const settings = await getSettings(ctx.db);
  const now = ctx.now();
  const unpaid = await ctx.db
    .select()
    .from(payments)
    .where(and(eq(payments.kind, 'monthly'), inArray(payments.status, ['pending', 'failed'])));
  let cancelled = 0;
  for (const p of unpaid) {
    if (!p.month || startOfMonth(p.month).getTime() + settings.graceDays * DAY_MS >= now.getTime()) continue;
    const list = await ctx.db
      .select()
      .from(reservations)
      .where(
        and(
          eq(reservations.studentId, p.studentId),
          eq(reservations.lessonMonth, p.month),
          inArray(reservations.status, ['pending', 'confirmed']),
          gte(reservations.startsAt, now),
        ),
      );
    if (list.length === 0) continue;
    const notices = await ctx.db.transaction((tx) => cancelForCause(tx, list, 'unpaid', SYSTEM, now));
    await sendNotices(ctx, notices);
    cancelled += list.length;
  }
  return cancelled;
}

/**
 * 通知が届かなかった場合に備えて、未処理の決済を Stripe に問い合わせて照合する（OP-02）。
 */
export async function reconcilePayments(ctx: Ctx): Promise<number> {
  const now = ctx.now();
  const pending = await ctx.db
    .select()
    .from(payments)
    .where(and(eq(payments.status, 'pending'), lt(payments.createdAt, new Date(now.getTime() - 30 * 60_000))));
  let fixed = 0;
  for (const p of pending) {
    if (p.stripeCheckoutSessionId) {
      const st = await ctx.payments.checkoutStatus(p.stripeCheckoutSessionId);
      if (st.status === 'open') continue;
      await handlePaymentEvent(ctx, {
        id: `reconcile:${p.stripeCheckoutSessionId}`,
        type: st.status === 'paid' ? 'checkout_paid' : 'checkout_failed',
        paymentId: p.id,
        sessionId: p.stripeCheckoutSessionId,
        ...(st.status === 'paid' ? { paymentMethodId: st.paymentMethodId } : {}),
      } as PaymentEvent);
      fixed++;
    } else if (p.kind === 'monthly' && p.method === 'card' && p.month) {
      const [s] = await ctx.db.select().from(students).where(eq(students.id, p.studentId));
      if (!s) continue;
      // 止めたあとのサブスクリプションの請求も探す
      let found: { subscriptionId: string; inv: InvoiceStatus } | null = null;
      for (const subscriptionId of await subscriptionsOf(ctx.db, s)) {
        const inv = await ctx.payments.findSubscriptionInvoice(subscriptionId, p.month);
        if (inv) {
          found = { subscriptionId, inv };
          break;
        }
      }
      if (!found || found.inv.status === 'open') continue;
      const { inv } = found;
      const base = { subscriptionId: found.subscriptionId, invoiceId: inv.invoiceId, periodStart: startOfMonth(p.month), amount: inv.amount };
      await handlePaymentEvent(
        ctx,
        inv.status === 'paid'
          ? { id: `reconcile:${inv.invoiceId}:paid`, type: 'invoice_paid', ...base }
          : { id: `reconcile:${inv.invoiceId}:failed`, type: 'invoice_failed', ...base, hostedUrl: inv.hostedUrl },
      );
      fixed++;
    }
  }
  // カードの登録の画面も、通知が届かなかったときに備えて照合する
  const setups = await ctx.db.select().from(students).where(isNotNull(students.cardSetupSessionId));
  for (const s of setups) {
    const st = await ctx.payments.cardSetupStatus(s.cardSetupSessionId!);
    if (st.status === 'open') continue;
    if (st.status === 'expired') {
      await ctx.db.update(students).set({ cardSetupSessionId: null }).where(eq(students.id, s.id));
      continue;
    }
    await handlePaymentEvent(ctx, {
      id: `reconcile:${s.cardSetupSessionId}`,
      type: 'card_registered',
      studentId: s.id,
      sessionId: s.cardSetupSessionId!,
      paymentMethodId: st.paymentMethodId,
    });
    fixed++;
  }
  return fixed;
}

// ---------------------------------------------------------------------------
// カード管理・解約・休会
// ---------------------------------------------------------------------------

/** Stripe のカード管理画面へ（MB-04）。解約の操作はない設定（PY-13） */
export async function billingPortal(ctx: Ctx, actor: Actor, studentId: string): Promise<{ url: string }> {
  const s = await studentForActor(ctx.db, actor, studentId);
  if (!s.stripeCustomerId) throw ruleViolation('カードが登録されていません');
  return { url: await ctx.payments.billingPortalUrl(s.stripeCustomerId, `${ctx.urls.student}/`) };
}

/**
 * 退会・休会で翌月1日から課金を止める（ST-05）。今月分は返金しない。
 * サブスクリプションの ID は履歴に残し、止めたあとに届く請求の通知も受け取れるようにする。
 */
export async function stopBilling(ctx: Ctx, student: Student): Promise<void> {
  const id = student.stripeSubscriptionId;
  if (id) {
    await ctx.payments.cancelSubscriptionAtPeriodEnd(id);
    await ctx.db
      .insert(stripeSubscriptions)
      .values({ id, studentId: student.id, stoppedAt: ctx.now() })
      .onConflictDoUpdate({ target: stripeSubscriptions.id, set: { stoppedAt: ctx.now() } });
  }
  await ctx.db.update(students).set({ stripeSubscriptionId: null }).where(eq(students.id, student.id));
}

/** 休会から戻ったとき、カード払いの生徒は翌月1日から課金を再開する */
export async function resumeBilling(ctx: Ctx, student: Student): Promise<void> {
  if (student.billingMethod !== 'card' || !student.stripeCustomerId || student.stripeSubscriptionId) return;
  await startSubscription(ctx, ctx.db, student, billingAnchor(addMonths(monthOf(ctx.now()), 1)), null);
}

/**
 * 予定していた退会・休会を取りやめたとき、月末で止める設定にした自動課金を元に戻す。
 * 止めたものがなければ翌月1日から新しく始める。
 */
export async function undoStopBilling(ctx: Ctx, student: Student): Promise<void> {
  if (student.billingMethod !== 'card' || student.stripeSubscriptionId) return;
  const [stopped] = await ctx.db
    .select()
    .from(stripeSubscriptions)
    .where(and(eq(stripeSubscriptions.studentId, student.id), isNotNull(stripeSubscriptions.stoppedAt)))
    .orderBy(desc(stripeSubscriptions.stoppedAt))
    .limit(1);
  if (stopped) {
    await ctx.payments.resumeSubscription(stopped.id);
    await ctx.db.update(stripeSubscriptions).set({ stoppedAt: null }).where(eq(stripeSubscriptions.id, stopped.id));
    await ctx.db.update(students).set({ stripeSubscriptionId: stopped.id }).where(eq(students.id, student.id));
    return;
  }
  await resumeBilling(ctx, student);
}

/**
 * 管理者がコース・支払い方法を変えたとき、課金にも反映する（PY-14 と同じく次回の課金から、日割りなし）。
 * - コースを変えたら、新しいコースの今の料金にする
 * - カード払いをやめたら自動課金を月末で止め、カード払いにしたら翌月1日から自動課金を始める
 */
export async function applyBillingChange(ctx: Ctx, before: Student, after: Student): Promise<void> {
  let s = after;
  if (before.courseId !== after.courseId) {
    await ctx.db.update(students).set({ coursePriceId: null }).where(eq(students.id, s.id));
    s = { ...s, coursePriceId: null };
    if (s.courseId && s.stripeSubscriptionId && s.billingMethod === 'card') {
      const price = await priceForStudent(ctx.db, s);
      await ctx.payments.changeSubscriptionPrice(s.stripeSubscriptionId, await stripePriceId(ctx, ctx.db, price));
    }
  }
  if (before.billingMethod === 'card' && s.billingMethod !== 'card') {
    await stopBilling(ctx, s);
  } else if (before.billingMethod !== 'card' && needsCard(s)) {
    // カードがまだ登録されていないかもしれないので、登録をお願いする。登録が済んだら翌月1日から自動課金を始める
    await requestCardRegistration(ctx, s);
  }
}

// ---------------------------------------------------------------------------
// カードの登録（PY-03）
// ---------------------------------------------------------------------------

/** カード払いで在籍中なのに、自動課金が始まっていない（カードの登録が要る） */
export function needsCard(s: Student): boolean {
  return s.billingMethod === 'card' && s.status === 'active' && !s.scheduledStatus && !s.stripeSubscriptionId;
}

/**
 * その月の月謝を自動課金が払うか。自動課金は始めた月の翌月1日から課金するので、
 * 始めた月（とそれより前）は対象外。履歴のない古い自動課金は、対象として扱う
 */
async function coveredBySubscription(db: Db, s: Student, month: Month): Promise<boolean> {
  if (!s.stripeSubscriptionId) return false;
  const [row] = await db.select().from(stripeSubscriptions).where(eq(stripeSubscriptions.id, s.stripeSubscriptionId));
  return !row || monthOf(row.createdAt) < month;
}

/**
 * 今月分のカード払いで、自動課金が払わない（まだ払われていない）請求。
 * カードの登録と一緒に払う月や、月をまたいで登録したため自動課金の対象外になった月
 */
export async function unpaidCardMonth(ctx: Ctx, s: Student): Promise<Payment | null> {
  if (s.billingMethod !== 'card' || s.status !== 'active') return null;
  const month = monthOf(ctx.now());
  const [p] = await ctx.db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.studentId, s.id),
        eq(payments.kind, 'monthly'),
        eq(payments.month, month),
        eq(payments.method, 'card'),
        inArray(payments.status, ['pending', 'failed']),
        isNull(payments.stripeInvoiceId),
      ),
    );
  if (!p || (await coveredBySubscription(ctx.db, s, month))) return null;
  return p;
}

/** 今月分のコンビニ・PayPay の未払いの請求（PY-16） */
export async function unpaidLinkMonth(ctx: Ctx, s: Student): Promise<Payment | null> {
  if (s.status !== 'active') return null;
  const [p] = await ctx.db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.studentId, s.id),
        eq(payments.kind, 'monthly'),
        eq(payments.month, monthOf(ctx.now())),
        inArray(payments.method, ['konbini', 'paypay']),
        inArray(payments.status, ['pending', 'failed']),
      ),
    );
  return p ?? null;
}

/**
 * 月謝の決済画面を開く。開いている画面があればそれを使い、期限が切れていれば（Checkout は24時間で切れる）作り直す
 */
async function monthlyCheckout(ctx: Ctx, s: Student, p: Payment, method: OnlineMethod, saveCard: boolean): Promise<{ url: string }> {
  if (p.stripeCheckoutSessionId && p.status === 'pending') {
    const st = await ctx.payments.checkoutStatus(p.stripeCheckoutSessionId);
    if (st.status === 'open' && p.paymentUrl) return { url: p.paymentUrl };
    if (st.status === 'paid') throw conflict('お支払いを確認しています。しばらくしてから画面を開き直してください');
  }
  const session = await ctx.payments.createCheckout({
    customerId: await ensureCustomer(ctx, ctx.db, s),
    paymentId: p.id,
    amount: p.amount,
    description: `${monthLabel(p.month!)}分 月謝`,
    method,
    saveCard,
    successUrl: `${ctx.urls.student}/?checkout=done`,
    cancelUrl: `${ctx.urls.student}/`,
    ...(p.stripeCheckoutSessionId ? { replaces: p.stripeCheckoutSessionId } : {}),
  });
  await ctx.db
    .update(payments)
    .set({ stripeCheckoutSessionId: session.id, paymentUrl: session.url, status: 'pending', failureReason: null })
    .where(and(eq(payments.id, p.id), inArray(payments.status, ['pending', 'failed'])));
  return { url: session.url };
}

/**
 * カードの登録・今月分のカード払いの Stripe の画面を開く。
 * - 今月分が自動課金の対象外で未払いなら、その支払いの画面（カードの登録が要るならカードも保存する）
 * - そうでなくカードの登録が要るなら、カードだけを登録する画面
 * どちらも、カードを登録したら翌月1日から自動課金を始める（PY-03、日割りなし）
 */
export async function startCardRegistration(ctx: Ctx, actor: Actor, studentId: string): Promise<{ url: string }> {
  const s = await studentForActor(ctx.db, actor, studentId);
  const due = await unpaidCardMonth(ctx, s);
  if (due) return monthlyCheckout(ctx, s, due, 'card', needsCard(s));
  if (!needsCard(s)) throw ruleViolation('カードの登録は必要ありません');
  const session = await ctx.payments.createCardSetup({
    customerId: await ensureCustomer(ctx, ctx.db, s),
    studentId: s.id,
    successUrl: `${ctx.urls.student}/?card=done`,
    cancelUrl: `${ctx.urls.student}/`,
  });
  await ctx.db.update(students).set({ cardSetupSessionId: session.id }).where(eq(students.id, s.id));
  return { url: session.url };
}

/** コンビニ・PayPay の今月分の決済画面を開く（PY-16）。メールのリンクの期限が切れても、生徒のトップから開き直せる */
export async function startMonthlyPayment(ctx: Ctx, actor: Actor, studentId: string): Promise<{ url: string }> {
  const s = await studentForActor(ctx.db, actor, studentId);
  const p = await unpaidLinkMonth(ctx, s);
  if (!p) throw ruleViolation('お支払いが必要な請求はありません');
  return monthlyCheckout(ctx, s, p, p.method as 'konbini' | 'paypay', false);
}

/** カードの登録をお願いするメール。生徒の画面のリンクから登録できる */
export async function requestCardRegistration(ctx: Ctx, s: Student): Promise<void> {
  await ctx.notifier.send('card_registration', await recipientOfStudent(ctx.db, s), {
    subject: '【はなまる音楽教室】カードのご登録のお願い',
    body:
      `${s.name} 様\n\n月謝のお支払いがカードの自動払いになりました。\n` +
      `次のリンクからカードをご登録ください。ご登録後、翌月1日から毎月自動でお支払いいただきます。\n\n` +
      `${ctx.urls.student}/?billing=register` +
      SIGNATURE,
  });
}

/** 管理者が、カードの登録のお願いをもう一度送る */
export async function resendCardRequest(ctx: Ctx, actor: Actor, studentId: string): Promise<void> {
  assertAdmin(actor);
  const s = await loadStudent(ctx.db, studentId);
  if (!needsCard(s)) throw ruleViolation('この生徒はカードの登録が必要ありません');
  await requestCardRegistration(ctx, s);
  await audit(ctx.db, actor, 'student.card_request', 'student', s.id, {});
}

// ---------------------------------------------------------------------------
// 入金状況（PY-09、PY-15、DB-03）
// ---------------------------------------------------------------------------

/** 月ごと・生徒ごとの入金状況。unpaidOnly で未払い・決済失敗だけに絞る（PY-09） */
export async function paymentsOfMonth(ctx: Ctx, actor: Actor, month: Month, opts: { unpaidOnly?: boolean } = {}) {
  assertAdmin(actor);
  const settings = await getSettings(ctx.db);
  const conds = [eq(payments.kind, 'monthly'), eq(payments.month, month)];
  if (opts.unpaidOnly) conds.push(inArray(payments.status, ['pending', 'failed']));
  const rows = await ctx.db
    .select({
      paymentId: payments.id,
      studentId: students.id,
      studentName: students.name,
      method: payments.method,
      amount: payments.amount,
      status: payments.status,
      paidAt: payments.paidAt,
    })
    .from(payments)
    .innerJoin(students, eq(students.id, payments.studentId))
    .where(and(...conds))
    .orderBy(asc(students.name));
  const deadline = startOfMonth(month).getTime() + settings.graceDays * DAY_MS;
  const now = ctx.now().getTime();
  return rows.map((r) => ({
    ...r,
    // 猶予期間の残り日数（DB-03）。過ぎていれば 0
    graceDaysLeft: r.status === 'succeeded' ? null : Math.max(0, Math.ceil((deadline - now) / DAY_MS)),
  }));
}

/** 入金履歴の CSV（PY-15）。期間は入金日で絞る */
export async function paymentsCsv(ctx: Ctx, actor: Actor, from: Date, to: Date): Promise<string> {
  assertAdmin(actor);
  const rows = await ctx.db
    .select({
      paidAt: payments.paidAt,
      studentName: students.name,
      kind: payments.kind,
      month: payments.month,
      method: payments.method,
      amount: payments.amount,
    })
    .from(payments)
    .innerJoin(students, eq(students.id, payments.studentId))
    .where(and(eq(payments.status, 'succeeded'), gte(payments.paidAt, from), lt(payments.paidAt, to)))
    .orderBy(asc(payments.paidAt));
  const KIND = { enrollment: '入会', monthly: '月謝', one_off: '単発' } as const;
  const METHOD = { card: 'カード', konbini: 'コンビニ', paypay: 'PayPay', cash: '現金' } as const;
  return toCsv([
    ['入金日時', '生徒', '種類', '対象月', '方法', '金額（税込）'],
    ...rows.map((r) => [r.paidAt ? formatJa(r.paidAt) : '', r.studentName, KIND[r.kind], r.month ?? '', METHOD[r.method], r.amount]),
  ]);
}

// ---------------------------------------------------------------------------
// 単発の請求（PY-17）
// ---------------------------------------------------------------------------

export const chargeInput = z.object({
  title: z.string().trim().min(1, '請求の名前を入力してください').max(100),
  amount: z.number().int().min(1),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  studentIds: z.array(z.string().uuid()).min(1, '請求する生徒を選んでください'),
});

export async function createCharge(ctx: Ctx, actor: Actor, raw: unknown) {
  assertAdmin(actor);
  const input = parse(chargeInput, raw);
  return ctx.db.transaction(async (tx) => {
    const [charge] = await tx
      .insert(charges)
      .values({ title: input.title, amount: input.amount, dueDate: input.dueDate ?? null, createdBy: actor.kind === 'account' ? actor.accountId : null })
      .returning();
    await tx.insert(chargeItems).values([...new Set(input.studentIds)].map((studentId) => ({ chargeId: charge!.id, studentId, amount: input.amount })));
    await audit(tx, actor, 'charge.create', 'charge', charge!.id, input);
    return charge!;
  });
}

/** 請求ごとに、生徒ごとの未払い・入金済みの一覧 */
export async function chargeDetail(ctx: Ctx, actor: Actor, chargeId: string) {
  assertAdmin(actor);
  const [charge] = await ctx.db.select().from(charges).where(eq(charges.id, chargeId));
  if (!charge) throw notFound('請求が見つかりません');
  const items = await ctx.db
    .select({ id: chargeItems.id, studentId: students.id, studentName: students.name, amount: chargeItems.amount, paid: chargeItems.paid })
    .from(chargeItems)
    .innerJoin(students, eq(students.id, chargeItems.studentId))
    .where(eq(chargeItems.chargeId, chargeId))
    .orderBy(asc(students.name));
  return { ...charge, items, paidCount: items.filter((i) => i.paid).length };
}

export async function listCharges(ctx: Ctx, actor: Actor) {
  assertAdmin(actor);
  const list = await ctx.db.select().from(charges).orderBy(desc(charges.createdAt));
  const items = await ctx.db.select().from(chargeItems);
  return list.map((c) => {
    const mine = items.filter((i) => i.chargeId === c.id);
    return { ...c, total: mine.length, paid: mine.filter((i) => i.paid).length };
  });
}

/** 単発の請求を入金済みにする（現金など）。入金記録が残る */
export async function markChargePaid(ctx: Ctx, actor: Actor, itemId: string) {
  assertAdmin(actor);
  await ctx.db.transaction(async (tx) => {
    const [item] = await tx.select().from(chargeItems).where(eq(chargeItems.id, itemId)).for('update');
    if (!item) throw notFound();
    if (item.paid) throw conflict('すでに入金済みです');
    const [payment] = await tx
      .insert(payments)
      .values({
        studentId: item.studentId,
        kind: 'one_off',
        method: 'cash',
        amount: item.amount,
        chargeItemId: item.id,
        status: 'succeeded',
        recordedBy: actor.kind === 'account' ? actor.accountId : null,
        paidAt: ctx.now(),
      })
      .returning();
    await tx.update(chargeItems).set({ paid: true, paymentId: payment!.id }).where(eq(chargeItems.id, item.id));
    await audit(tx, actor, 'payment.cash', 'payment', payment!.id, { chargeItemId: item.id, amount: item.amount });
  });
}

