import { expect, test } from '@playwright/test';
import { STUDENT, login } from './helpers.js';

test('ST-06 ログインしていなければログイン画面に移る', async ({ page }) => {
  await page.goto(`${STUDENT}/reservations`);
  await expect(page).toHaveURL(/\/login\?next=%2Freservations/);
  await expect(page.getByRole('heading', { name: '生徒ログイン' })).toBeVisible();
});

test('AU-02 ログインの誤りは共通のメッセージ', async ({ page }) => {
  await page.goto(`${STUDENT}/login`);
  await page.getByLabel('メールアドレス').fill('parent@example.test');
  await page.getByLabel('パスワード').fill('wrong-password');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await expect(page.getByRole('alert')).toContainText('メールアドレスまたはパスワードが正しくありません');
});

test('MB-01 / RS-01 / RS-04 / UI-15 トップで状況が分かり、予約してキャンセルできる', async ({ page }) => {
  await login(page, STUDENT, 'parent@example.test');
  const remaining = page.locator('.big-number');
  await expect(remaining).toBeVisible();
  const before = Number((await remaining.innerText()).replace(/\D/g, ''));
  await expect(page.getByText('次の予約')).toBeVisible();
  await expect(page.getByText(/お支払い状況/)).toBeVisible();

  await page.getByRole('link', { name: '予約する' }).first().click();
  await page.locator('.slot-grid .choice').first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('この内容で予約しますか')).toBeVisible();
  await dialog.getByRole('button', { name: '予約する' }).click();
  // サーバーで確定してから「予約しました」と出す（UI-14）
  await expect(page.getByText('予約しました')).toBeVisible();
  await expect(page).toHaveURL(/\/reservations/);

  await page.getByRole('button', { name: /の予約をキャンセル/ }).first().click();
  await expect(page.getByRole('dialog').getByText(/回数を1回お戻しします|回数は戻りません/)).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'キャンセルする' }).click();
  await expect(page.getByText(/キャンセルしました/)).toBeVisible();

  await page.getByRole('link', { name: 'ホーム' }).click();
  await expect(remaining).toHaveText(new RegExp(`^${before}`));
});

test('ST-04 保護者は子どもを切り替えられる', async ({ page }) => {
  await login(page, STUDENT, 'parent@example.test');
  await page.getByRole('button', { name: '山田 さくら' }).click();
  await expect(page.getByRole('button', { name: '山田 さくら' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('表示中の生徒')).toHaveText('山田 さくら');
  await page.getByRole('button', { name: '山田 太郎' }).click();
});

test('TC-05 担当講師のプロフィールを見られる', async ({ page }) => {
  await login(page, STUDENT, 'parent@example.test');
  await page.getByRole('link', { name: '講師' }).click();
  await expect(page.getByRole('heading', { name: '見本 花子' })).toBeVisible();
});

test('PW-04 電波がないときは案内を出し、予約できない', async ({ page, context }) => {
  await login(page, STUDENT, 'parent@example.test');
  await page.getByRole('link', { name: '予約する' }).first().click();
  await expect(page.locator('.slot-grid .choice').first()).toBeEnabled();
  await context.setOffline(true);
  await expect(page.getByText('オフラインです。電波のある場所で開き直してください')).toBeVisible();
  await expect(page.locator('.slot-grid .choice').first()).toBeDisabled();
  await context.setOffline(false);
});

test('PW-01 / PW-02 ホーム画面アプリの設定', async ({ request }) => {
  const manifest = await (await request.get(`${STUDENT}/manifest.webmanifest`)).json();
  expect(manifest).toMatchObject({ display: 'standalone', background_color: '#ffffff', start_url: '/', lang: 'ja' });
  for (const icon of manifest.icons) expect((await request.get(`${STUDENT}${icon.src}`)).ok()).toBe(true);
  expect((await request.get(`${STUDENT}/sw.js`)).ok()).toBe(true);
});
