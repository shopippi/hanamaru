import { describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { payments, stripeSubscriptions, students } from '../src/db/schema.js';
import {
  createCourse,
  handlePaymentEvent,
  prepareMonth,
  reconcilePayments,
  recordCashPayment,
  resendCardRequest,
  savePackage,
  startCardRegistration,
  startEnrollment,
  startMonthlyPayment,
} from '../src/domain/billing.js';
import { balance } from '../src/domain/credits.js';
import { studentHome } from '../src/domain/home.js';
import { changeStudentStatus, updateStudent } from '../src/domain/people.js';
import { billingAnchor, billingMonthOf, jst } from '../src/lib/time.js';
import { setup } from './fixtures.js';
import { setupHttp } from './http.js';

// お支払い・カードの登録・自動課金の、変則的な流れ（連打、通知の順番、月またぎ、二重払い、Stripe の失敗など）

type F = Awaited<ReturnType<typeof setup>>;

/** 月4回コース（14,300円）の在籍中の生徒。autopay: false ならカードの登録がない */
async function student(opts: { autopay?: boolean; method?: 'card' | 'konbini' | 'paypay' | 'cash'; now?: Date; f?: F; name?: string } = {}) {
  const f = opts.f ?? (await setup(opts.now));
  const course = await createCourse(f.ctx, f.admin, { name: '月4回コース', lessonsPerMonth: 4, amount: 14300 });
  const s = await f.mkStudent(opts.name ?? '太郎', { autopay: opts.autopay ?? false });
  await f.db
    .update(students)
    .set({ courseId: course.id, billingMethod: opts.method ?? 'card' })
    .where(eq(students.id, s.student.id));
  const reload = async () => (await f.db.select().from(students).where(eq(students.id, s.student.id)))[0]!;
  const monthly = async (month: string) =>
    (await f.db.select().from(payments).where(and(eq(payments.studentId, s.student.id), eq(payments.kind, 'monthly'), eq(payments.month, month))))[0];
  return { f, course, ...s, reload, monthly };
}

const subsOf = (f: F, studentId: string) => f.gateway.subscriptions.filter((x) => x.studentId === studentId);
const refundAlerts = (f: F) => f.mail.sent.filter((m) => m.to === 'matsuda@example.test' && m.subject.includes('要確認'));
const setupDone = (studentId: string, sessionId: string, id = `evt_${sessionId}`) => ({
  id,
  type: 'card_registered' as const,
  studentId,
  sessionId,
  paymentMethodId: `pm_${sessionId}`,
});
const paid = (paymentId: string, sessionId: string, id = `evt_${sessionId}`) => ({
  id,
  type: 'checkout_paid' as const,
  paymentId,
  sessionId,
  paymentMethodId: `pm_${sessionId}`,
});

/** 今月分の支払いの画面を開き、期限が切れたことにして作り直す（2つの画面ができる） */
async function twoSessions(f: F, actor: Parameters<typeof startCardRegistration>[1], studentId: string) {
  await startCardRegistration(f.ctx, actor, studentId);
  f.gateway.checkoutStatuses.set(f.gateway.checkouts[0]!.id, { status: 'failed', paymentMethodId: null });
  await startCardRegistration(f.ctx, actor, studentId);
  expect(f.gateway.checkouts[1]!.replaces).toBe(f.gateway.checkouts[0]!.id);
  return [f.gateway.checkouts[0]!, f.gateway.checkouts[1]!] as const;
}

describe('1. 連打・2つのタブ', () => {
  test('PY-03 カードの登録を2回始めて両方とも登録されても、自動課金は1つだけ', async () => {
    const { f, student: s, actor } = await student();
    await startCardRegistration(f.ctx, actor, s.id);
    await startCardRegistration(f.ctx, actor, s.id);
    const [a, b] = f.gateway.cardSetups;
    await handlePaymentEvent(f.ctx, setupDone(s.id, a!.id));
    await handlePaymentEvent(f.ctx, setupDone(s.id, b!.id));
    expect(subsOf(f, s.id)).toHaveLength(1);
  });

  test('PY-03 今月分の支払いのボタンを連打しても、開いている同じ画面を使う', async () => {
    const { f, student: s, actor } = await student();
    await prepareMonth(f.ctx, '2026-10');
    const first = await startCardRegistration(f.ctx, actor, s.id);
    const second = await startCardRegistration(f.ctx, actor, s.id);
    expect(second.url).toBe(first.url);
    expect(f.gateway.checkouts).toHaveLength(1);
  });

  test('PY-03 / PY-05 今月分の支払いの画面を作り直したあと、古い画面と新しい画面の両方で払われたら、回数は1回分だけ付け、教室に返金を知らせる', async () => {
    const { f, student: s, actor, monthly } = await student();
    await prepareMonth(f.ctx, '2026-10');
    const [a, b] = await twoSessions(f, actor, s.id);
    expect(a!.paymentId).toBe(b!.paymentId);
    await handlePaymentEvent(f.ctx, paid(a!.paymentId, a!.id));
    await handlePaymentEvent(f.ctx, paid(b!.paymentId, b!.id));
    expect(await balance(f.db, s.id, '2026-10')).toBe(4);
    expect(subsOf(f, s.id)).toHaveLength(1);
    expect(refundAlerts(f)).toHaveLength(1);
    expect((await monthly('2026-10'))!.status).toBe('succeeded');
  });

  test('PY-05 同じ支払いの通知が、Webhook と照合の両方から届いても、教室への知らせは出さない', async () => {
    const { f, student: s, actor } = await student();
    await prepareMonth(f.ctx, '2026-10');
    await startCardRegistration(f.ctx, actor, s.id);
    const c = f.gateway.checkouts[0]!;
    await handlePaymentEvent(f.ctx, paid(c.paymentId, c.id, 'evt_1'));
    await handlePaymentEvent(f.ctx, paid(c.paymentId, c.id, `reconcile:${c.id}`));
    expect(refundAlerts(f)).toHaveLength(0);
  });
});

describe('2. 登録の途中で状態が変わる', () => {
  for (const change of ['cash', 'suspended', 'withdrawn', 'scheduled'] as const) {
    test(`ST-05 / PY-03 登録の画面を開いたあとに${change}になったら、カードが登録されても自動課金を始めない`, async () => {
      const { f, student: s, actor, reload } = await student();
      await startCardRegistration(f.ctx, actor, s.id);
      if (change === 'cash') await updateStudent(f.ctx, f.admin, s.id, { billingMethod: 'cash' });
      else if (change === 'scheduled') await changeStudentStatus(f.ctx, f.admin, s.id, 'withdrawn');
      else await changeStudentStatus(f.ctx, f.admin, s.id, change, { immediately: true });
      await handlePaymentEvent(f.ctx, setupDone(s.id, f.gateway.cardSetups[0]!.id));
      expect(subsOf(f, s.id)).toHaveLength(0);
      expect((await reload()).stripeSubscriptionId).toBeNull();
    });
  }

  test('PY-03 現金にしてからカード払いに戻すと、もう一度登録でき、自動課金は1つ', async () => {
    const { f, student: s, actor } = await student();
    await updateStudent(f.ctx, f.admin, s.id, { billingMethod: 'cash' });
    await updateStudent(f.ctx, f.admin, s.id, { billingMethod: 'card' });
    await startCardRegistration(f.ctx, actor, s.id);
    await handlePaymentEvent(f.ctx, setupDone(s.id, f.gateway.cardSetups.at(-1)!.id));
    expect(subsOf(f, s.id)).toHaveLength(1);
  });
});

describe('3. 登録の通知の重複・順番・照合', () => {
  test('OP-02 登録の通知が2回・照合のあとに届いても、自動課金は1つ', async () => {
    const { f, student: s, actor, reload } = await student();
    await startCardRegistration(f.ctx, actor, s.id);
    const id = f.gateway.cardSetups[0]!.id;
    f.gateway.cardSetupStatuses.set(id, { status: 'complete', paymentMethodId: 'pm_x' });
    await reconcilePayments(f.ctx);
    await handlePaymentEvent(f.ctx, setupDone(s.id, id, 'evt_a'));
    await handlePaymentEvent(f.ctx, setupDone(s.id, id, 'evt_a'));
    await handlePaymentEvent(f.ctx, setupDone(s.id, id, 'evt_b'));
    expect(subsOf(f, s.id)).toHaveLength(1);
    expect((await reload()).cardSetupSessionId).toBeNull();
  });

  test('OP-02 登録の画面が期限切れになったら照合で片づけ、もう一度登録を始められる', async () => {
    const { f, student: s, actor, reload } = await student();
    await startCardRegistration(f.ctx, actor, s.id);
    f.gateway.cardSetupStatuses.set(f.gateway.cardSetups[0]!.id, { status: 'expired', paymentMethodId: null });
    await reconcilePayments(f.ctx);
    expect((await reload()).cardSetupSessionId).toBeNull();
    await startCardRegistration(f.ctx, actor, s.id);
    expect(f.gateway.cardSetups).toHaveLength(2);
  });

  test('OP-02 古い登録の画面の通知が、新しい画面のあとに届いても問題ない', async () => {
    const { f, student: s, actor } = await student();
    await startCardRegistration(f.ctx, actor, s.id);
    await startCardRegistration(f.ctx, actor, s.id);
    const [a, b] = f.gateway.cardSetups;
    await handlePaymentEvent(f.ctx, setupDone(s.id, b!.id));
    await handlePaymentEvent(f.ctx, setupDone(s.id, a!.id));
    expect(subsOf(f, s.id)).toHaveLength(1);
    expect(subsOf(f, s.id)[0]!.paymentMethodId).toBe(`pm_${b!.id}`);
  });
});

describe('4. 月またぎ', () => {
  test('PY-03 10月分の画面を10月31日に開き、11月1日に払ったら、10月分の回数が付き、自動課金は12月から。11月分も払える', async () => {
    const { f, student: s, actor, monthly } = await student({ now: jst('2026-10-31', '23:50') });
    await prepareMonth(f.ctx, '2026-10');
    await startCardRegistration(f.ctx, actor, s.id);
    const oct = f.gateway.checkouts[0]!;
    f.clock.now = jst('2026-11-01', '10:00');
    await prepareMonth(f.ctx, '2026-11');
    await handlePaymentEvent(f.ctx, paid(oct.paymentId, oct.id));
    expect(await balance(f.db, s.id, '2026-10')).toBe(4);
    // 課金の開始は「今」より先でなければならない（Stripe は過去の日時を受け付けない）
    const sub = subsOf(f, s.id)[0]!;
    expect(sub.startAt.getTime()).toBeGreaterThan(f.clock.now.getTime());
    expect(sub.startAt).toEqual(billingAnchor('2026-12'));
    // 11月分は自動課金の対象外なので、生徒がカードで払える
    const home = await studentHome(f.ctx, actor, s.id);
    expect(home.payment).toBe('unpaid');
    expect(home.cardPaymentDue).toBe(true);
    await startCardRegistration(f.ctx, actor, s.id);
    const nov = f.gateway.checkouts.at(-1)!;
    expect(nov).toMatchObject({ paymentId: (await monthly('2026-11'))!.id, saveCard: false });
    await handlePaymentEvent(f.ctx, paid(nov.paymentId, nov.id));
    expect(await balance(f.db, s.id, '2026-11')).toBe(4);
    expect(subsOf(f, s.id)).toHaveLength(1);
  });

  test('PY-03 自動課金が始まっている月の請求は、通知を待つ（生徒に払わせない）', async () => {
    const { f, student: s, actor } = await student();
    await startCardRegistration(f.ctx, actor, s.id);
    await handlePaymentEvent(f.ctx, setupDone(s.id, f.gateway.cardSetups[0]!.id));
    f.clock.now = jst('2026-11-01', '09:30');
    await prepareMonth(f.ctx, '2026-11');
    const home = await studentHome(f.ctx, actor, s.id);
    expect(home.payment).toBe('confirming');
    expect(home.cardPaymentDue).toBe(false);
    await expect(startCardRegistration(f.ctx, actor, s.id)).rejects.toThrow();
  });

  test('PY-03 登録を1日の 8:59 に済ませても、その月ではなく翌月から自動課金（その月は自分で払う）', async () => {
    const { f, student: s, actor } = await student({ now: jst('2026-11-01', '08:59') });
    await prepareMonth(f.ctx, '2026-11');
    await startCardRegistration(f.ctx, actor, s.id);
    const nov = f.gateway.checkouts[0]!;
    await handlePaymentEvent(f.ctx, paid(nov.paymentId, nov.id));
    expect(subsOf(f, s.id)[0]!.startAt).toEqual(billingAnchor('2026-12'));
    expect(await balance(f.db, s.id, '2026-11')).toBe(4);
  });
});

describe('5・6. 二重の入金', () => {
  test('PY-06 支払いの画面を開いている間に現金で入金済みにされ、そのあと画面で払われたら、回数は増やさず教室に返金を知らせる', async () => {
    const { f, student: s, actor } = await student({ method: 'konbini' });
    await prepareMonth(f.ctx, '2026-10');
    const c = f.gateway.checkouts[0]!;
    await recordCashPayment(f.ctx, f.admin, { studentId: s.id, month: '2026-10' });
    await handlePaymentEvent(f.ctx, paid(c.paymentId, c.id));
    expect(await balance(f.db, s.id, '2026-10')).toBe(4);
    expect(refundAlerts(f)).toHaveLength(1);
    expect(actor).toBeTruthy();
  });

  test('PY-03 入会の支払いを2回（戻ってやり直し）して両方払われても、回数は1回分。2回目は教室に返金を知らせる', async () => {
    const f = await setup();
    const { course } = await student({ f, name: '花子' });
    const pkg = await savePackage(f.ctx, f.admin, null, { name: '入会金＋4回', admissionFee: 5500, lessonCount: 4, lessonsPrice: 14300 });
    const s = await f.mkStudent('太郎', { autopay: false });
    await f.db.update(students).set({ status: 'enrolling', courseId: course.id }).where(eq(students.id, s.student.id));
    await startEnrollment(f.ctx, s.actor, s.student.id, { packageId: pkg.id, method: 'card', agreed: true });
    await startEnrollment(f.ctx, s.actor, s.student.id, { packageId: pkg.id, method: 'card', agreed: true });
    const [a, b] = f.gateway.checkouts.slice(-2);
    await handlePaymentEvent(f.ctx, paid(a!.paymentId, a!.id));
    await handlePaymentEvent(f.ctx, paid(b!.paymentId, b!.id));
    expect(await balance(f.db, s.student.id, '2026-10')).toBe(4);
    expect(subsOf(f, s.student.id)).toHaveLength(1);
    expect(refundAlerts(f)).toHaveLength(1);
  });

  test('PY-05 自分で払った月に、自動課金の請求も払われたら、教室に返金を知らせる', async () => {
    const { f, student: s, actor } = await student({ now: jst('2026-11-01', '10:00') });
    await prepareMonth(f.ctx, '2026-11');
    await startCardRegistration(f.ctx, actor, s.id);
    const c = f.gateway.checkouts[0]!;
    await handlePaymentEvent(f.ctx, paid(c.paymentId, c.id));
    const subId = subsOf(f, s.id)[0]!.id;
    await handlePaymentEvent(f.ctx, {
      id: 'evt_inv',
      type: 'invoice_paid',
      subscriptionId: subId,
      invoiceId: 'in_x',
      periodStart: billingAnchor('2026-11'),
      amount: 14300,
    });
    expect(await balance(f.db, s.id, '2026-11')).toBe(4);
    expect(refundAlerts(f)).toHaveLength(1);
  });
});

describe('7. 想定外の請求', () => {
  test('ST-05 退会・休会したあとに自動課金の請求が払われたら、教室に返金を知らせる', async () => {
    const { f, student: s } = await student({ autopay: true });
    await changeStudentStatus(f.ctx, f.admin, s.id, 'suspended', { immediately: true });
    await handlePaymentEvent(f.ctx, {
      id: 'evt_late',
      type: 'invoice_paid',
      subscriptionId: 'sub_test',
      invoiceId: 'in_late',
      periodStart: billingAnchor('2026-11'),
      amount: 14300,
    });
    expect(refundAlerts(f).some((m) => m.text.includes('休会'))).toBe(true);
  });

  test('PY-05 知らないサブスクリプションの請求は無視する', async () => {
    const f = await setup();
    const r = await handlePaymentEvent(f.ctx, {
      id: 'evt_x',
      type: 'invoice_paid',
      subscriptionId: 'sub_unknown',
      invoiceId: 'in_x',
      periodStart: billingAnchor('2026-11'),
      amount: 14300,
    });
    expect(r).toBe('ignored');
  });

  test('PY-14 請求の金額がこちらの料金と違っても（改定の前後）、届いた金額で記録する', async () => {
    const { f, student: s, monthly } = await student({ autopay: true });
    await handlePaymentEvent(f.ctx, {
      id: 'evt_amt',
      type: 'invoice_paid',
      subscriptionId: 'sub_test',
      invoiceId: 'in_amt',
      periodStart: billingAnchor('2026-11'),
      amount: 15400,
    });
    expect((await monthly('2026-11'))!).toMatchObject({ amount: 15400, status: 'succeeded' });
    expect(await balance(f.db, s.id, '2026-11')).toBe(4);
  });
});

describe('8. 再試行がすべて失敗して自動課金が終わった', () => {
  test('PY-11 / PY-03 自動課金が終わると、生徒にカードの登録を求め、登録し直すと翌月から新しい自動課金。失敗した月は請求のリンクで払える', async () => {
    const { f, student: s, actor, monthly } = await student({ autopay: true, now: jst('2026-11-01', '10:00') });
    await prepareMonth(f.ctx, '2026-11');
    await handlePaymentEvent(f.ctx, {
      id: 'evt_fail',
      type: 'invoice_failed',
      subscriptionId: 'sub_test',
      invoiceId: 'in_nov',
      periodStart: billingAnchor('2026-11'),
      amount: 14300,
      hostedUrl: 'https://invoice.stripe.test/in_nov',
    });
    await handlePaymentEvent(f.ctx, { id: 'evt_del', type: 'subscription_deleted', subscriptionId: 'sub_test' });
    const home = await studentHome(f.ctx, actor, s.id);
    expect(home.needsCard).toBe(true);
    expect(home.payment).toBe('failed');
    // 失敗のメールに請求のリンクがある（PY-11）。その請求があとで払われれば、11月分として付く
    expect(f.mail.sent.some((m) => m.text.includes('https://invoice.stripe.test/in_nov'))).toBe(true);
    await startCardRegistration(f.ctx, actor, s.id);
    await handlePaymentEvent(f.ctx, setupDone(s.id, f.gateway.cardSetups[0]!.id));
    expect(subsOf(f, s.id).at(-1)!.startAt).toEqual(billingAnchor('2026-12'));
    await handlePaymentEvent(f.ctx, {
      id: 'evt_nov_paid',
      type: 'invoice_paid',
      subscriptionId: 'sub_test',
      invoiceId: 'in_nov',
      periodStart: billingAnchor('2026-11'),
      amount: 14300,
    });
    expect((await monthly('2026-11'))!.status).toBe('succeeded');
    expect(await balance(f.db, s.id, '2026-11')).toBe(4);
  });
});

describe('9. 不正・想定外の通知', () => {
  test('OP-02 存在しない支払いの通知は無視し、カード払いでない生徒の登録の通知では自動課金を始めない', async () => {
    const { f, student: s } = await student({ method: 'cash' });
    expect(await handlePaymentEvent(f.ctx, paid('00000000-0000-0000-0000-000000000000', 'cs_x'))).toBe('ignored');
    await handlePaymentEvent(f.ctx, setupDone(s.id, 'cs_setup_x'));
    expect(subsOf(f, s.id)).toHaveLength(0);
    expect(await handlePaymentEvent(f.ctx, setupDone('00000000-0000-0000-0000-000000000000', 'cs_y'))).toBe('ignored');
  });

  test('OP-02 署名のない・不正な通知は 400 で断り、何も変えない', async () => {
    const f = await setupHttp();
    const before = f.gateway.subscriptions.length;
    for (const signature of [undefined, 'invalid']) {
      const res = await f.app.request('/api/stripe/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(signature ? { 'stripe-signature': signature } : {}) },
        body: JSON.stringify({ id: 'evt_forged', type: 'card_registered', studentId: 'x', sessionId: 'y', paymentMethodId: null }),
      });
      expect(res.status).toBe(400);
    }
    expect(f.gateway.subscriptions.length).toBe(before);
  });
});

describe('10. Stripe の呼び出しの失敗', () => {
  test('OP-02 登録の画面を作れなかったら、古い画面の ID を残さない', async () => {
    const { f, student: s, actor, reload } = await student();
    f.gateway.failNext = true;
    await expect(startCardRegistration(f.ctx, actor, s.id)).rejects.toThrow();
    expect((await reload()).cardSetupSessionId).toBeNull();
  });

  test('OP-02 登録の通知の処理中に自動課金を作れなかったら、処理済みにせず、Stripe の再送で1つだけ作る', async () => {
    const { f, student: s, actor, reload } = await student();
    await startCardRegistration(f.ctx, actor, s.id);
    const ev = setupDone(s.id, f.gateway.cardSetups[0]!.id);
    f.gateway.failNext = true;
    await expect(handlePaymentEvent(f.ctx, ev)).rejects.toThrow();
    expect((await reload()).stripeSubscriptionId).toBeNull();
    expect(await handlePaymentEvent(f.ctx, ev)).toBe('processed');
    expect(await handlePaymentEvent(f.ctx, ev)).toBe('duplicate');
    expect(subsOf(f, s.id)).toHaveLength(1);
  });
});

describe('11. 管理者の操作', () => {
  test('PY-06 カード→現金→カードを続けて切り替えても、自動課金は二重にならない', async () => {
    const { f, student: s, actor } = await student({ autopay: true });
    await f.db.insert(stripeSubscriptions).values({ id: 'sub_test', studentId: s.id, createdAt: jst('2026-09-15', '10:00') });
    f.gateway.subscriptions[0]!.studentId = s.id;
    await updateStudent(f.ctx, f.admin, s.id, { billingMethod: 'cash' });
    await updateStudent(f.ctx, f.admin, s.id, { billingMethod: 'card' });
    await startCardRegistration(f.ctx, actor, s.id);
    await handlePaymentEvent(f.ctx, setupDone(s.id, f.gateway.cardSetups[0]!.id));
    const live = f.gateway.subscriptions.filter((x) => x.studentId === s.id && !x.cancelAtPeriodEnd);
    expect(live).toHaveLength(1);
  });

  test('PY-14 カードの登録待ちの間にコースを変えたら、登録後の自動課金は新しいコースの料金', async () => {
    const { f, student: s, actor } = await student();
    const big = await createCourse(f.ctx, f.admin, { name: '月8回コース', lessonsPerMonth: 8, amount: 26000 });
    await updateStudent(f.ctx, f.admin, s.id, { courseId: big.id });
    await startCardRegistration(f.ctx, actor, s.id);
    await handlePaymentEvent(f.ctx, setupDone(s.id, f.gateway.cardSetups[0]!.id));
    const priceId = subsOf(f, s.id)[0]!.priceId;
    expect(f.gateway.prices.find((p) => p.id === priceId)!.amount).toBe(26000);
  });

  test('PY-03 登録が要らない生徒に、登録のお願いは送れない', async () => {
    const { f, student: s } = await student({ autopay: true });
    await expect(resendCardRequest(f.ctx, f.admin, s.id)).rejects.toThrow('必要ありません');
  });
});

describe('12. コンビニ・PayPay の支払いリンク', () => {
  for (const method of ['konbini', 'paypay'] as const) {
    test(`PY-16 ${method} の支払いの画面が期限切れになっても、生徒のトップから新しい画面を開ける`, async () => {
      const { f, student: s, actor, monthly } = await student({ method });
      await prepareMonth(f.ctx, '2026-10');
      const first = f.gateway.checkouts[0]!;
      // 期限が切れる前は、同じ画面を開く
      expect((await startMonthlyPayment(f.ctx, actor, s.id)).url).toBe(first.url);
      expect(f.gateway.checkouts).toHaveLength(1);
      // Checkout の画面は24時間で切れる
      await handlePaymentEvent(f.ctx, { id: 'evt_exp', type: 'checkout_failed', paymentId: first.paymentId, sessionId: first.id });
      const home = await studentHome(f.ctx, actor, s.id);
      expect(home.payment).toBe('failed');
      expect(home.paymentLinkAvailable).toBe(true);
      const { url } = await startMonthlyPayment(f.ctx, actor, s.id);
      const second = f.gateway.checkouts.at(-1)!;
      expect(url).toBe(second.url);
      expect(second).toMatchObject({ paymentId: first.paymentId, method, replaces: first.id });
      expect((await monthly('2026-10'))!.status).toBe('pending');
      // 古い画面の失敗の通知が遅れて届いても、新しい画面は生きている
      await handlePaymentEvent(f.ctx, { id: 'evt_exp_again', type: 'checkout_failed', paymentId: first.paymentId, sessionId: first.id });
      expect((await monthly('2026-10'))!.status).toBe('pending');
      await handlePaymentEvent(f.ctx, paid(second.paymentId, second.id));
      expect(await balance(f.db, s.id, '2026-10')).toBe(4);
    });
  }

  test('PY-16 支払いリンクのメールには、期限が切れたときにアプリから開き直せることを書く', async () => {
    const { f } = await student({ method: 'paypay' });
    await prepareMonth(f.ctx, '2026-10');
    const mail = f.mail.sent.find((m) => m.subject.includes('月謝のお支払いのお願い'))!;
    expect(mail.text).toContain('https://student.example.test/?billing=pay');
  });

  test('PY-16 支払いが済んだ月・カード払いの生徒は、支払いリンクを開けない', async () => {
    const { f, student: s, actor } = await student({ method: 'konbini' });
    await prepareMonth(f.ctx, '2026-10');
    await recordCashPayment(f.ctx, f.admin, { studentId: s.id, month: '2026-10' });
    await expect(startMonthlyPayment(f.ctx, actor, s.id)).rejects.toThrow();
  });
});

describe('13. 時刻の境目', () => {
  test('PY-03 請求の期間の開始が前後に数日ずれても、いちばん近い月（12月・1月・2月・3月）', () => {
    const at = (iso: string) => billingMonthOf(new Date(iso));
    expect(at('2026-11-30T15:00:00Z')).toBe('2026-12');
    expect(at('2026-12-01T00:00:00Z')).toBe('2026-12');
    expect(at('2026-12-03T23:00:00Z')).toBe('2026-12');
    expect(at('2026-12-29T00:00:00Z')).toBe('2027-01');
    expect(at('2027-01-31T15:00:00Z')).toBe('2027-02');
    expect(at('2027-02-26T00:00:00Z')).toBe('2027-03');
    expect(at('2027-03-01T00:00:00Z')).toBe('2027-03');
    expect(at('2028-02-29T00:00:00Z')).toBe('2028-03');
  });

  test('PY-03 月末 23:59 に登録しても、翌月 0:00 に登録しても、自動課金の開始は「今」より先の1日', async () => {
    for (const [now, start] of [
      [jst('2026-10-31', '23:59'), '2026-11'],
      [jst('2026-11-01', '00:00'), '2026-12'],
      [jst('2026-12-31', '23:59'), '2027-01'],
    ] as const) {
      const { f, student: s, actor } = await student({ now });
      await startCardRegistration(f.ctx, actor, s.id);
      await handlePaymentEvent(f.ctx, setupDone(s.id, f.gateway.cardSetups[0]!.id));
      const sub = subsOf(f, s.id)[0]!;
      expect(sub.startAt).toEqual(billingAnchor(start));
      expect(sub.startAt.getTime()).toBeGreaterThan(now.getTime());
    }
  });
});

describe('14. 同時に届く', () => {
  test('OP-02 登録の通知と照合が同時に走っても、自動課金は1つ', async () => {
    const { f, student: s, actor } = await student();
    await startCardRegistration(f.ctx, actor, s.id);
    const id = f.gateway.cardSetups[0]!.id;
    f.gateway.cardSetupStatuses.set(id, { status: 'complete', paymentMethodId: 'pm_x' });
    await Promise.all([handlePaymentEvent(f.ctx, setupDone(s.id, id)), reconcilePayments(f.ctx)]);
    expect(subsOf(f, s.id)).toHaveLength(1);
  });

  test('PY-05 同じ支払いの2つの画面の通知が同時に届いても、回数は1回分', async () => {
    const { f, student: s, actor } = await student();
    await prepareMonth(f.ctx, '2026-10');
    const [a, b] = await twoSessions(f, actor, s.id);
    await Promise.all([handlePaymentEvent(f.ctx, paid(a!.paymentId, a!.id)), handlePaymentEvent(f.ctx, paid(b!.paymentId, b!.id))]);
    expect(await balance(f.db, s.id, '2026-10')).toBe(4);
    expect(subsOf(f, s.id)).toHaveLength(1);
  });
});

describe('ほかの変則的な流れ', () => {
  test('ST-04 / 5.2 ほかの家庭の生徒の支払いの画面は開けない（見つからない扱い）', async () => {
    const { f, student: s } = await student({ method: 'paypay' });
    await prepareMonth(f.ctx, '2026-10');
    const other = await f.mkStudent('次郎');
    await expect(startMonthlyPayment(f.ctx, other.actor, s.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(startCardRegistration(f.ctx, other.actor, s.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  test('ST-05 休会・退会した生徒は、支払いの画面を開けず、カードの登録も求められない', async () => {
    for (const status of ['suspended', 'withdrawn'] as const) {
      const { f, student: s, actor } = await student({ method: 'konbini' });
      await prepareMonth(f.ctx, '2026-10');
      await changeStudentStatus(f.ctx, f.admin, s.id, status, { immediately: true });
      await expect(startMonthlyPayment(f.ctx, actor, s.id)).rejects.toThrow('お支払いが必要な請求はありません');
      await updateStudent(f.ctx, f.admin, s.id, { billingMethod: 'card' }).catch(() => undefined);
      await expect(startCardRegistration(f.ctx, actor, s.id)).rejects.toThrow();
    }
  });

  test('PY-16 コンビニ払いの請求は、未払いのあいだ「未払い」と出し（確認中にしない）、画面を開ける', async () => {
    const { f, student: s, actor } = await student({ method: 'konbini' });
    await prepareMonth(f.ctx, '2026-10');
    const home = await studentHome(f.ctx, actor, s.id);
    expect(home).toMatchObject({ payment: 'unpaid', paymentLinkAvailable: true, cardPaymentDue: false, needsCard: false });
  });

  test('OP-02 期限が切れた画面は、照合でも失敗として扱い、生徒は作り直せる', async () => {
    const { f, student: s, actor, monthly } = await student({ method: 'paypay', now: jst('2026-10-01', '00:10') });
    await prepareMonth(f.ctx, '2026-10');
    const c = f.gateway.checkouts[0]!;
    f.gateway.checkoutStatuses.set(c.id, { status: 'failed', paymentMethodId: null });
    f.clock.now = jst('2026-10-02', '10:00');
    await reconcilePayments(f.ctx);
    expect((await monthly('2026-10'))!.status).toBe('failed');
    await startMonthlyPayment(f.ctx, actor, s.id);
    expect(f.gateway.checkouts.at(-1)!.replaces).toBe(c.id);
    expect((await monthly('2026-10'))!.status).toBe('pending');
  });
});
