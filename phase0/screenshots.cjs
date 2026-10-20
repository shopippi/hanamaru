// V-10 用: 管理画面を iPhone 幅で撮る。LibreBooking をダミーデータで起動した状態で実行する。
//   NO_PROXY='*' NODE_PATH=$(npm root -g) node phase0/screenshots.cjs
// 出力先: docs/phase0/shots/
require('fs').mkdirSync('docs/phase0/shots', { recursive: true });
const { chromium, devices } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices['iPhone 13'], locale: 'ja-JP' });
  const p = await ctx.newPage();
  const base = 'http://127.0.0.1:8080/Web';
  await p.goto(base + '/index.php');
  await p.screenshot({ path: 'docs/phase0/shots/01-login.png' });
  await p.fill('#email', 'admin'); await p.fill('#password', 'password');
  await Promise.all([p.waitForNavigation(), p.click('button[type=submit], input[type=submit]')]);
  for (const [n, u] of [['02-dashboard','/dashboard.php'],['03-schedule','/schedule.php'],['04-calendar','/calendar.php'],['05-manage-reservations','/admin/manage_reservations.php'],['06-manage-users','/admin/manage_users.php'],['07-manage-resources','/admin/manage_resources.php']]) {
    await p.goto(base + u); await p.waitForTimeout(800);
    await p.screenshot({ path: `docs/phase0/shots/${n}.png`, fullPage: false });
  }
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
