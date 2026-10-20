import { describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { auditLogs, creditLedger, notifications, payments, reservations, students } from '../src/db/schema.js';
import {
  chargeDetail,
  createCharge,
  createCourse,
  enrollmentOptions,
  expireUnpaid,
  handlePaymentEvent,
  markChargePaid,
  paymentsCsv,
  paymentsOfMonth,
  prepareMonth,
  reconcilePayments,
  recordCashPayment,
  revisePrice,
  savePackage,
  startEnrollment,
  applyPriceChanges,
} from '../src/domain/billing.js';
import { bookAsStudent } from '../src/domain/booking.js';
import { balance } from '../src/domain/credits.js';
import { studentHome } from '../src/domain/home.js';
import { runJobs, sendReminders } from '../src/domain/jobs.js';
import { changeStudentStatus } from '../src/domain/people.js';
import { updateSettings } from '../src/domain/settings.js';
import { StripeGateway } from '../src/integrations/stripe.js';
import { jst } from '../src/lib/time.js';
import type { FakeGateway } from './fake-gateway.js';
import { setupHttp } from './http.js';

/** fixtures の仮のサブスクリプションを除いた一覧 */
const subs = (f: { gateway: FakeGateway }) => f.gateway.subscriptions.filter((s) => s.id !== 'sub_test');

async function billingWorld(now?: Date) {
  const f = await setupHttp(now);
  const course = await createCourse(f.ctx, f.admin, { name: '月4回コース', lessonsPerMonth: 4, amount: 14300 });
  const pkg = await savePackage(f.ctx, f.admin, null, { name: '入会金＋4回', admissionFee: 5500, lessonCount: 4, lessonsPrice: 14300 });
  /** 入会手続き中の生徒（コースは割り当て済み） */
  const enrolling = async (name: string, account?: { id: string }) => {
    const s = await f.mkStudent(name, { autopay: false, ...(account ? { account } : {}) });
    await f.db.update(students).set({ status: 'enrolling', courseId: course.id }).where(eq(students.id, s.student.id));
    return s;
  };
  const paidEvent = (paymentId: string, id = `evt_${paymentId}`) => ({
    id,
    type: 'checkout_paid' as const,
    paymentId,
    sessionId: 'cs',
    paymentMethodId: 'pm_card_visa',
  });
  const reload = async (id: string) => (await f.db.select().from(students).where(eq(students.id, id)))[0]!;
  return { f, course, pkg, enrolling, paidEvent, reload };
}

describe('PY-01 / PY-04 入会画面', () => {
  test('管理者が作ったセットが並び、自動課金が最初に「おすすめ」として出る', async () => {
    const { f, enrolling, pkg } = await billingWorld();
    await savePackage(f.ctx, f.admin, null, { name: '入会金＋2回', admissionFee: 5500, lessonCount: 2, lessonsPrice: 7700 });
    await savePackage(f.ctx, f.admin, null, { name: '終了したセット', admissionFee: 0, lessonCount: 1, lessonsPrice: 1, active: false });
    const { student, actor } = await enrolling('太郎');
    const opts = await enrollmentOptions(f.ctx, actor, student.id);
    expect(opts.packages.map((p) => [p.name, p.total])).toEqual([
      ['入会金＋2回', 13200],
      [pkg.name, 19800],
    ]);
    expect(opts.methods[0]).toMatchObject({ method: 'card', recommended: true });
    expect(opts.course).toEqual({ name: '月4回コース', lessonsPerMonth: 4, amount: 14300 });
  });
});

describe('PY-03 / PY-05 入会の支払い', () => {
  test('入金確定の通知を受けてから回数を付け、在籍中にし、翌月1日開始のサブスクリプションを作る', async () => {
    const { f, enrolling, pkg, paidEvent, reload } = await billingWorld();
    const { student, actor } = await enrolling('太郎');
    const { url } = await startEnrollment(f.ctx, actor, student.id, { packageId: pkg.id, method: 'card' });
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const checkout = f.gateway.checkouts.at(-1)!;
    expect(checkout).toMatchObject({ amount: 19800, method: 'card', saveCard: true, successUrl: 'https://student.example.test/?checkout=done' });

    // 決済画面から戻っただけでは回数は付かない
    const before = await studentHome(f.ctx, actor, student.id);
    expect(before.payment).toBe('confirming');
    expect(before.remaining).toBe(0);
    expect(subs(f)).toHaveLength(0);

    expect(await handlePaymentEvent(f.ctx, paidEvent(checkout.paymentId))).toBe('processed');
    const s = await reload(student.id);
    expect(s.status).toBe('active');
    expect(await balance(f.db, student.id, '2026-10')).toBe(4);
    expect(subs(f)).toEqual([
      expect.objectContaining({ startAt: jst('2026-11-01'), paymentMethodId: 'pm_card_visa', cancelAtPeriodEnd: false }),
    ]);
    expect(s.stripeSubscriptionId).toBe(subs(f)[0]!.id);
    // 入会セットの支払い確定で「在籍中」になったことが操作記録に残る（SR-02）
    const logs = await f.db.select().from(auditLogs).where(eq(auditLogs.targetId, student.id));
    expect(logs.find((l) => l.action === 'student.status')?.details).toMatchObject({ from: 'enrolling', to: 'active' });
    expect(f.mail.sent.at(-1)!.subject).toContain('お支払いを確認しました');

    // 翌月1日に課金されると月額コースの回数が付く
    await handlePaymentEvent(f.ctx, {
      id: 'evt_inv_nov',
      type: 'invoice_paid',
      subscriptionId: s.stripeSubscriptionId!,
      invoiceId: 'in_1',
      periodStart: jst('2026-11-01'),
      amount: 14300,
    });
    expect(await balance(f.db, student.id, '2026-11')).toBe(4);
  });

  test('同じ通知が2回届いても、回数を二重に付けない（OP-02）', async () => {
    const { f, enrolling, pkg, paidEvent } = await billingWorld();
    const { student, actor } = await enrolling('太郎');
    await startEnrollment(f.ctx, actor, student.id, { packageId: pkg.id, method: 'card' });
    const ev = paidEvent(f.gateway.checkouts.at(-1)!.paymentId);
    expect(await handlePaymentEvent(f.ctx, ev)).toBe('processed');
    expect(await handlePaymentEvent(f.ctx, ev)).toBe('duplicate');
    // 別のイベントIDで同じ入金が届いても（照合など）付与は1回
    expect(await handlePaymentEvent(f.ctx, { ...ev, id: 'evt_other' })).toBe('processed');
    expect(await balance(f.db, student.id, '2026-10')).toBe(4);
    expect(subs(f)).toHaveLength(1);
  });

  test('通知が届かなくても、定期的な照合で入金を反映する（OP-02）', async () => {
    const { f, enrolling, pkg } = await billingWorld();
    const { student, actor } = await enrolling('太郎');
    await startEnrollment(f.ctx, actor, student.id, { packageId: pkg.id, method: 'card' });
    const cs = f.gateway.checkouts.at(-1)!;
    f.gateway.checkoutStatuses.set(cs.id, { status: 'paid', paymentMethodId: 'pm_1' });
    f.clock.now = new Date(f.clock.now.getTime() + 60 * 60_000);
    expect(await reconcilePayments(f.ctx)).toBe(1);
    expect(await balance(f.db, student.id, '2026-10')).toBe(4);
    expect(await reconcilePayments(f.ctx)).toBe(0);
  });
});

describe('PY-06 現金の入金', () => {
  test('管理者が入金済みにすると回数が付き、日時・金額・方法・操作した人が残る', async () => {
    const { f, course } = await billingWorld();
    const { student } = await f.mkStudent('太郎', { autopay: false });
    await f.db.update(students).set({ courseId: course.id, billingMethod: 'cash' }).where(eq(students.id, student.id));
    await recordCashPayment(f.ctx, f.admin, { studentId: student.id, month: '2026-10' });
    const [p] = await f.db.select().from(payments).where(eq(payments.studentId, student.id));
    expect(p).toMatchObject({ method: 'cash', amount: 14300, status: 'succeeded', recordedBy: f.adminAccount.id });
    expect(p!.paidAt).toEqual(f.clock.now);
    expect(await balance(f.db, student.id, '2026-10')).toBe(4);
    await expect(recordCashPayment(f.ctx, f.admin, { studentId: student.id, month: '2026-10' })).rejects.toThrow('入金済み');
  });
});

describe('PY-09 / PY-16 月初の請求と入金状況', () => {
  test('月初に在籍中の生徒ごとに請求を用意し、コンビニ・PayPay の生徒には支払いリンクを送る', async () => {
    const { f, course } = await billingWorld(jst('2026-11-01', '00:10'));
    const mk = async (name: string, method: 'card' | 'konbini' | 'paypay' | 'cash') => {
      const s = await f.mkStudent(name, { autopay: method === 'card' });
      await f.db.update(students).set({ courseId: course.id, billingMethod: method }).where(eq(students.id, s.student.id));
      return s.student;
    };
    const card = await mk('カード', 'card');
    const konbini = await mk('コンビニ', 'konbini');
    await mk('ペイペイ', 'paypay');
    await mk('現金', 'cash');
    expect(await prepareMonth(f.ctx, '2026-11')).toEqual({ created: 4, linksSent: 2 });
    expect(await prepareMonth(f.ctx, '2026-11')).toEqual({ created: 0, linksSent: 0 });
    expect(f.gateway.checkouts.map((c) => c.method).sort()).toEqual(['konbini', 'paypay']);
    const linkMail = f.mail.sent.find((m) => m.to === 'コンビニ@example.test')!;
    expect(linkMail.text).toContain('https://checkout.stripe.test/');
    expect(linkMail.text).toContain('14,300円・税込');

    // 支払いが確定するまで回数は付かない
    expect(await balance(f.db, konbini.id, '2026-11')).toBe(0);
    const kp = f.gateway.checkouts.find((c) => c.method === 'konbini')!;
    await handlePaymentEvent(f.ctx, { id: 'evt_k', type: 'checkout_paid', paymentId: kp.paymentId, sessionId: kp.id, paymentMethodId: null });
    expect(await balance(f.db, konbini.id, '2026-11')).toBe(4);

    // カードは Stripe の通知で入金済みになる
    const [cardRow] = await f.db.select().from(students).where(eq(students.id, card.id));
    await handlePaymentEvent(f.ctx, {
      id: 'evt_c',
      type: 'invoice_paid',
      subscriptionId: cardRow!.stripeSubscriptionId!,
      invoiceId: 'in_c',
      periodStart: jst('2026-11-01'),
      amount: 14300,
    });
    const all = await paymentsOfMonth(f.ctx, f.admin, '2026-11');
    expect(all).toHaveLength(4);
    const unpaid = await paymentsOfMonth(f.ctx, f.admin, '2026-11', { unpaidOnly: true });
    expect(unpaid.map((u) => u.studentName).sort()).toEqual(['ペイペイ', '現金']);
    expect(unpaid[0]!.graceDaysLeft).toBe(7);
  });

  test('入会した月の分は、月初の請求を作らない', async () => {
    const { f, enrolling, pkg, paidEvent } = await billingWorld(jst('2026-11-03', '10:00'));
    const { student, actor } = await enrolling('太郎');
    await startEnrollment(f.ctx, actor, student.id, { packageId: pkg.id, method: 'card' });
    await handlePaymentEvent(f.ctx, paidEvent(f.gateway.checkouts.at(-1)!.paymentId));
    await prepareMonth(f.ctx, '2026-11');
    const rows = await f.db.select().from(payments).where(and(eq(payments.studentId, student.id), eq(payments.kind, 'monthly')));
    expect(rows).toHaveLength(0);
  });
});

describe('PY-10 / PY-11 / 3.4 決済の失敗と猶予期間', () => {
  test('失敗するとカード更新のリンクをメールで送り、猶予期間を過ぎると翌月分の予約を取り消す', async () => {
    const { f, course } = await billingWorld(jst('2026-10-26', '10:00'));
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    await f.db.update(students).set({ courseId: course.id }).where(eq(students.id, student.id));
    // 10月中に11月分を先に予約（自動課金の先行予約）
    const r = await bookAsStudent(f.ctx, actor, {
      studentId: student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: jst('2026-11-16', '15:00'),
    });
    f.clock.now = jst('2026-11-01', '01:00');
    await handlePaymentEvent(f.ctx, {
      id: 'evt_fail',
      type: 'invoice_failed',
      subscriptionId: 'sub_test',
      invoiceId: 'in_f',
      periodStart: jst('2026-11-01'),
      amount: 14300,
      hostedUrl: 'https://invoice.stripe.test/in_f',
    });
    const mail = f.mail.sent.at(-1)!;
    expect(mail.subject).toContain('お支払いができませんでした');
    expect(mail.text).toContain('https://invoice.stripe.test/in_f');
    expect(mail.text).toContain('https://student.example.test/?billing=update');
    expect(mail.text).toContain('11月8日（日）までに');

    f.clock.now = jst('2026-11-07', '10:00');
    expect(await expireUnpaid(f.ctx)).toBe(0);
    expect((await studentHome(f.ctx, actor, student.id)).blocker).toBeNull();
    f.clock.now = jst('2026-11-08', '10:00');
    expect(await expireUnpaid(f.ctx)).toBe(1);
    const [row] = await f.db.select().from(reservations).where(eq(reservations.id, r.id));
    expect(row).toMatchObject({ status: 'cancelled', cancelKind: 'unpaid' });
    expect((await studentHome(f.ctx, actor, student.id)).blocker).toContain('お支払いが確認できていない');
  });
});

describe('PY-12 / PY-13 / ST-05 兄弟・解約', () => {
  test('兄弟は生徒ごとに別々のサブスクリプションになる', async () => {
    const { f, enrolling, pkg, paidEvent } = await billingWorld();
    const first = await enrolling('長女');
    const second = await enrolling('長男', first.account);
    for (const s of [first, second]) {
      await startEnrollment(f.ctx, first.actor, s.student.id, { packageId: pkg.id, method: 'card' });
      await handlePaymentEvent(f.ctx, paidEvent(f.gateway.checkouts.at(-1)!.paymentId));
    }
    expect(f.gateway.customers).toHaveLength(2);
    expect(subs(f)).toHaveLength(2);
    expect(new Set(subs(f).map((s) => s.customerId)).size).toBe(2);
  });

  test('退会・休会で翌月1日から課金を止め、休会から戻ると翌月1日から再開する', async () => {
    const { f, enrolling, pkg, paidEvent, reload } = await billingWorld();
    const { student, actor } = await enrolling('太郎');
    await startEnrollment(f.ctx, actor, student.id, { packageId: pkg.id, method: 'card' });
    await handlePaymentEvent(f.ctx, paidEvent(f.gateway.checkouts.at(-1)!.paymentId));
    await changeStudentStatus(f.ctx, f.admin, student.id, 'suspended');
    expect(subs(f)[0]!.cancelAtPeriodEnd).toBe(true);
    f.clock.now = jst('2026-11-01', '00:10');
    await runJobs(f.ctx);
    expect((await reload(student.id)).status).toBe('suspended');
    // 休会中は月額の請求を作らない
    expect(await f.db.select().from(payments).where(eq(payments.kind, 'monthly'))).toHaveLength(0);
    await changeStudentStatus(f.ctx, f.admin, student.id, 'active');
    expect(subs(f)).toHaveLength(2);
    expect(subs(f)[1]!.startAt).toEqual(jst('2026-12-01'));
  });

  test('PY-13 / MB-04 生徒の画面には解約の操作がなく、カードの変更は Stripe の画面へのリンクで行う', async () => {
    const { f, enrolling, pkg, paidEvent } = await billingWorld();
    const { student, actor, account } = await enrolling('太郎');
    await startEnrollment(f.ctx, actor, student.id, { packageId: pkg.id, method: 'card' });
    await handlePaymentEvent(f.ctx, paidEvent(f.gateway.checkouts.at(-1)!.paymentId));
    await f.setPassword(account.id);
    const b = f.browser('student');
    await b.login(account.email);
    expect((await b.post(`/students/${student.id}/billing-portal`)).data.url).toMatch(/^https:\/\/billing\.stripe\.test\//);
    for (const path of [`/students/${student.id}/cancel`, `/students/${student.id}/subscription`, `/students/${student.id}/status`]) {
      expect((await b.post(path, {})).status).toBe(404);
    }
  });
});

describe('PY-14 月額料金の改定', () => {
  test('新規の生徒だけに適用する場合、既存の生徒の料金は変わらない', async () => {
    const { f, course } = await billingWorld(jst('2026-10-31', '10:00'));
    const old = await f.mkStudent('既存', { autopay: false });
    await f.db.update(students).set({ courseId: course.id, billingMethod: 'cash' }).where(eq(students.id, old.student.id));
    await prepareMonth(f.ctx, '2026-10');
    await revisePrice(f.ctx, f.admin, course.id, { amount: 15400, applyToExisting: false });
    const newcomer = await f.mkStudent('新規', { autopay: false });
    await f.db.update(students).set({ courseId: course.id, billingMethod: 'cash' }).where(eq(students.id, newcomer.student.id));
    f.clock.now = jst('2026-11-01', '00:10');
    await prepareMonth(f.ctx, '2026-11');
    const nov = await paymentsOfMonth(f.ctx, f.admin, '2026-11');
    expect(Object.fromEntries(nov.map((p) => [p.studentName, p.amount]))).toEqual({ 既存: 14300, 新規: 15400 });
  });

  test('既存の生徒にも適用する場合、適用日から次回以降の課金額が変わる', async () => {
    const { f, enrolling, pkg, paidEvent, course } = await billingWorld();
    const { student, actor } = await enrolling('太郎');
    await startEnrollment(f.ctx, actor, student.id, { packageId: pkg.id, method: 'card' });
    await handlePaymentEvent(f.ctx, paidEvent(f.gateway.checkouts.at(-1)!.paymentId));
    const oldPrice = subs(f)[0]!.priceId;
    await revisePrice(f.ctx, f.admin, course.id, { amount: 15400, applyToExisting: true, effectiveMonth: '2026-12' });
    f.clock.now = jst('2026-11-29', '10:00');
    expect(await applyPriceChanges(f.ctx)).toBe(0);
    expect(subs(f)[0]!.priceId).toBe(oldPrice);
    f.clock.now = jst('2026-11-30', '00:10');
    expect(await applyPriceChanges(f.ctx)).toBe(1);
    const newPrice = f.gateway.prices.find((p) => p.amount === 15400)!;
    expect(subs(f)[0]!.priceId).toBe(newPrice.id);
    expect(await applyPriceChanges(f.ctx)).toBe(0);
  });
});

describe('PY-15 入金履歴の CSV', () => {
  test('期間を指定して書き出せる', async () => {
    const { f, course } = await billingWorld();
    const { student } = await f.mkStudent('太郎', { autopay: false });
    await f.db.update(students).set({ courseId: course.id }).where(eq(students.id, student.id));
    await recordCashPayment(f.ctx, f.admin, { studentId: student.id, month: '2026-10' });
    const csv = await paymentsCsv(f.ctx, f.admin, jst('2026-10-01'), jst('2026-11-01'));
    expect(csv.startsWith('﻿入金日時,生徒,種類,対象月,方法,金額（税込）\r\n')).toBe(true);
    expect(csv).toContain('10月20日（火） 10:00,太郎,月謝,2026-10,現金,14300');
    expect(await paymentsCsv(f.ctx, f.admin, jst('2026-11-01'), jst('2026-12-01'))).not.toContain('太郎');
  });
});

describe('PY-17 単発の請求', () => {
  test('請求ごとに未払い・入金済みが一覧で分かる', async () => {
    const { f } = await billingWorld();
    const a = await f.mkStudent('太郎');
    const b = await f.mkStudent('花子');
    const charge = await createCharge(f.ctx, f.admin, { title: '発表会参加費', amount: 3000, studentIds: [a.student.id, b.student.id] });
    const detail = await chargeDetail(f.ctx, f.admin, charge.id);
    expect(detail.paidCount).toBe(0);
    await markChargePaid(f.ctx, f.admin, detail.items.find((i) => i.studentName === '太郎')!.id);
    const after = await chargeDetail(f.ctx, f.admin, charge.id);
    expect(after.items.map((i) => [i.studentName, i.paid])).toEqual([
      ['太郎', true],
      ['花子', false],
    ]);
  });
});

describe('NT-01 / NT-02 リマインドと通知の設定', () => {
  test('前日リマインドを設定の時刻以降に1回だけ送る', async () => {
    const f = await setupHttp();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    await bookAsStudent(f.ctx, actor, {
      studentId: student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: jst('2026-10-22', '15:00'),
    });
    f.clock.now = jst('2026-10-21', '08:00');
    expect(await sendReminders(f.ctx)).toBe(0);
    f.clock.now = jst('2026-10-21', '09:05');
    expect(await sendReminders(f.ctx)).toBe(1);
    expect(await sendReminders(f.ctx)).toBe(0);
    expect(f.mail.sent.at(-1)!.subject).toContain('明日のレッスン');
  });

  test('「送らない」にした種類のメールは届かない', async () => {
    const f = await setupHttp();
    await updateSettings(f.db, { notifications: { reservation_confirmed: false } }, null);
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    await bookAsStudent(f.ctx, actor, {
      studentId: student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: jst('2026-10-22', '15:00'),
    });
    expect(f.mail.sent).toHaveLength(0);
    const rows = await f.db.select().from(notifications);
    expect(rows.map((r) => [r.type, r.status])).toEqual([['reservation_confirmed', 'skipped']]);
  });
});

describe('Stripe の通知（Webhook）', () => {
  test('署名が正しい通知だけを処理する', async () => {
    const { f, enrolling, pkg } = await billingWorld();
    const { student, actor } = await enrolling('太郎');
    await startEnrollment(f.ctx, actor, student.id, { packageId: pkg.id, method: 'card' });
    const body = JSON.stringify({ id: 'evt_http', type: 'checkout_paid', paymentId: f.gateway.checkouts.at(-1)!.paymentId, sessionId: 'cs', paymentMethodId: 'pm' });
    const bad = await f.app.request('/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': 'forged' }, body });
    expect(bad.status).toBe(400);
    const ok = await f.app.request('/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': 'valid' }, body });
    expect(await ok.json()).toEqual({ received: true, result: 'processed' });
    expect(await balance(f.db, student.id, '2026-10')).toBe(4);
  });

  test('StripeGateway: 本物の署名を検証し、通知を読み替える', async () => {
    const secret = 'whsec_test_secret';
    const gw = new StripeGateway('sk_test_dummy', secret, undefined);
    const stripe = new Stripe('sk_test_dummy');
    const sign = (payload: object) => {
      const raw = JSON.stringify(payload);
      return { raw, header: stripe.webhooks.generateTestHeaderString({ payload: raw, secret }) };
    };
    const session = (type: string, paymentStatus: string) =>
      sign({
        id: `evt_${type}`,
        object: 'event',
        type,
        data: { object: { id: 'cs_1', object: 'checkout.session', metadata: { paymentId: 'pay_1' }, payment_status: paymentStatus, payment_intent: null } },
      });

    // コンビニ払いは completed でも未入金なので無視し、店頭での支払い後（async_payment_succeeded）に付ける
    const unpaid = session('checkout.session.completed', 'unpaid');
    expect(await gw.parseWebhook(unpaid.raw, unpaid.header)).toBeNull();
    const paid = session('checkout.session.async_payment_succeeded', 'paid');
    expect(await gw.parseWebhook(paid.raw, paid.header)).toEqual({
      id: 'evt_checkout.session.async_payment_succeeded',
      type: 'checkout_paid',
      paymentId: 'pay_1',
      sessionId: 'cs_1',
      paymentMethodId: null,
    });
    const start = Math.floor(jst('2026-11-01').getTime() / 1000);
    const inv = sign({
      id: 'evt_inv',
      object: 'event',
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_1',
          object: 'invoice',
          amount_due: 14300,
          amount_paid: 0,
          hosted_invoice_url: 'https://invoice.stripe.com/i/1',
          parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1', metadata: {} } },
          lines: { object: 'list', data: [{ period: { start, end: start + 2592000 } }] },
        },
      },
    });
    expect(await gw.parseWebhook(inv.raw, inv.header)).toEqual({
      id: 'evt_inv',
      type: 'invoice_failed',
      subscriptionId: 'sub_1',
      invoiceId: 'in_1',
      periodStart: jst('2026-11-01'),
      amount: 14300,
      hostedUrl: 'https://invoice.stripe.com/i/1',
    });
    await expect(gw.parseWebhook(paid.raw, 't=1,v1=forged')).rejects.toThrow();
  });
});

describe('定期処理', () => {
  test('すべての定期処理がエラーなく動き、二度動かしても結果は同じ', async () => {
    const { f, course } = await billingWorld(jst('2026-11-01', '00:10'));
    const { student } = await f.mkStudent('太郎', { autopay: false });
    await f.db.update(students).set({ courseId: course.id, billingMethod: 'cash' }).where(eq(students.id, student.id));
    const first = await runJobs(f.ctx);
    expect(first.filter((r) => r.error)).toEqual([]);
    await runJobs(f.ctx);
    expect(await f.db.select().from(payments)).toHaveLength(1);
    expect((await f.db.select().from(creditLedger)).length).toBe(0);
  });
});
