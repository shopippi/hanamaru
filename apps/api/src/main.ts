import { serve } from '@hono/node-server';
import { z } from 'zod';
import { connect } from './db/client.js';
import type { Ctx } from './domain/context.js';
import { ConsoleEmailTransport, EmailChannel, NotificationService } from './domain/notify.js';
import { StaticCaptcha, TurnstileVerifier } from './http/captcha.js';
import { createApp } from './http/index.js';

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
  })
  .parse(process.env);

const { db } = await connect(env.DATABASE_URL);

const ctx: Ctx = {
  db,
  now: () => new Date(),
  // メール送信サービスは未選定（8.2）。決まるまでは標準出力に書く
  notifier: new NotificationService(db, [new EmailChannel(new ConsoleEmailTransport())]),
  urls: { student: env.STUDENT_URL, staff: env.STAFF_URL, manage: env.MANAGE_URL },
};

if (!env.TURNSTILE_SECRET) console.warn('TURNSTILE_SECRET is not set: captcha checks are disabled');

const app = createApp({
  ctx,
  captcha: env.TURNSTILE_SECRET ? new TurnstileVerifier(env.TURNSTILE_SECRET) : new StaticCaptcha(true),
  secureCookies: env.COOKIE_SECURE === 'true',
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => console.log(`api listening on :${info.port}`));
