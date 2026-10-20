import { describe, expect, test } from 'vitest';
import Stripe from 'stripe';
import { StripeGateway, WEBHOOK_EVENTS } from '../src/integrations/stripe.js';
import { billingAnchor } from '../src/lib/time.js';

// Stripe の公式の模擬サーバー（stripe-mock）に、実装が送る呼び出しを1つずつ送り、
// 本物の API が受け付ける形（パラメータの名前・型・組み合わせ）になっているかを確かめる。
// stripe-mock は SDK と同じ版の API 定義で、受け付けないパラメータには 400 を返す。
// STRIPE_MOCK_URL（例: http://localhost:12111）があるときだけ動く。

const MOCK = process.env.STRIPE_MOCK_URL;
const WEBHOOK_SECRET = 'whsec_test_mock';

function gateway() {
  const url = new URL(MOCK!);
  return new StripeGateway('sk_test_mock', WEBHOOK_SECRET, 'bpc_test_mock', {
    host: url.hostname,
    port: Number(url.port),
    protocol: url.protocol.replace(':', '') as 'http' | 'https',
  });
}

/** 署名付きの通知（Webhook）を作る。署名は本物と同じ方式 */
function signed(type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({ id: `evt_${type}`, object: 'event', type, api_version: Stripe.API_VERSION, data: { object } });
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { payload, header };
}

describe.skipIf(!MOCK)('PY-01〜PY-16 Stripe の呼び出しが本物の API の形に合っている（stripe-mock）', () => {
  test('PY-03 / PY-04 入会・月謝の決済画面（カード・コンビニ・PayPay）', async () => {
    const gw = gateway();
    const customerId = await gw.createCustomer({ name: '山田 太郎', email: 'parent@example.test', studentId: 'stu_1' });
    expect(customerId).toMatch(/^cus_/);
    for (const method of ['card', 'konbini', 'paypay'] as const) {
      const s = await gw.createCheckout({
        customerId,
        paymentId: `pay_${method}`,
        amount: 19800,
        description: '入会金＋4回',
        method,
        saveCard: method === 'card',
        successUrl: 'https://student.example.test/?checkout=done',
        cancelUrl: 'https://student.example.test/',
      });
      expect(s.id).toMatch(/^cs_/);
      expect(s.url).toBeTruthy();
    }
  });

  test('PY-03 カードだけを登録する画面（setup モード）', async () => {
    const s = await gateway().createCardSetup({
      customerId: 'cus_mock',
      studentId: 'stu_1',
      successUrl: 'https://student.example.test/?card=done',
      cancelUrl: 'https://student.example.test/',
    });
    expect(s.id).toMatch(/^cs_/);
    const st = await gateway().cardSetupStatus(s.id);
    expect(['open', 'complete', 'expired']).toContain(st.status);
  });

  test('PY-03 / PY-14 / ST-05 月額の料金・サブスクリプションの作成と変更・停止・再開', async () => {
    const gw = gateway();
    const priceId = await gw.createMonthlyPrice({ coursePriceId: 'cp_1', courseName: '月4回コース', amount: 14300 });
    expect(priceId).toMatch(/^price_/);
    const subId = await gw.createSubscription({
      customerId: 'cus_mock',
      priceId,
      startAt: billingAnchor('2026-11'),
      paymentMethodId: 'pm_card_visa',
      studentId: 'stu_1',
    });
    expect(subId).toMatch(/^sub_/);
    await gw.changeSubscriptionPrice(subId, priceId);
    await gw.cancelSubscriptionAtPeriodEnd(subId);
    await gw.resumeSubscription(subId);
    await gw.findLiveSubscription('cus_mock', 'stu_1');
    await gw.voidInvoice('in_mock');
  });

  test('PY-05 Webhook の送信先には、こちらで扱う通知の種類だけを登録できる', async () => {
    const url = new URL(MOCK!);
    const stripe = new Stripe('sk_test_mock', { host: url.hostname, port: Number(url.port), protocol: 'http' });
    const endpoint = await stripe.webhookEndpoints.create({ url: 'https://api.example.test/api/stripe/webhook', enabled_events: [...WEBHOOK_EVENTS] });
    expect(endpoint.id).toMatch(/^we_/);
  });

  test('MB-04 / PY-13 カード管理画面と、通知が届かないときの照合（OP-02）', async () => {
    const gw = gateway();
    expect(await gw.billingPortalUrl('cus_mock', 'https://student.example.test/')).toMatch(/^https?:/);
    const st = await gw.checkoutStatus('cs_mock');
    expect(['paid', 'open', 'failed']).toContain(st.status);
    await gw.findSubscriptionInvoice('sub_mock', '2026-11');
  });

  test('PY-05 / OP-02 通知（Webhook）の読み取り: 署名を確かめ、こちらの形にする', async () => {
    const gw = gateway();
    const paid = signed('checkout.session.completed', {
      id: 'cs_1',
      object: 'checkout.session',
      mode: 'payment',
      payment_status: 'paid',
      payment_intent: 'pi_1',
      metadata: { paymentId: 'pay_1' },
    });
    expect(await gw.parseWebhook(paid.payload, paid.header)).toMatchObject({ type: 'checkout_paid', paymentId: 'pay_1', sessionId: 'cs_1' });

    const expired = signed('checkout.session.expired', { id: 'cs_2', object: 'checkout.session', mode: 'payment', metadata: { paymentId: 'pay_2' } });
    expect(await gw.parseWebhook(expired.payload, expired.header)).toMatchObject({ type: 'checkout_failed', paymentId: 'pay_2' });

    // カードの登録（setup モード）。登録の結果は SetupIntent を問い合わせて確かめる
    const setup = signed('checkout.session.completed', {
      id: 'cs_3',
      object: 'checkout.session',
      mode: 'setup',
      setup_intent: 'seti_1',
      metadata: { studentId: 'stu_1', purpose: 'card_setup' },
    });
    await gw.parseWebhook(setup.payload, setup.header);

    const deleted = signed('customer.subscription.deleted', { id: 'sub_1', object: 'subscription' });
    expect(await gw.parseWebhook(deleted.payload, deleted.header)).toMatchObject({ type: 'subscription_deleted', subscriptionId: 'sub_1' });

    // 月謝の請求。今の API では、サブスクリプションは parent.subscription_details に入る
    const periodStart = Math.floor(billingAnchor('2026-12').getTime() / 1000);
    const invoice = (type: string, extra: Record<string, unknown>) =>
      signed(type, {
        id: 'in_1',
        object: 'invoice',
        parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } },
        lines: { object: 'list', data: [{ id: 'il_1', object: 'line_item', period: { start: periodStart, end: periodStart + 2_678_400 } }] },
        ...extra,
      });
    const invPaid = invoice('invoice.paid', { amount_paid: 14300 });
    expect(await gw.parseWebhook(invPaid.payload, invPaid.header)).toMatchObject({
      type: 'invoice_paid',
      subscriptionId: 'sub_1',
      invoiceId: 'in_1',
      amount: 14300,
      periodStart: billingAnchor('2026-12'),
    });
    const invFailed = invoice('invoice.payment_failed', { amount_due: 14300, hosted_invoice_url: 'https://invoice.stripe.test/i/1' });
    expect(await gw.parseWebhook(invFailed.payload, invFailed.header)).toMatchObject({
      type: 'invoice_failed',
      hostedUrl: 'https://invoice.stripe.test/i/1',
    });

    const forged = signed('checkout.session.completed', { id: 'cs_x', object: 'checkout.session' });
    await expect(gw.parseWebhook(forged.payload, forged.header.replace(/v1=\w+/, 'v1=bad'))).rejects.toThrow();
  });
});
