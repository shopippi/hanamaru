import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import {
  changePassword,
  login,
  logout,
  requestPasswordReset,
  setPasswordWithToken,
  startMfaSetup,
  verifyMfa,
} from '../domain/auth.js';
import { DomainError } from '../domain/errors.js';
import {
  body,
  clearSessionCookie,
  cookieName,
  PORTALS,
  requireAuth,
  setSessionCookie,
  type AppDeps,
  type Env,
  type Portal,
} from './app.js';

// ログイン・ログアウト・パスワード再設定・二段階認証（3.1）。3つのポータルで共通

const loginBody = z.object({ email: z.string().max(200), password: z.string().max(200) });

export function authRoutes(deps: AppDeps, portal: Portal) {
  const app = new Hono<Env>();
  const { ctx } = deps;

  app.post('/login', async (c) => {
    const input = await body(c, loginBody);
    const result = await login(ctx, PORTALS[portal], input.email, input.password);
    await setSessionCookie(c, deps, portal, result.token, result.expiresAt);
    return c.json({ mfa: result.mfa, displayName: result.account.displayName });
  });

  app.post('/logout', async (c) => {
    const token = getCookie(c, cookieName(portal));
    if (token) await logout(ctx, token);
    clearSessionCookie(c, portal);
    return c.json({ ok: true });
  });

  app.get('/me', requireAuth(deps, portal, { allowMfaPending: true }), (c) => {
    const { account, session } = c.get('auth');
    return c.json({
      id: account.id,
      email: account.email,
      displayName: account.displayName,
      role: account.role,
      mfaPending: session.mfaPending,
      totpEnabled: account.totpEnabled,
    });
  });

  // パスワード再設定のリンクを送る（AU-03）。アカウントの有無によらず同じ応答
  app.post('/password-reset', async (c) => {
    const input = await body(c, z.object({ email: z.string().max(200), captchaToken: z.string().optional() }));
    if (!(await deps.captcha.verify(input.captchaToken, c.req.header('cf-connecting-ip')))) {
      throw new DomainError('validation', '確認に失敗しました。もう一度お試しください');
    }
    await requestPasswordReset(ctx, PORTALS[portal], input.email);
    return c.json({ ok: true });
  });

  // 招待リンク・再設定リンクからパスワードを設定する（ST-01、AU-03）
  app.post('/password', async (c) => {
    const input = await body(c, z.object({ token: z.string().max(200), password: z.string() }));
    const account = await setPasswordWithToken(ctx, input.token, input.password);
    if (account.role !== PORTALS[portal]) throw new DomainError('not_found', 'このリンクは無効です');
    return c.json({ ok: true });
  });

  app.post('/password/change', requireAuth(deps, portal), async (c) => {
    const input = await body(c, z.object({ currentPassword: z.string(), newPassword: z.string() }));
    await changePassword(ctx, c.get('auth'), input.currentPassword, input.newPassword);
    return c.json({ ok: true });
  });

  if (portal === 'manage') {
    // 管理者の二段階認証（AU-06）
    app.post('/mfa/setup', requireAuth(deps, portal, { allowMfaPending: true }), async (c) => {
      return c.json(await startMfaSetup(ctx, c.get('auth')));
    });
    app.post('/mfa/verify', requireAuth(deps, portal, { allowMfaPending: true }), async (c) => {
      const input = await body(c, z.object({ code: z.string().max(20) }));
      const expiresAt = await verifyMfa(ctx, c.get('auth'), input.code);
      const token = getCookie(c, cookieName(portal))!;
      await setSessionCookie(c, deps, portal, token, expiresAt);
      return c.json({ ok: true });
    });
  }

  return app;
}
