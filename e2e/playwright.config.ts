import { defineConfig, devices } from '@playwright/test';

// 画面の通しテスト。開発用サーバー（メモリ上のDB・テスト用の決済）と3つの画面を起動して、
// iPhone（Safari 相当）と Android（Chrome 相当）の大きさで操作する（MB-08 の自動化できる部分）。
//   pnpm --filter @hanamaru/e2e e2e

const web = (app: string, port: number) => ({
  command: `pnpm --filter @hanamaru/${app} exec vite --port ${port} --strictPort --host 127.0.0.1`,
  url: `http://127.0.0.1:${port}`,
  reuseExistingServer: !process.env.CI,
  timeout: 60_000,
});

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'list' : 'line',
  use: { locale: 'ja-JP', timezoneId: 'Asia/Tokyo', trace: 'retain-on-failure' },
  projects: [
    { name: 'iphone', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
    { name: 'android', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: 'DEV_HOST=127.0.0.1 pnpm --filter @hanamaru/api exec tsx src/dev.ts',
      url: 'http://127.0.0.1:3000/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    web('student', 5173),
    web('staff', 5174),
    web('manage', 5175),
  ],
});
