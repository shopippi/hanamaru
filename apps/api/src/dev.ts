import { serve } from '@hono/node-server';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
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
import { addDays, dateOf, monthOf, weekdayOf } from './lib/time.js';

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
  /** カードの登録だけの画面 */
  setups = new Map<string, { studentId: string; successUrl: string; cancelUrl: string; status: 'open' | 'complete' }>();
  async createCustomer() {
    return `cus_dev_${++this.seq}`;
  }
  async createCheckout(req: CheckoutRequest) {
    const id = `cs_dev_${++this.seq}`;
    this.sessions.set(id, { ...req, status: 'open' });
    return { id, url: `${API_ORIGIN}/dev/checkout/${id}` };
  }
  async createCardSetup(input: { studentId: string; successUrl: string; cancelUrl: string }) {
    const id = `cs_dev_setup_${++this.seq}`;
    this.setups.set(id, { ...input, status: 'open' });
    return { id, url: `${API_ORIGIN}/dev/checkout/${id}` };
  }
  async cardSetupStatus(id: string) {
    return { status: this.setups.get(id)?.status === 'complete' ? ('complete' as const) : ('open' as const), paymentMethodId: 'pm_dev' };
  }
  async createMonthlyPrice() {
    return `price_dev_${++this.seq}`;
  }
  async createSubscription() {
    return `sub_dev_${++this.seq}`;
  }
  async changeSubscriptionPrice() {}
  async cancelSubscriptionAtPeriodEnd() {}
  async resumeSubscription() {}
  async findLiveSubscription() {
    return null;
  }
  async voidInvoice() {}
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
  // 教室の受付時間（AV-06）の見本: 前後の約4か月、月〜金 10:00〜21:00、土 10:00〜18:00、日曜は休み
  const hours: { date: string; startTime: string; endTime: string }[] = [];
  for (let d = addDays(dateOf(now), -30); d < addDays(dateOf(now), 120); d = addDays(d, 1)) {
    const wd = weekdayOf(d);
    if (wd !== 0) hours.push({ date: d, startTime: '10:00', endTime: wd === 6 ? '18:00' : '21:00' });
  }
  await db.insert(schema.schoolHours).values(hours);
  // 教室の実際のレッスン（見本のデータ。本番では管理画面で登録する）
  const [piano] = await db
    .insert(schema.lessonTypes)
    .values({ name: 'ポピュラーピアノ（対面）60分', kind: 'private', durationMinutes: 60, capacity: 1 })
    .returning();
  const [pianoOnline] = await db
    .insert(schema.lessonTypes)
    .values({ name: 'ポピュラーピアノ（オンライン）60分', kind: 'private', durationMinutes: 60, capacity: 1, online: true })
    .returning();
  const [drum] = await db.insert(schema.lessonTypes).values({ name: 'ドラム（対面）60分', kind: 'private', durationMinutes: 60, capacity: 1 }).returning();
  const [trial] = await db.insert(schema.lessonTypes).values({ name: '体験レッスン 30分', kind: 'private', durationMinutes: 30, capacity: 1 }).returning();
  const [room1] = await db.insert(schema.rooms).values({ name: 'レッスン室1' }).returning();

  const mkTeacher = async (slug: string, name: string, email: string) => {
    const a = await mkAccount('teacher', email, name);
    return (await db.insert(schema.teachers).values({ accountId: a.id, name, profileSlug: slug }).returning())[0]!;
  };
  const tA = await mkTeacher('matsuda', '松田 悠義', 'teacher@example.test');
  // 2人目は講師の切り替え（TC-02）を試すための見本
  const tB = await mkTeacher('sample-guitar', '見本 次郎', 'teacher2@example.test');
  for (const wd of [1, 2, 3, 4, 5]) {
    await db.insert(schema.availabilityRules).values({ teacherId: tA.id, weekday: wd, startTime: '15:00', endTime: '20:00', lessonTypeId: piano!.id, roomId: room1!.id });
    await db.insert(schema.availabilityRules).values({ teacherId: tA.id, weekday: wd, startTime: '20:00', endTime: '22:00', lessonTypeId: pianoOnline!.id });
  }
  await db.insert(schema.availabilityRules).values({ teacherId: tA.id, weekday: 6, startTime: '10:00', endTime: '12:00', lessonTypeId: drum!.id, roomId: room1!.id });
  await db.insert(schema.availabilityRules).values({ teacherId: tA.id, weekday: 6, startTime: '13:00', endTime: '14:30', lessonTypeId: trial!.id, forTrial: true });
  for (const wd of [2, 4]) {
    await db.insert(schema.availabilityRules).values({ teacherId: tB.id, weekday: wd, startTime: '16:00', endTime: '20:00', lessonTypeId: drum!.id });
  }

  // 料金表（レギュラーレッスン、サブスク月額制）。入会金はなし。5回目からは +5,000円で1回ずつ
  const admin = { kind: 'system' as const };
  const plans = [
    { n: 1, amount: 6000 },
    { n: 2, amount: 11000 },
    { n: 3, amount: 15000 },
    { n: 4, amount: 20000 },
    { n: 5, amount: 25000 },
  ];
  const courseOf = new Map<number, Awaited<ReturnType<typeof createCourse>>>();
  for (const p of plans) courseOf.set(p.n, await createCourse(ctx, admin, { name: `1h×月${p.n}回コース`, lessonsPerMonth: p.n, amount: p.amount }));
  // 入会のときは最初の月の月謝だけを払う（4回を最初に出す）
  for (const [i, n] of [4, 3, 2, 1, 5].entries()) {
    const p = plans.find((x) => x.n === n)!;
    await savePackage(ctx, admin, null, { name: `1h×月${n}回（最初の月）`, admissionFee: 0, lessonCount: n, lessonsPrice: p.amount, sortOrder: i + 1 });
  }
  const course = courseOf.get(4)!;

  // 見本の生徒は2人。家庭（ログイン）は別々なので、ほかの生徒の情報は見えない（5.2）
  const parent = await mkAccount('student', 'parent@example.test', '山田 はな子');
  const mkStudent = async (name: string, values: Partial<typeof schema.students.$inferInsert>, teacherIds: string[], credits = 0) => {
    const [s] = await db
      .insert(schema.students)
      .values({ accountId: parent.id, name, status: 'active', courseId: course.id, billingMethod: 'card', stripeCustomerId: `cus_${name}`, stripeSubscriptionId: `sub_${name}`, ...values })
      .returning();
    for (const t of teacherIds) await db.insert(schema.studentTeachers).values({ studentId: s!.id, teacherId: t });
    if (credits) await db.insert(schema.creditLedger).values({ studentId: s!.id, month, delta: credits, reason: 'grant_monthly', note: '見本' });
    return s!;
  };
  await mkStudent('山田 はな太郎', { phone: '090-0000-0001', address: '東京都千代田区1-1', teacherNote: '左手の練習を重点的に' }, [tA.id, tB.id], 4);
  // 入会手続き中の見本（入会の流れを試す）
  const maruko = await mkAccount('student', 'maruko@example.test', '田中 まる子');
  const [m] = await db.insert(schema.students).values({ accountId: maruko.id, name: '田中 まる子', status: 'enrolling', courseId: course.id }).returning();
  await db.insert(schema.studentTeachers).values({ studentId: m!.id, teacherId: tA.id });
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
  const setup = gateway.setups.get(c.req.param('id'));
  if (setup) {
    return c.html(`<!doctype html><meta name="viewport" content="width=device-width"><title>テストのカード登録</title>
    <body style="font-family:sans-serif;max-width:480px;margin:40px auto;padding:0 16px">
    <h1>カードの登録（開発用）</h1><p>本番では Stripe のカード登録画面が開きます。支払いは発生しません。</p>
    <form method="post"><button style="font-size:18px;padding:12px 24px">テストのカードを登録する</button></form>
    <p><a href="${setup.cancelUrl}">戻る</a></p></body>`);
  }
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
  const setup = gateway.setups.get(id);
  if (setup) {
    setup.status = 'complete';
    await handlePaymentEvent(ctx, { id: `evt_${id}`, type: 'card_registered', studentId: setup.studentId, sessionId: id, paymentMethodId: 'pm_dev' });
    return c.redirect(setup.successUrl);
  }
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
// 開発用の管理者の確認コード。画面の通しテストでは何度もログインし、時計も戻すので、
// 同じコードの使い回しの防止（AU-06）を開発用の管理者だけ毎回解除してから返す
dev.get('/totp', async (c) => {
  await db.update(schema.accounts).set({ totpLastStep: null }).where(eq(schema.accounts.email, 'admin@example.test'));
  return c.text(totpCode(ADMIN_TOTP_SECRET, ctx.now()));
});
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
  console.log('ログイン: 生徒 parent@example.test（入会手続き中は maruko@example.test） / 講師 teacher@example.test / 管理 admin@example.test（パスワードはすべて password）');
  console.log(`管理者の確認コード: ${API_ORIGIN}/dev/totp`);
});
