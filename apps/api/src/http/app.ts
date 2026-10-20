import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { authenticate, type Authenticated } from '../domain/auth.js';
import type { Actor, Ctx, Role } from '../domain/context.js';
import { DomainError } from '../domain/errors.js';
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
  console.error(e);
  return c.json({ error: 'エラーが発生しました。時間をおいてもう一度お試しください', code: 'internal' }, 500);
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
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
    const type = c.req.header('content-type') ?? '';
    if (!type.startsWith('application/json')) {
      return c.json({ error: '送信形式が正しくありません', code: 'validation' }, 415);
    }
  }
  await next();
};

export function createBaseApp(): Hono<Env> {
  const app = new Hono<Env>();
  app.onError((e, c) => errorResponse(c, e));
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/stripe/')) return next(); // Stripe の通知は署名で検証する
    return jsonOnly(c, next);
  });
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.get('/api/health', (c) => c.json({ ok: true }));
  return app;
}
