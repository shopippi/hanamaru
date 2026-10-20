import { expect, type Page } from '@playwright/test';

export const STUDENT = 'http://127.0.0.1:5173';
export const STAFF = 'http://127.0.0.1:5174';
export const MANAGE = 'http://127.0.0.1:5175';
export const API = 'http://127.0.0.1:3000';

export async function login(page: Page, base: string, email: string) {
  await page.goto(`${base}/login`);
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('パスワード').fill('password');
  await page.getByRole('button', { name: 'ログイン' }).click();
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
