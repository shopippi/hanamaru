import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { MANAGE, STAFF, STUDENT, login, loginAdmin } from './helpers.js';

// アクセシビリティの自動検査（UI-05・UI-19、WCAG 2.1 AA）。
// axe で主な画面を調べ、重い（serious）・とても重い（critical）違反があれば失敗にする。
// 目で見る確認や、画面の読み上げでの操作の確認の代わりにはならない（docs/verification.md）。

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** 理由があって検査から外すもの。必ず理由を書く */
const DISABLED_RULES: string[] = [];

async function violations(page: Page, name: string) {
  // 読み込み中の表示（スケルトン）が消えてから調べる
  await page.locator('[aria-busy="true"]').first().waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
  const result = await new AxeBuilder({ page }).withTags(TAGS).disableRules(DISABLED_RULES).analyze();
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${name}: ${v.id}（${v.impact}）${v.help} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' / ')}`);
}

test('UI-19 / UI-05 ログインなどの画面に、重いアクセシビリティの違反がない', async ({ page }) => {
  const found: string[] = [];
  for (const [base, path] of [
    [STUDENT, '/login'],
    [STUDENT, '/register'],
    [STUDENT, '/trial'],
    [STUDENT, '/reset-password'],
    [STAFF, '/login'],
    [MANAGE, '/login'],
  ] as const) {
    await page.goto(base + path);
    await page.locator('main h1').first().waitFor();
    found.push(...(await violations(page, base.slice(-4) + path)));
  }
  expect(found).toEqual([]);
});

test('UI-19 / UI-05 生徒の画面に、重いアクセシビリティの違反がない', async ({ page }) => {
  await login(page, STUDENT, 'parent@example.test');
  const found: string[] = [];
  for (const path of ['/', '/book', '/reservations', '/teachers']) {
    await page.goto(STUDENT + path);
    await page.locator('main h1, main .big-number').first().waitFor();
    found.push(...(await violations(page, `student${path}`)));
  }
  // 確認画面（ダイアログ）を開いた状態も
  await page.goto(STUDENT + '/book');
  await page.locator('.slot-grid .choice').first().click();
  await page.getByRole('dialog').waitFor();
  found.push(...(await violations(page, 'student/book(dialog)')));
  expect(found).toEqual([]);
});

test('UI-19 / UI-05 入会手続きの画面に、重いアクセシビリティの違反がない', async ({ page }) => {
  await login(page, STUDENT, 'maruko@example.test');
  await page.goto(STUDENT + '/enroll');
  await page.locator('main h1').first().waitFor();
  expect(await violations(page, 'student/enroll')).toEqual([]);
});

test('UI-19 / UI-05 講師の画面に、重いアクセシビリティの違反がない', async ({ page }) => {
  await login(page, STAFF, 'teacher@example.test');
  const found: string[] = [];
  for (const path of ['/', '/students', '/availability', '/reviews', '/profile']) {
    await page.goto(STAFF + path);
    await page.locator('main h1').first().waitFor();
    found.push(...(await violations(page, `staff${path}`)));
  }
  expect(found).toEqual([]);
});

test('UI-19 / UI-05 管理の画面に、重いアクセシビリティの違反がない', async ({ page }) => {
  await loginAdmin(page);
  const found: string[] = [];
  for (const path of ['/', '/calendar', '/students', '/teachers', '/payments', '/charges', '/trials', '/pricing', '/school-hours', '/closures', '/settings', '/audit', '/system']) {
    await page.goto(MANAGE + path);
    await page.locator('main h1').first().waitFor();
    found.push(...(await violations(page, `manage${path}`)));
  }
  // スマホのメニュー（引き出し）を開いた状態も
  const menu = page.getByRole('button', { name: 'メニューを開く' });
  if (await menu.isVisible()) {
    await menu.click();
    found.push(...(await violations(page, 'manage(drawer)')));
  }
  expect(found).toEqual([]);
});
