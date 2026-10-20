import Stripe from 'stripe';

// Stripe の初期設定（1回だけ実行する）。
//   STRIPE_SECRET_KEY=sk_test_... pnpm --filter @hanamaru/api exec tsx scripts/stripe-setup.ts
// 出力された ID を STRIPE_PORTAL_CONFIGURATION_ID に設定する。
//
// - カスタマーポータル: カードの変更と請求履歴だけを出し、解約の操作は出さない（MB-04、PY-13）
// - 支払い方法（カード、コンビニ、PayPay）はダッシュボードの「支払い方法」で有効にする
// - Webhook の送信先: https://<APIのホスト>/api/stripe/webhook
//   イベント: checkout.session.completed, checkout.session.async_payment_succeeded,
//   checkout.session.async_payment_failed, checkout.session.expired, invoice.paid, invoice.payment_failed

const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error('STRIPE_SECRET_KEY is required');
if (key.startsWith('sk_live_') && process.env.CONFIRM_LIVE !== 'yes') {
  throw new Error('本番のキーです。作成者が実行する場合だけ CONFIRM_LIVE=yes を付けてください（7.3）');
}

const stripe = new Stripe(key);
const config = await stripe.billingPortal.configurations.create({
  business_profile: { headline: 'はなまる音楽教室 お支払い方法の管理' },
  features: {
    payment_method_update: { enabled: true },
    invoice_history: { enabled: true },
    customer_update: { enabled: true, allowed_updates: ['email'] },
    subscription_cancel: { enabled: false },
    subscription_update: { enabled: false },
  },
});
console.log(`STRIPE_PORTAL_CONFIGURATION_ID=${config.id}`);
