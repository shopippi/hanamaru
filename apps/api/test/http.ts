import { eq } from 'drizzle-orm';
import { accounts } from '../src/db/schema.js';
import { hashPassword, totpCode } from '../src/lib/crypto.js';
import { StaticCaptcha } from '../src/http/captcha.js';
import { createApp } from '../src/http/index.js';
import type { Portal } from '../src/http/app.js';
import { setup } from './fixtures.js';

export const PASSWORD = 'correct-horse-1';

/** fixtures に HTTP の口を足す。ポータルごとに Cookie を持つブラウザを作れる */
export async function setupHttp(...args: Parameters<typeof setup>) {
  const f = await setup(...args);
  const captcha = { ok: true };
  const app = createApp({
    ctx: f.ctx,
    captcha: { verify: async () => captcha.ok },
    secureCookies: false,
  });

  const browser = (portal: Portal) => {
    const jar = new Map<string, string>();
    const call = async (method: string, path: string, json?: unknown) => {
      const headers: Record<string, string> = {};
      if (json !== undefined) headers['content-type'] = 'application/json';
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await app.request(`/api/${portal}${path}`, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
      });
      for (const sc of res.headers.getSetCookie()) {
        const [pair] = sc.split(';');
        const [k, v] = pair!.split('=');
        if (!v || /Max-Age=0|expires=Thu, 01 Jan 1970/i.test(sc)) jar.delete(k!);
        else jar.set(k!, v);
      }
      const text = await res.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      return { status: res.status, data, text };
    };
    return {
      jar,
      get: (path: string) => call('GET', path),
      post: (path: string, json: unknown = {}) => call('POST', path, json),
      put: (path: string, json: unknown) => call('PUT', path, json),
      patch: (path: string, json: unknown) => call('PATCH', path, json),
      del: (path: string) => call('DELETE', path, undefined),
      login: (email: string, password = PASSWORD) => call('POST', '/auth/login', { email, password }),
    };
  };

  /** パスワードを設定済みにする */
  const setPassword = async (accountId: string, password = PASSWORD) => {
    await f.db.update(accounts).set({ passwordHash: await hashPassword(password) }).where(eq(accounts.id, accountId));
  };

  /** 二段階認証まで済ませた管理者のブラウザ */
  const adminBrowser = async () => {
    await setPassword(f.adminAccount.id);
    const b = browser('manage');
    await b.login(f.adminAccount.email);
    const setupRes = await b.post('/auth/mfa/setup');
    await b.post('/auth/mfa/verify', { code: totpCode(setupRes.data.secret, f.clock.now) });
    return b;
  };

  return { ...f, app, browser, setPassword, adminBrowser, captcha, StaticCaptcha };
}
