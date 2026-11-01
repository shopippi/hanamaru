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
  use: {
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    trace: 'retain-on-failure',
    // 入っているブラウザの版が @playwright/test と合わない環境（作業用のクラウド環境など）では、
    // PW_CHROMIUM_PATH でブラウザの実行ファイルを指定する。CI では指定しない（playwright install の版を使う）
    ...(process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : {}),
  },
  // E2E_WEBKIT=1 のときは、iPhone の Safari と同じ描画エンジン（WebKit）で流す（MB-08 の自動化できる部分。CI の別の仕事）。
  // 作業用の環境には WebKit が入っていないので、ふだんは Chromium だけで流す
  projects: process.env.E2E_WEBKIT
    ? [
        { name: 'webkit', testIgnore: /(scenarios|ui-rules|pwa|visual-mobile|a11y)\.spec/, use: { ...devices['iPhone 13'] } },
        { name: 'webkit-rules', testMatch: /(ui-rules|a11y)\.spec/, dependencies: ['webkit'], use: { ...devices['iPhone 13'] } },
        { name: 'webkit-visual', testMatch: /visual-mobile\.spec/, dependencies: ['webkit-rules'], use: { ...devices['iPhone 13'] } },
      ]
    : [
        // 生徒・講師・管理の基本操作を、iPhone と Android の大きさで
        { name: 'iphone', testIgnore: /(scenarios|ui-rules|pwa|visual-mobile|a11y)\.spec/, use: { ...devices['iPhone 13'], browserName: 'chromium' } },
        { name: 'android', testIgnore: /(scenarios|ui-rules|pwa|visual-mobile|a11y)\.spec/, use: { ...devices['Pixel 7'] } },
        // 画面の決まり（UI・MB・PW）と、アクセシビリティの自動検査（axe）。データは変えない
        { name: 'rules', testMatch: /(ui-rules|pwa|a11y)\.spec/, use: { ...devices['iPhone 13'], browserName: 'chromium' } },
        // 3章の流れを3つの画面をまたいで通す。データと時計を変えるので最後に流す
        { name: 'scenarios', testMatch: /scenarios\.spec/, dependencies: ['iphone', 'android', 'rules'], use: { ...devices['iPhone 13'], browserName: 'chromium' } },
        // スマホの幅での見た目（重なり・はみ出し・切れ・44px）。長いデータを入れるので、いちばん最後に流す
        { name: 'visual', testMatch: /visual-mobile\.spec/, dependencies: ['scenarios'], use: { ...devices['iPhone 13'], browserName: 'chromium' } },
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
