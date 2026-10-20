import { serve } from '@hono/node-server';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import * as schema from './db/schema.js';
import pg from 'pg';
import { connect, MIGRATIONS_DIR, type Db } from './db/client.js';
import type { Ctx } from './domain/context.js';
import { ConsoleEmailTransport, EmailChannel, NotificationService } from './domain/notify.js';
import type { CheckoutRequest, PaymentEvent, PaymentGateway } from './domain/payment-gateway.js';
import { handlePaymentEvent, createCourse, savePackage } from './domain/billing.js';
import { runJobs } from './domain/jobs.js';
import { StaticCaptcha } from './http/captcha.js';
import { createApp } from './http/index.js';
import { hashPassword, totpCode } from './lib/crypto.js';
import { monthOf } from './lib/time.js';

// 開発・画面確認用のサーバー。本番では使わない。
// - DB はメモリ上の PostgreSQL（PGlite）。DATABASE_URL を指定すると、手元の PostgreSQL を空にして使う
//   （消してよい DB だけ。localhost 以外は DEV_ALLOW_RESET=1 がないと拒否する）。起動のたびにダミーデータを入れ直す
// - 時計を進められる（POST /dev/clock）。月末・月初の処理を手元で確かめるため
// - 送ったメールを GET /dev/mails で見られる
// - Stripe は使わず、決済画面の代わりに「テストで支払う」ボタンの画面を出す
// - メールは標準出力に書く
//   pnpm --filter @hanamaru/api dev:local

const PORT = Number(process.env.PORT ?? 3000);
/** 画面を開くホスト名。Cookie はホストごとなので、ブラウザで開く名前に合わせる */
const HOST = process.env.DEV_HOST ?? 'localhost';
const API_ORIGIN = `http://${HOST}:${PORT}`;
const ADMIN_TOTP_SECRET = 'JBSWY3DPEHPK3PXP'; // 開発用の固定値

class DevGateway implements PaymentGateway {
  seq = 0;
  sessions = new Map<string, CheckoutRequest & { status: 'open' | 'paid' }>();
  async createCustomer() {
    return `cus_dev_${++this.seq}`;
  }
  async createCheckout(req: CheckoutRequest) {
    const id = `cs_dev_${++this.seq}`;
    this.sessions.set(id, { ...req, status: 'open' });
    return { id, url: `${API_ORIGIN}/dev/checkout/${id}` };
  }
  async createMonthlyPrice() {
    return `price_dev_${++this.seq}`;
  }
  async createSubscription() {
    return `sub_dev_${++this.seq}`;
  }
  async changeSubscriptionPrice() {}
  async cancelSubscriptionAtPeriodEnd() {}
  async billingPortalUrl(_customerId: string, returnUrl: string) {
    return `${API_ORIGIN}/dev/portal?return=${encodeURIComponent(returnUrl)}`;
  }
  async checkoutStatus(id: string) {
    return { status: this.sessions.get(id)?.status === 'paid' ? ('paid' as const) : ('open' as const), paymentMethodId: 'pm_dev' };
  }
  async findSubscriptionInvoice() {
    return null;
  }
  async parseWebhook(): Promise<PaymentEvent | null> {
    return null;
  }
}

async function seed(db: Db, ctx: Ctx) {
  const pw = await hashPassword('password');
  const now = ctx.now();
  const month = monthOf(now);
  const mkAccount = async (role: 'student' | 'teacher' | 'admin', email: string, displayName: string, extra = {}) =>
    (await db.insert(schema.accounts).values({ role, email, displayName, passwordHash: pw, ...extra }).returning())[0]!;

  await mkAccount('admin', 'admin@example.test', '松田', { totpSecret: ADMIN_TOTP_SECRET, totpEnabled: true });
  const [piano] = await db.insert(schema.lessonTypes).values({ name: '個人 45分', kind: 'private', durationMinutes: 45, capacity: 1 }).returning();
  const [group] = await db.insert(schema.lessonTypes).values({ name: 'グループ 60分', kind: 'group', durationMinutes: 60, capacity: 4 }).returning();
  const [room1] = await db.insert(schema.rooms).values({ name: 'レッスン室1' }).returning();

  const mkTeacher = async (slug: string, name: string, email: string) => {
    const a = await mkAccount('teacher', email, name);
    return (await db.insert(schema.teachers).values({ accountId: a.id, name, profileSlug: slug }).returning())[0]!;
  };
  const tA = await mkTeacher('sample-piano', '見本 花子', 'teacher@example.test');
  const tB = await mkTeacher('sample-guitar', '見本 次郎', 'teacher2@example.test');
  for (const wd of [1, 2, 3, 4, 5]) {
    await db.insert(schema.availabilityRules).values({ teacherId: tA.id, weekday: wd, startTime: '15:00', endTime: '19:30', lessonTypeId: piano!.id, roomId: room1!.id });
  }
  await db.insert(schema.availabilityRules).values({ teacherId: tA.id, weekday: 6, startTime: '10:00', endTime: '12:00', lessonTypeId: group!.id });
  await db.insert(schema.availabilityRules).values({ teacherId: tA.id, weekday: 6, startTime: '13:00', endTime: '14:30', lessonTypeId: piano!.id, forTrial: true });
  for (const wd of [2, 4]) {
    await db.insert(schema.availabilityRules).values({ teacherId: tB.id, weekday: wd, startTime: '16:00', endTime: '20:00', lessonTypeId: piano!.id });
  }

  const admin = { kind: 'system' as const };
  const course = await createCourse(ctx, admin, { name: '月4回コース', lessonsPerMonth: 4, amount: 14300 });
  await createCourse(ctx, admin, { name: '月2回コース', lessonsPerMonth: 2, amount: 7700 });
  await savePackage(ctx, admin, null, { name: '入会金＋4回', admissionFee: 5500, lessonCount: 4, lessonsPrice: 14300, sortOrder: 1 });
  await savePackage(ctx, admin, null, { name: '入会金＋2回', admissionFee: 5500, lessonCount: 2, lessonsPrice: 7700, sortOrder: 2 });

  const parent = await mkAccount('student', 'parent@example.test', '山田 花子');
  const mkStudent = async (name: string, values: Partial<typeof schema.students.$inferInsert>, teacherIds: string[], credits = 0) => {
    const [s] = await db
      .insert(schema.students)
      .values({ accountId: parent.id, name, status: 'active', courseId: course.id, billingMethod: 'card', stripeCustomerId: `cus_${name}`, stripeSubscriptionId: `sub_${name}`, ...values })
      .returning();
    for (const t of teacherIds) await db.insert(schema.studentTeachers).values({ studentId: s!.id, teacherId: t });
    if (credits) await db.insert(schema.creditLedger).values({ studentId: s!.id, month, delta: credits, reason: 'grant_monthly', note: '見本' });
    return s!;
  };
  await mkStudent('山田 太郎', { phone: '090-0000-0001', address: '東京都千代田区1-1', teacherNote: '左手の練習を重点的に' }, [tA.id, tB.id], 4);
  await mkStudent('山田 さくら', { phone: '090-0000-0002' }, [tA.id], 2);
  const solo = await mkAccount('student', 'new@example.test', '佐藤 一郎');
  await db.insert(schema.students).values({ accountId: solo.id, name: '佐藤 一郎', status: 'enrolling', courseId: course.id });
}

async function openDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    const client = new PGlite();
    await migrate(drizzle(client, { schema }), { migrationsFolder: MIGRATIONS_DIR });
    return drizzle(client, { schema }) as unknown as Db;
  }
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) && process.env.DEV_ALLOW_RESET !== '1') {
    throw new Error('開発用サーバーは DB を空にします。localhost 以外の DB には DEV_ALLOW_RESET=1 が必要です');
  }
  const pool = new pg.Pool({ connectionString: url });
  await pool.query('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;');
  await pool.end();
  return (await connect(url)).db;
}

const db = await openDb();
let clockOffsetMs = 0;
const mails: { to: string; subject: string; text: string; at: string }[] = [];
const console_ = new ConsoleEmailTransport();

const gateway = new DevGateway();
const ctx: Ctx = {
  db,
  now: () => new Date(Date.now() + clockOffsetMs),
  notifier: new NotificationService(db, [
    new EmailChannel({
      send: async (m) => {
        mails.push({ ...m, at: new Date(Date.now() + clockOffsetMs).toISOString() });
        await console_.send(m);
      },
    }),
  ]),
  payments: gateway,
  urls: { student: `http://${HOST}:5173`, staff: `http://${HOST}:5174`, manage: `http://${HOST}:5175` },
};
await seed(db, ctx);

const app = createApp({ ctx, captcha: new StaticCaptcha(true), secureCookies: false });

// --- 開発用の画面（決済の代わり・二段階認証のコード） ---
const dev = new Hono();
dev.get('/checkout/:id', (c) => {
  const s = gateway.sessions.get(c.req.param('id'));
  if (!s) return c.text('not found', 404);
  return c.html(`<!doctype html><meta name="viewport" content="width=device-width"><title>テスト決済</title>
    <body style="font-family:sans-serif;max-width:480px;margin:40px auto;padding:0 16px">
    <h1>テスト決済（開発用）</h1><p>${s.description}<br><strong>${s.amount.toLocaleString('ja-JP')}円</strong>（${s.method}）</p>
    <form method="post"><button style="font-size:18px;padding:12px 24px">テストで支払う</button></form>
    <p><a href="${s.cancelUrl}">戻る</a></p></body>`);
});
dev.post('/checkout/:id', async (c) => {
  const id = c.req.param('id');
  const s = gateway.sessions.get(id);
  if (!s) return c.text('not found', 404);
  s.status = 'paid';
  await handlePaymentEvent(ctx, { id: `evt_${id}`, type: 'checkout_paid', paymentId: s.paymentId, sessionId: id, paymentMethodId: 'pm_dev' });
  return c.redirect(s.successUrl);
});
dev.get('/portal', (c) =>
  c.html(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;max-width:480px;margin:40px auto;padding:0 16px">
  <h1>カード管理（開発用）</h1><p>本番では Stripe のカード管理画面が開きます。解約の操作は出ません。</p><p><a href="${c.req.query('return')}">戻る</a></p></body>`),
);
dev.get('/totp', (c) => c.text(totpCode(ADMIN_TOTP_SECRET, ctx.now())));
dev.post('/jobs', async (c) => c.json(await runJobs(ctx)));
// 時計を進める（月末・月初の処理の確認用）。{ "at": "2026-11-01T00:10:00+09:00" }。null で元に戻す
dev.post('/clock', async (c) => {
  const { at } = (await c.req.json()) as { at: string | null };
  clockOffsetMs = at ? new Date(at).getTime() - Date.now() : 0;
  return c.json({ now: ctx.now() });
});
dev.get('/clock', (c) => c.json({ now: ctx.now() }));
dev.get('/mails', (c) => c.json(mails));
app.route('/dev', dev);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`dev api on ${API_ORIGIN}`);
  console.log('ログイン: 生徒 parent@example.test / 講師 teacher@example.test / 管理 admin@example.test（パスワードはすべて password）');
  console.log(`管理者の確認コード: ${API_ORIGIN}/dev/totp`);
});
