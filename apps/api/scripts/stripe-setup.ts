import Stripe from 'stripe';
import { WEBHOOK_EVENTS } from '../src/integrations/stripe.js';

// Stripe の初期設定（1回だけ実行する）。
//   STRIPE_SECRET_KEY=sk_test_... WEBHOOK_URL=https://<APIのホスト>/api/stripe/webhook \
//     pnpm --filter @hanamaru/api exec tsx scripts/stripe-setup.ts
// 出力された値を STRIPE_PORTAL_CONFIGURATION_ID と STRIPE_WEBHOOK_SECRET に設定する。
//
// - カスタマーポータル: カードの変更と請求履歴だけを出し、解約の操作は出さない（MB-04、PY-13）
// - Webhook の送信先: こちらで扱う通知（WEBHOOK_EVENTS）だけを登録する（PY-05、OP-02）
// - 支払い方法（カード、コンビニ、PayPay）はダッシュボードの「支払い方法」で有効にする（docs/stripe-prelaunch.md）

const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error('STRIPE_SECRET_KEY is required');
if (key.startsWith('sk_live_') && process.env.CONFIRM_LIVE !== 'yes') {
  throw new Error('本番のキーです。作成者が実行する場合だけ CONFIRM_LIVE=yes を付けてください（7.3）');
}

// 検証用: STRIPE_MOCK_URL があれば stripe-mock に送る
const mock = process.env.STRIPE_MOCK_URL ? new URL(process.env.STRIPE_MOCK_URL) : null;
const stripe = new Stripe(
  key,
  mock ? { host: mock.hostname, port: Number(mock.port), protocol: mock.protocol.replace(':', '') as 'http' | 'https' } : {},
);

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

const url = process.env.WEBHOOK_URL;
if (url) {
  const endpoint = await stripe.webhookEndpoints.create({
    url,
    enabled_events: [...WEBHOOK_EVENTS],
    // 通知の形は API の版で変わる。SDK と同じ版に固定する（invoice.parent など）
    api_version: Stripe.API_VERSION,
    description: 'はなまる音楽教室 API',
  });
  console.log(`STRIPE_WEBHOOK_SECRET=${endpoint.secret}`);
} else {
  console.log('WEBHOOK_URL がないため、Webhook の送信先は作っていません');
}
