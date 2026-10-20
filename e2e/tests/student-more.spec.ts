import { expect, test } from '@playwright/test';
import { STUDENT, login } from './helpers.js';

test.describe('MB-05 アプリ内ブラウザ', () => {
  test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0' });
  test('Instagram などのアプリ内ブラウザでは Safari・Chrome で開くよう案内する', async ({ page }) => {
    await login(page, STUDENT, 'parent@example.test');
    await expect(page.getByText('SafariまたはChromeで開いてください')).toBeVisible();
  });
});

test('PY-03 / PY-05 / PW-06 入会の支払い後、アプリに戻って回数が付く', async ({ page }, info) => {
  // 入会は1人1回なので、片方の端末だけで流す
  test.skip(info.project.name !== 'iphone', '入会は1回だけ');
  await login(page, STUDENT, 'new@example.test');
  await page.getByRole('link', { name: '入会手続きへ進む' }).click();
  await expect(page.getByText('おすすめ')).toBeVisible();
  // 契約の内容と利用規約に同意するまで、支払いに進めない（PY-04）
  await expect(page.getByRole('button', { name: /を支払う/ })).toBeDisabled();
  await page.getByLabel('契約の内容と利用規約に同意します').check();
  await page.getByRole('button', { name: /を支払う/ }).click();
  // 開発用の決済画面（本番は Stripe の画面）
  await page.getByRole('button', { name: 'テストで支払う' }).click();
  await expect(page).toHaveURL(/checkout=done/);
  await expect(page.locator('.big-number')).toHaveText(/^4/);
});

test('TR-01 体験レッスンの申込', async ({ page }) => {
  await page.goto(`${STUDENT}/trial`);
  await page.getByLabel('お名前', { exact: true }).fill('体験 花子');
  await page.getByLabel('メールアドレス').fill('trial-e2e@example.test');
  await page.getByRole('button', { name: '申し込む' }).click();
  await expect(page.getByRole('heading', { name: 'お申込を受け付けました' })).toBeVisible();
});
