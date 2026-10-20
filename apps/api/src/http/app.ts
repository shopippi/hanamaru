import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { randomBytes } from 'node:crypto';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { authenticate, type Authenticated } from '../domain/auth.js';
import type { Actor, Ctx, Role } from '../domain/context.js';
import { DomainError } from '../domain/errors.js';
import { healthy } from '../domain/system.js';
import type { Db } from '../db/client.js';
import type { CaptchaVerifier } from './captcha.js';

// HTTP の入口。業務ルールは domain/ にあり、ここは入出力の変換と認証だけを行う（2章の4、6）

export interface AppDeps {
  ctx: Ctx;
  captcha: CaptchaVerifier;
  /** 本番は true（Cookie を HTTPS のときだけ送る） */
  secureCookies: boolean;
}

export type Env = {
  Variables: { auth: Authenticated; actor: Actor };
};

/** ポータルごとに Cookie を分ける（4.4: ログイン情報が画面ごとに分かれ、混ざらない） */
export const PORTALS = { student: 'student', staff: 'teacher', manage: 'admin' } as const satisfies Record<string, Role>;
export type Portal = keyof typeof PORTALS;
export const cookieName = (portal: Portal) => `hm_${portal}`;

const STATUS: Record<DomainError['code'], 400 | 401 | 403 | 404 | 409 | 422> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rule: 422,
};

export function errorResponse(c: Context, e: unknown) {
  if (e instanceof DomainError) {
    return c.json({ error: e.message, code: e.code, details: e.code === 'validation' || e.code === 'conflict' ? e.details : undefined }, STATUS[e.code]);
  }
  // 想定外のエラー（OP-09）。短いエラー番号を画面に出し、同じ番号でログに残す。問い合わせのときに番号で探せる
  const errorId = randomBytes(4).toString('hex');
  console.error(`[error ${errorId}] ${c.req.method} ${c.req.path}`, e);
  return c.json({ error: `エラーが発生しました。時間をおいてもう一度お試しください（エラー番号: ${errorId}）`, code: 'internal', errorId }, 500);
}

/** JSON の本文をそのまま読む（検証は domain 側で行う） */
export async function rawBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new DomainError('validation', '送信内容を読み取れませんでした');
  }
}

/** 入力を検証する。誤りは 400 と欄ごとの理由（UI-16） */
export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new DomainError('validation', '送信内容を読み取れませんでした');
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new DomainError('validation', r.error.issues[0]?.message ?? '入力に誤りがあります', r.error.issues);
  return r.data;
}

export function query<T extends z.ZodType>(c: Context, schema: T): z.output<T> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw new DomainError('validation', r.error.issues[0]?.message ?? '入力に誤りがあります', r.error.issues);
  return r.data;
}

export const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は 2026-10-20 の形で指定してください');
export const monthParam = z.string().regex(/^\d{4}-\d{2}$/, '月は 2026-10 の形で指定してください');
export const isoDateTime = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

export async function setSessionCookie(c: Context, deps: AppDeps, portal: Portal, token: string, expiresAt: Date) {
  setCookie(c, cookieName(portal), token, {
    httpOnly: true,
    secure: deps.secureCookies,
    sameSite: 'Lax',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(c: Context, portal: Portal) {
  deleteCookie(c, cookieName(portal), { path: '/' });
}

/** ログイン必須（ST-06）。ロールが違うポータルは拒否する（AU-01、URL-05） */
export function requireAuth(deps: AppDeps, portal: Portal, opts: { allowMfaPending?: boolean } = {}): MiddlewareHandler<Env> {
  return async (c, next) => {
    const auth = await authenticate(deps.ctx, PORTALS[portal], getCookie(c, cookieName(portal)));
    if (!auth) return c.json({ error: 'ログインしてください', code: 'login_required' }, 401);
    if (auth.session.mfaPending && !opts.allowMfaPending) {
      return c.json({ error: '二段階認証を完了してください', code: 'mfa_required' }, 401);
    }
    c.set('auth', auth);
    c.set('actor', { kind: 'account', accountId: auth.account.id, role: auth.account.role });
    await next();
  };
}

/**
 * 状態を変えるリクエストは JSON に限る。フォーム送信を使ったなりすまし（CSRF）を防ぐ。
 * Cookie は SameSite=Lax で、JSON のリクエストは別サイトから送るとブラウザが事前確認する。
 */
const jsonOnly: MiddlewareHandler = async (c, next) => {
  const m = c.req.method;
  // 本文のない DELETE はそのまま通す。DELETE は別サイトからはブラウザの事前確認なしに送れない
  const bodyless = m === 'DELETE' && !c.req.header('content-type') && !Number(c.req.header('content-length') ?? 0) && !c.req.header('transfer-encoding');
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS' && !bodyless) {
    const type = c.req.header('content-type') ?? '';
    if (!type.startsWith('application/json')) {
      return c.json({ error: '送信形式が正しくありません', code: 'validation' }, 415);
    }
  }
  await next();
};

export function createBaseApp(db?: Db): Hono<Env> {
  const app = new Hono<Env>();
  app.onError((e, c) => errorResponse(c, e));
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/stripe/')) return next(); // Stripe の通知は署名で検証する
    return jsonOnly(c, next);
  });
  // 送られてくる本文の大きさの上限。講師の写真だけは大きめ（設定の上限 20MB を base64 にした大きさ）まで受け付ける
  const tooLarge = (c: Context) => c.json({ error: '送信する内容が大きすぎます', code: 'validation' }, 413);
  const normalLimit = bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge });
  const photoLimit = bodyLimit({ maxSize: 30 * 1024 * 1024, onError: tooLarge });
  app.use('/api/*', (c, next) => (c.req.path.endsWith('/photo') ? photoLimit(c, next) : normalLimit(c, next)));
  // ヘルスチェック（OP-08）。データベースに問い合わせられなければ 503。外部の死活監視からも使う
  app.get('/api/health', async (c) => {
    if (db && !(await healthy(db))) return c.json({ ok: false, error: 'database' }, 503);
    return c.json({ ok: true });
  });
  app.use('/api/*', async (c, next) => {
    await next();
    // 写真など、返す側でキャッシュの指定をしたものはそのまま
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  });
  return app;
}

/** 講師の写真を返す（TC-06）。URL に更新日時が付くので、ブラウザに1日置いてよい。本人のログインが要るので private */
export function photoResponse(c: Context, photo: { contentType: string; data: Buffer; updatedAt: Date }) {
  const etag = `"${photo.updatedAt.getTime()}"`;
  const headers = { ETag: etag, 'Cache-Control': 'private, max-age=86400' };
  if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers);
  return c.body(new Uint8Array(photo.data), 200, { ...headers, 'Content-Type': photo.contentType, 'X-Content-Type-Options': 'nosniff' });
}
