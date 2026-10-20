import { expect, test } from '@playwright/test';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// PW-05: 画面の更新を公開したら、次に開いたときに自動で新しい版に切り替わる。
// 本番と同じ作り（Service Worker を含む）で確かめるため、ビルドして vite preview で配る

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SW = `${ROOT}apps/student/dist/sw.js`;
const PREVIEW = 'http://127.0.0.1:4173';
let server: ChildProcess;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  execSync('pnpm --filter @hanamaru/student build', { cwd: ROOT, stdio: 'ignore' });
  server = spawn('pnpm', ['--filter', '@hanamaru/student', 'exec', 'vite', 'preview', '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(PREVIEW)).ok) return;
    } catch {
      // まだ起動していない
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('vite preview did not start');
});

test.afterAll(() => {
  server?.kill();
});

test('PW-05 新しい版を公開すると、アプリを開き直したときに新しい版に切り替わる', async ({ page }) => {
  const v1 = /const VERSION = '([^']+)'/.exec(readFileSync(SW, 'utf8'))![1]!;
  await page.goto(`${PREVIEW}/login`);
  // Service Worker が画面を受け持つまで待つ
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await expect.poll(() => page.evaluate(() => caches.keys())).toContain(`hanamaru-student-${v1}`);

  // 新しい版を公開した（sw.js の版が変わった）
  writeFileSync(SW, readFileSync(SW, 'utf8').replace(`'${v1}'`, "'newrelease'"));
  await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));

  // アプリを裏に回して戻す（次に開いたとき）
  const reopen = () =>
    page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
  await reopen(); // 更新を確かめる → 新しい Service Worker が入る
  await expect
    .poll(async () => {
      await reopen().catch(() => {});
      return page.evaluate(() => (window as unknown as { marker?: number }).marker ?? 'reloaded').catch(() => 'navigating');
    }, { timeout: 15_000 })
    .toBe('reloaded');
  // 古い版の保存内容は消え、新しい版だけが残る
  await expect.poll(() => page.evaluate(() => caches.keys())).toEqual(['hanamaru-student-newrelease']);
  writeFileSync(SW, readFileSync(SW, 'utf8').replace("'newrelease'", `'${v1}'`));
});
