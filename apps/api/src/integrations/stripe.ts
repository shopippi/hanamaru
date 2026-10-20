import Stripe from 'stripe';
import type {
  CheckoutRequest,
  CheckoutStatus,
  InvoiceStatus,
  PaymentEvent,
  PaymentGateway,
} from '../domain/payment-gateway.js';
import { billingMonthOf } from '../lib/time.js';

// Stripe（Checkout、Billing、カスタマーポータル、Webhook）の実装（6.1）。
// 検証環境では必ずテストモードのキー（sk_test_）を使う（7.3）。

const unix = (d: Date) => Math.floor(d.getTime() / 1000);
const idOf = (x: string | { id: string } | null | undefined) => (typeof x === 'string' ? x : (x?.id ?? null));

/** こちらで扱う Stripe の通知の種類。Webhook の送信先にはこれだけを登録する（scripts/stripe-setup.ts） */
export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.payment_action_required',
] as const satisfies readonly Stripe.WebhookEndpointCreateParams.EnabledEvent[];

export class StripeGateway implements PaymentGateway {
  private readonly stripe: Stripe;

  constructor(
    secretKey: string,
    private readonly webhookSecret: string,
    /** 解約の操作を出さないカスタマーポータルの設定（scripts/stripe-setup.ts で作る） */
    private readonly portalConfigurationId: string | undefined,
    /** 接続先の差し替え（検証用の stripe-mock など）。本番では指定しない */
    connection?: Pick<Stripe.StripeConfig, 'host' | 'port' | 'protocol'>,
  ) {
    this.stripe = new Stripe(secretKey, { ...connection });
  }

  async createCustomer(input: { name: string; email: string | null; studentId: string }): Promise<string> {
    const c = await this.stripe.customers.create(
      { name: input.name, email: input.email ?? undefined, metadata: { studentId: input.studentId } },
      { idempotencyKey: `customer-${input.studentId}` },
    );
    return c.id;
  }

  async createCheckout(req: CheckoutRequest): Promise<{ id: string; url: string }> {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        customer: req.customerId,
        locale: 'ja',
        // 支払い方法は Stripe のダッシュボードで有効にしたもの（カード、コンビニ、PayPay）から絞り込む。
        // カードを選ぶと、対応端末では Apple Pay・Google Pay も表示される（PY-04）
        allowed_payment_method_types: [req.method],
        line_items: [
          {
            quantity: 1,
            price_data: { currency: 'jpy', unit_amount: req.amount, product_data: { name: req.description } },
          },
        ],
        payment_intent_data: {
          metadata: { paymentId: req.paymentId },
          ...(req.saveCard ? { setup_future_usage: 'off_session' as const } : {}),
        },
        ...(req.method === 'konbini' ? { payment_method_options: { konbini: { expires_after_days: 7 } } } : {}),
        metadata: { paymentId: req.paymentId },
        success_url: req.successUrl,
        cancel_url: req.cancelUrl,
      },
      { idempotencyKey: `checkout-${req.paymentId}` },
    );
    if (!session.url) throw new Error('checkout session has no url');
    return { id: session.id, url: session.url };
  }

  async createCardSetup(input: { customerId: string; studentId: string; successUrl: string; cancelUrl: string }): Promise<{ id: string; url: string }> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'setup',
      customer: input.customerId,
      locale: 'ja',
      currency: 'jpy',
      allowed_payment_method_types: ['card'],
      setup_intent_data: { metadata: { studentId: input.studentId } },
      metadata: { studentId: input.studentId, purpose: 'card_setup' },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    if (!session.url) throw new Error('checkout session has no url');
    return { id: session.id, url: session.url };
  }

  async cardSetupStatus(sessionId: string): Promise<{ status: 'complete' | 'open' | 'expired'; paymentMethodId: string | null }> {
    const s = await this.stripe.checkout.sessions.retrieve(sessionId, { expand: ['setup_intent'] });
    const si = typeof s.setup_intent === 'object' ? s.setup_intent : null;
    if (s.status === 'complete' && si?.status === 'succeeded') return { status: 'complete', paymentMethodId: idOf(si.payment_method) };
    if (s.status === 'expired') return { status: 'expired', paymentMethodId: null };
    return { status: 'open', paymentMethodId: null };
  }

  async createMonthlyPrice(input: { coursePriceId: string; courseName: string; amount: number }): Promise<string> {
    const price = await this.stripe.prices.create(
      {
        currency: 'jpy',
        unit_amount: input.amount,
        recurring: { interval: 'month' },
        product_data: { name: input.courseName },
        metadata: { coursePriceId: input.coursePriceId },
      },
      { idempotencyKey: `price-${input.coursePriceId}` },
    );
    return price.id;
  }

  async createSubscription(input: {
    customerId: string;
    priceId: string;
    startAt: Date;
    paymentMethodId: string | null;
    studentId: string;
  }): Promise<string> {
    if (input.paymentMethodId) {
      await this.stripe.customers.update(input.customerId, {
        invoice_settings: { default_payment_method: input.paymentMethodId },
      });
    }
    // 翌月1日までは無料期間にして、1日に初回の課金をする（日割りなし。PY-03）。
    // startAt は UTC でも1日になる時刻（billingAnchor）なので、以後の課金日も毎月1日になる
    const sub = await this.stripe.subscriptions.create(
      {
        customer: input.customerId,
        items: [{ price: input.priceId }],
        trial_end: unix(input.startAt),
        proration_behavior: 'none',
        ...(input.paymentMethodId ? { default_payment_method: input.paymentMethodId } : {}),
        metadata: { studentId: input.studentId },
      },
      // 通知の再送で二重に作らない
      { idempotencyKey: `subscription-${input.studentId}-${unix(input.startAt)}` },
    );
    return sub.id;
  }

  async changeSubscriptionPrice(subscriptionId: string, priceId: string): Promise<void> {
    const sub = await this.stripe.subscriptions.retrieve(subscriptionId);
    const item = sub.items.data[0];
    if (!item) throw new Error(`subscription ${subscriptionId} has no items`);
    await this.stripe.subscriptions.update(subscriptionId, {
      items: [{ id: item.id, price: priceId }],
      proration_behavior: 'none',
    });
  }

  async cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
  }

  async resumeSubscription(subscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: false });
  }

  async findLiveSubscription(customerId: string, studentId: string): Promise<string | null> {
    const list = await this.stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 20 });
    const live = list.data.find(
      (s) =>
        s.metadata?.studentId === studentId &&
        !s.cancel_at_period_end &&
        (s.status === 'trialing' || s.status === 'active' || s.status === 'past_due' || s.status === 'unpaid' || s.status === 'incomplete'),
    );
    return live?.id ?? null;
  }

  async voidInvoice(invoiceId: string): Promise<void> {
    await this.stripe.invoices.voidInvoice(invoiceId);
  }

  async billingPortalUrl(customerId: string, returnUrl: string): Promise<string> {
    // 既定のカード管理画面は解約ができてしまうため、専用の設定がなければ開かない（PY-13）
    if (!this.portalConfigurationId) throw new Error('STRIPE_PORTAL_CONFIGURATION_ID is not set (run scripts/stripe-setup.ts)');
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
      locale: 'ja',
      configuration: this.portalConfigurationId,
    });
    return session.url;
  }

  async checkoutStatus(sessionId: string): Promise<CheckoutStatus> {
    const s = await this.stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] });
    const pi = typeof s.payment_intent === 'object' ? s.payment_intent : null;
    if (s.payment_status === 'paid') return { status: 'paid', paymentMethodId: idOf(pi?.payment_method) };
    if (s.status === 'expired' || pi?.status === 'canceled') return { status: 'failed', paymentMethodId: null };
    return { status: 'open', paymentMethodId: null };
  }

  async findSubscriptionInvoice(subscriptionId: string, month: string): Promise<InvoiceStatus | null> {
    const list = await this.stripe.invoices.list({ subscription: subscriptionId, limit: 12 });
    const inv = list.data.find((i) => {
      const start = i.lines.data[0]?.period.start;
      return start !== undefined && i.amount_due > 0 && billingMonthOf(new Date(start * 1000)) === month;
    });
    if (!inv?.id) return null;
    const status: InvoiceStatus['status'] =
      inv.status === 'paid'
        ? 'paid'
        : inv.status === 'uncollectible' || inv.status === 'void' || (inv.attempt_count ?? 0) > 0
          ? 'failed'
          : 'open';
    return { invoiceId: inv.id, status, amount: inv.amount_due, hostedUrl: inv.hosted_invoice_url ?? null };
  }

  async parseWebhook(rawBody: string, signature: string): Promise<PaymentEvent | null> {
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const s = event.data.object;
        // カードの登録だけの画面（PY-03）
        if (s.mode === 'setup' && s.metadata?.purpose === 'card_setup' && s.metadata.studentId) {
          const siId = idOf(s.setup_intent);
          const si = siId ? await this.stripe.setupIntents.retrieve(siId) : null;
          if (si?.status !== 'succeeded') return null;
          return { id: event.id, type: 'card_registered', studentId: s.metadata.studentId, sessionId: s.id, paymentMethodId: idOf(si.payment_method) };
        }
        const paymentId = s.metadata?.paymentId;
        // コンビニ払いは、店頭で支払うまで completed でも未入金（PY-16）
        if (!paymentId || s.payment_status !== 'paid') return null;
        let paymentMethodId: string | null = null;
        const piId = idOf(s.payment_intent);
        if (piId) paymentMethodId = idOf((await this.stripe.paymentIntents.retrieve(piId)).payment_method);
        return { id: event.id, type: 'checkout_paid', paymentId, sessionId: s.id, paymentMethodId };
      }
      case 'checkout.session.async_payment_failed':
      case 'checkout.session.expired': {
        const s = event.data.object;
        const paymentId = s.metadata?.paymentId;
        if (!paymentId) return null;
        return { id: event.id, type: 'checkout_failed', paymentId, sessionId: s.id };
      }
      case 'customer.subscription.deleted': {
        return { id: event.id, type: 'subscription_deleted', subscriptionId: event.data.object.id };
      }
      case 'invoice.paid':
      case 'invoice.payment_failed':
      // 自動課金で本人認証（3-D セキュア）が求められた: 生徒の操作が要るので、失敗と同じにお知らせする（PY-11）
      case 'invoice.payment_action_required': {
        const inv = event.data.object;
        const subscriptionId = idOf(inv.parent?.subscription_details?.subscription);
        const start = inv.lines.data[0]?.period.start;
        if (!subscriptionId || !inv.id || start === undefined) return null;
        const base = { id: event.id, subscriptionId, invoiceId: inv.id, periodStart: new Date(start * 1000) };
        return event.type === 'invoice.paid'
          ? { ...base, type: 'invoice_paid', amount: inv.amount_paid }
          : { ...base, type: 'invoice_failed', amount: inv.amount_due, hostedUrl: inv.hosted_invoice_url ?? null };
      }
      default:
        return null;
    }
  }
}
