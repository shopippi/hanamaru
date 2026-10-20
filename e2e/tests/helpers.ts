import { expect, type Page } from '@playwright/test';

export const STUDENT = 'http://127.0.0.1:5173';
export const STAFF = 'http://127.0.0.1:5174';
export const MANAGE = 'http://127.0.0.1:5175';
export const API = 'http://127.0.0.1:3000';

export async function login(page: Page, base: string, email: string, password = 'password') {
  await page.goto(`${base}/login`);
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('パスワード').fill(password);
  await page.getByRole('button', { name: 'ログイン' }).click();
  // ログインの結果（画面の移動、二段階認証の画面、誤りの表示）が出るまで待つ
  await Promise.race([
    page.waitForURL((u) => !u.pathname.startsWith('/login')),
    page.getByLabel('確認コード（6桁）').waitFor(),
    page.getByRole('alert').waitFor(),
  ]);
}

export async function loginAdmin(page: Page) {
  await login(page, MANAGE, 'admin@example.test');
  const field = page.getByLabel('確認コード（6桁）');
  await expect(field).toBeVisible();
  const code = await (await fetch(`${API}/dev/totp`)).text();
  await field.fill(code);
  await page.getByRole('button', { name: '確認する' }).click();
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  at: string;
}

/** 開発用サーバーが送ったメール */
export async function mails(): Promise<Mail[]> {
  return (await fetch(`${API}/dev/mails`)).json() as Promise<Mail[]>;
}

/** 開発用サーバーの時計を動かす（null で元に戻す） */
export async function setClock(at: string | null) {
  await fetch(`${API}/dev/clock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ at }) });
}

export async function runJobs() {
  const r = await fetch(`${API}/dev/jobs`, { method: 'POST' });
  return r.json() as Promise<{ name: string; error?: string }[]>;
}
