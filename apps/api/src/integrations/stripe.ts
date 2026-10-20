import Stripe from 'stripe';
import type {
  CheckoutRequest,
  CheckoutStatus,
  InvoiceStatus,
  PaymentEvent,
  PaymentGateway,
} from '../domain/payment-gateway.js';

// Stripe（Checkout、Billing、カスタマーポータル、Webhook）の実装（6.1）。
// 検証環境では必ずテストモードのキー（sk_test_）を使う（7.3）。

const unix = (d: Date) => Math.floor(d.getTime() / 1000);
const idOf = (x: string | { id: string } | null | undefined) => (typeof x === 'string' ? x : (x?.id ?? null));

export class StripeGateway implements PaymentGateway {
  private readonly stripe: Stripe;

  constructor(
    secretKey: string,
    private readonly webhookSecret: string,
    /** 解約の操作を出さないカスタマーポータルの設定（scripts/stripe-setup.ts で作る） */
    private readonly portalConfigurationId: string | undefined,
  ) {
    this.stripe = new Stripe(secretKey);
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
    // 翌月1日までは無料期間にして、1日に初回の課金をする（日割りなし。PY-03）
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

  async billingPortalUrl(customerId: string, returnUrl: string): Promise<string> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
      locale: 'ja',
      ...(this.portalConfigurationId ? { configuration: this.portalConfigurationId } : {}),
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

  async findSubscriptionInvoice(subscriptionId: string, periodStart: Date): Promise<InvoiceStatus | null> {
    const list = await this.stripe.invoices.list({ subscription: subscriptionId, limit: 12 });
    const inv = list.data.find((i) => i.lines.data[0]?.period.start === unix(periodStart) && i.amount_due > 0);
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
      case 'invoice.paid':
      case 'invoice.payment_failed': {
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
