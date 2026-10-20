// 決済サービス（Stripe）とのやりとり。業務ルールからは、この形だけを使う。
// カード情報はこちらのサーバーを通らない（2章の7）: 決済は Stripe の決済画面、カードの変更は Stripe のカード管理画面で行う。

export type OnlineMethod = 'card' | 'konbini' | 'paypay';

export interface CheckoutRequest {
  customerId: string;
  /** こちらの payments.id。Stripe 側の metadata に入れ、通知で照合する */
  paymentId: string;
  amount: number;
  description: string;
  method: OnlineMethod;
  /** 入会時のカード払い: 次回から自動課金できるようカードを保存する（PY-03） */
  saveCard: boolean;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutStatus {
  status: 'paid' | 'open' | 'failed';
  paymentMethodId: string | null;
}

export interface InvoiceStatus {
  invoiceId: string;
  status: 'paid' | 'open' | 'failed';
  amount: number;
  hostedUrl: string | null;
}

/** Stripe の通知（Webhook）を、こちらで扱う形にしたもの。id は Stripe のイベントID */
export type PaymentEvent =
  | { id: string; type: 'checkout_paid'; paymentId: string; sessionId: string; paymentMethodId: string | null }
  | { id: string; type: 'checkout_failed'; paymentId: string; sessionId: string }
  | { id: string; type: 'invoice_paid'; subscriptionId: string; invoiceId: string; periodStart: Date; amount: number }
  /** サブスクリプションが終わった（月末で止めたものが終わった、Stripe の画面で解約されたなど） */
  | { id: string; type: 'subscription_deleted'; subscriptionId: string }
  | {
      id: string;
      type: 'invoice_failed';
      subscriptionId: string;
      invoiceId: string;
      periodStart: Date;
      amount: number;
      hostedUrl: string | null;
    };

export interface PaymentGateway {
  createCustomer(input: { name: string; email: string | null; studentId: string }): Promise<string>;
  createCheckout(req: CheckoutRequest): Promise<{ id: string; url: string }>;
  /** 月額コースの料金（毎月・税込・円）を Stripe の Price として用意する */
  createMonthlyPrice(input: { coursePriceId: string; courseName: string; amount: number }): Promise<string>;
  /** startAt（翌月1日 9:00。lib/time.ts の billingAnchor）から毎月課金するサブスクリプション。日割りなし（PY-03） */
  createSubscription(input: {
    customerId: string;
    priceId: string;
    startAt: Date;
    paymentMethodId: string | null;
    studentId: string;
  }): Promise<string>;
  /** 次回の課金から料金を変える（PY-14）。日割りなし */
  changeSubscriptionPrice(subscriptionId: string, priceId: string): Promise<void>;
  /** 今の期間（月末）で課金を止める（ST-05） */
  cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<void>;
  /** 月末で止める設定を取り消す（予定していた退会・休会を取りやめたとき） */
  resumeSubscription(subscriptionId: string): Promise<void>;
  /**
   * その生徒の、止めていない（月末で止める設定もしていない）サブスクリプション。なければ null。
   * 作成の途中で処理が失敗して再送されたときに、二重に作らないために使う
   */
  findLiveSubscription(customerId: string, studentId: string): Promise<string | null>;
  /** 未払いの請求を取り消す（現金で受け取った月のカードの請求など） */
  voidInvoice(invoiceId: string): Promise<void>;
  /** カード管理画面（MB-04）。解約の操作は出さない設定で作る（PY-13） */
  billingPortalUrl(customerId: string, returnUrl: string): Promise<string>;
  /** 通知が届かなかった場合の照合用（OP-02） */
  checkoutStatus(sessionId: string): Promise<CheckoutStatus>;
  /** その月（billingMonthOf で求めた月）の請求 */
  findSubscriptionInvoice(subscriptionId: string, month: string): Promise<InvoiceStatus | null>;
  /** 署名を確かめて通知を読む。扱わない種類なら null。署名が不正なら例外 */
  parseWebhook(rawBody: string, signature: string): Promise<PaymentEvent | null>;
}
