import type {
  CheckoutRequest,
  CheckoutStatus,
  InvoiceStatus,
  PaymentEvent,
  PaymentGateway,
} from '../src/domain/payment-gateway.js';

/** テスト用の Stripe。呼ばれた内容を記録し、状態をテストから操作できる */
export class FakeGateway implements PaymentGateway {
  seq = 0;
  customers: { id: string; studentId: string }[] = [];
  checkouts: (CheckoutRequest & { id: string; url: string })[] = [];
  prices: { id: string; amount: number }[] = [];
  subscriptions: { id: string; customerId: string; priceId: string; startAt: Date; cancelAtPeriodEnd: boolean; paymentMethodId: string | null }[] = [];
  checkoutStatuses = new Map<string, CheckoutStatus>();
  invoices = new Map<string, InvoiceStatus>();

  private next(prefix: string) {
    return `${prefix}_${++this.seq}`;
  }
  async createCustomer(input: { studentId: string }) {
    const id = this.next('cus');
    this.customers.push({ id, studentId: input.studentId });
    return id;
  }
  async createCheckout(req: CheckoutRequest) {
    const id = this.next('cs');
    const url = `https://checkout.stripe.test/${id}`;
    this.checkouts.push({ ...req, id, url });
    return { id, url };
  }
  async createMonthlyPrice(input: { amount: number }) {
    const id = this.next('price');
    this.prices.push({ id, amount: input.amount });
    return id;
  }
  async createSubscription(input: { customerId: string; priceId: string; startAt: Date; paymentMethodId: string | null }) {
    const id = this.next('sub');
    this.subscriptions.push({ id, ...input, cancelAtPeriodEnd: false });
    return id;
  }
  async changeSubscriptionPrice(subscriptionId: string, priceId: string) {
    this.subscriptions.find((s) => s.id === subscriptionId)!.priceId = priceId;
  }
  async cancelSubscriptionAtPeriodEnd(subscriptionId: string) {
    this.subscriptions.find((s) => s.id === subscriptionId)!.cancelAtPeriodEnd = true;
  }
  async billingPortalUrl(customerId: string) {
    return `https://billing.stripe.test/${customerId}`;
  }
  async checkoutStatus(sessionId: string) {
    return this.checkoutStatuses.get(sessionId) ?? { status: 'open' as const, paymentMethodId: null };
  }
  async findSubscriptionInvoice(subscriptionId: string, periodStart: Date) {
    return this.invoices.get(`${subscriptionId}:${periodStart.toISOString()}`) ?? null;
  }
  /** テストでは本文に PaymentEvent の JSON をそのまま入れ、署名は "valid" だけを通す */
  async parseWebhook(rawBody: string, signature: string): Promise<PaymentEvent | null> {
    if (signature !== 'valid') throw new Error('invalid signature');
    const ev = JSON.parse(rawBody);
    if (ev.periodStart) ev.periodStart = new Date(ev.periodStart);
    return ev;
  }
}
