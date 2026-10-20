import { serve } from '@hono/node-server';
import { z } from 'zod';
import { connect } from './db/client.js';
import type { Ctx } from './domain/context.js';
import { ConsoleEmailTransport, EmailChannel, NotificationService } from './domain/notify.js';
import { StaticCaptcha, TurnstileVerifier } from './http/captcha.js';
import { createApp } from './http/index.js';
import { runJobs } from './domain/jobs.js';
import { StripeGateway } from './integrations/stripe.js';

// API サーバーの起動。設定はすべて環境変数から読む（秘密情報はリポジトリに入れない: 7.2）

const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    PORT: z.coerce.number().default(3000),
    STUDENT_URL: z.string().url().default('http://localhost:5173'),
    STAFF_URL: z.string().url().default('http://localhost:5174'),
    MANAGE_URL: z.string().url().default('http://localhost:5175'),
    /** 未設定なら確認を飛ばす（開発用）。本番では必ず設定する */
    TURNSTILE_SECRET: z.string().optional(),
    COOKIE_SECURE: z.enum(['true', 'false']).default('true'),
    STRIPE_SECRET_KEY: z.string().min(1),
    STRIPE_WEBHOOK_SECRET: z.string().min(1),
    STRIPE_PORTAL_CONFIGURATION_ID: z.string().optional(),
    /** 定期処理の間隔（分）。0 なら動かさない */
    JOB_INTERVAL_MINUTES: z.coerce.number().default(5),
  })
  .parse(process.env);

if (env.STRIPE_SECRET_KEY.startsWith('sk_live_') && process.env.NODE_ENV !== 'production') {
  // 本番のキーを検証環境・開発環境で使わない（7.3）
  throw new Error('live Stripe key outside production');
}

const { db } = await connect(env.DATABASE_URL);

const ctx: Ctx = {
  db,
  now: () => new Date(),
  // メール送信サービスは未選定（8.2）。決まるまでは標準出力に書く
  notifier: new NotificationService(db, [new EmailChannel(new ConsoleEmailTransport())]),
  payments: new StripeGateway(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET, env.STRIPE_PORTAL_CONFIGURATION_ID),
  urls: { student: env.STUDENT_URL, staff: env.STAFF_URL, manage: env.MANAGE_URL },
};

if (!env.STRIPE_PORTAL_CONFIGURATION_ID && process.env.NODE_ENV === 'production') {
  // 解約の操作がないカード管理画面の設定がないと、生徒が解約できてしまう（PY-13）
  throw new Error('STRIPE_PORTAL_CONFIGURATION_ID is required in production');
}

if (!env.TURNSTILE_SECRET) {
  // フォームのボット対策（NF-06）を本番で外さない。検証環境は Turnstile のテスト用キーを使う
  if (process.env.NODE_ENV === 'production') throw new Error('TURNSTILE_SECRET is required in production');
  console.warn('TURNSTILE_SECRET is not set: captcha checks are disabled');
}

const app = createApp({
  ctx,
  captcha: env.TURNSTILE_SECRET ? new TurnstileVerifier(env.TURNSTILE_SECRET) : new StaticCaptcha(true),
  secureCookies: env.COOKIE_SECURE === 'true',
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => console.log(`api listening on :${info.port}`));

// 定期処理（月初の請求、失効・繰越、猶予切れ、照合、リマインド）。重ならないように順番に流す
if (env.JOB_INTERVAL_MINUTES > 0) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runJobs(ctx);
    } finally {
      running = false;
    }
  };
  setInterval(tick, env.JOB_INTERVAL_MINUTES * 60_000);
  void tick();
}
