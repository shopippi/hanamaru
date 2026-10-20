import { expect, test } from '@playwright/test';
import { API, MANAGE, STAFF, adminNav, login, loginAdmin, mails } from './helpers.js';

test('AU-01 講師のアカウントは管理画面に入れない', async ({ page }) => {
  await login(page, MANAGE, 'teacher@example.test');
  await expect(page.getByRole('alert')).toContainText('正しくありません');
});

test('SR-06 講師には住所が表示されず、講師用備考を書ける', async ({ page }) => {
  await login(page, STAFF, 'teacher@example.test');
  await expect(page.getByRole('heading', { name: '担当レッスン' })).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: '担当生徒', exact: true }).click();
  await page.getByRole('link', { name: '山田 はな太郎' }).click();
  await expect(page.getByLabel('講師用備考')).toHaveValue(/左手/);
  await expect(page.getByText('千代田区')).toHaveCount(0);
});

test('AV-01 講師の空き時間の画面', async ({ page }) => {
  await login(page, STAFF, 'teacher@example.test');
  await page.getByRole('navigation').getByRole('link', { name: '空き時間', exact: true }).click();
  // カレンダーで日ごとに決め（AV-07）、毎週の型も持てる
  await expect(page.locator('.cal-title')).toBeVisible();
  await page.getByRole('button', { name: '毎週の型' }).click();
  await expect(page.getByRole('heading', { name: /曜日ごとの空き時間/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存する' })).toBeDisabled();
});

test('AU-06 / DB-01 管理者は二段階認証のあとダッシュボードを見られる', async ({ page }) => {
  await loginAdmin(page);
  await expect(page.getByText('生徒の人数')).toBeVisible();
  await page.getByRole('link', { name: /在籍中/ }).click();
  await expect(page).toHaveURL(/status=active/);
  await expect(page.getByRole('link', { name: '山田 はな太郎' })).toBeVisible();
});

test('3.8 設定を変えて保存できる', async ({ page }) => {
  await loginAdmin(page);
  await adminNav(page, '設定');
  const box = page.getByLabel('予約を管理者の承認制にする（承認まで「仮予約」）');
  const was = await box.isChecked();
  await box.setChecked(!was);
  await page.getByRole('button', { name: '設定を保存する' }).click();
  await expect(page.getByText('設定を保存しました')).toBeVisible();
  await box.setChecked(was);
  await page.getByRole('button', { name: '設定を保存する' }).click();
  await expect(page.getByText('設定を保存しました').first()).toBeVisible();
});

test('OP-06 / OP-08 届けられなかった通知を、システムの状態の画面から送り直せる', async ({ page }) => {
  const email = `e2e-${Date.now()}@example.test`;
  const failing = (on: boolean) => fetch(`${API}/dev/mail-failure`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ failing: on }) });
  await failing(true);
  try {
    const r = await fetch(`${API}/api/student/trial/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '通知 テスト', email, captchaToken: 'ok' }),
    });
    expect(r.status).toBe(201);
  } finally {
    await failing(false);
  }
  await loginAdmin(page);
  await adminNav(page, 'システムの状態');
  await expect(page.getByRole('heading', { name: 'システムの状態', level: 1 })).toBeVisible();
  const row = page.getByRole('listitem').filter({ hasText: email });
  await expect(row).toContainText('自動で送り直します');
  await row.getByRole('button', { name: '再送' }).click();
  await expect(page.getByText('通知を送り直しました')).toBeVisible();
  await expect(row).toHaveCount(0);
  expect((await mails()).some((m) => m.to === email && m.subject.includes('体験レッスンのお申込'))).toBe(true);
});
