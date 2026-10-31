import { expect, test, type Page } from '@playwright/test';
import { login, loginAdmin, MANAGE, STAFF, STUDENT } from './helpers.js';

// スマホの幅での見た目（UI-00・UI-04・MB-08 の自動化できる部分）。
// 長い名前・長い経歴・長いレビューを入れた状態で、よく使う画面を開き、
//   横のはみ出し・枠からのはみ出し・重なり・文字の切れ・小さすぎる文字・押せる所の大きさ（44px）・
//   いちばん下まで送ったときに下のタブに隠れないこと・確認画面が画面に収まること
// を確かめる。データを書き換えるので、最後に流す（playwright.config.ts の visual）。
// VISUAL_SHOTS=<フォルダ> を付けると、各画面の全体のスクリーンショットを残す。

const LONG_NAME = '長谷川・ミッチェル・アレクサンドラ 花子';
const ORIGINAL_NAME = '山田 はな太郎';
const VIEWPORTS = [
  { name: 'iPhone SE', width: 375, height: 667 },
  { name: 'iPhone 13', width: 390, height: 844 },
  { name: 'Android 小', width: 360, height: 640 },
];

type Screen = { name: string; path: string; open?: (page: Page) => Promise<void> };
const STUDENT_SCREENS: Screen[] = [
  { name: 's-home', path: '/' },
  { name: 's-book', path: '/book' },
  { name: 's-reservations', path: '/reservations' },
  {
    name: 's-teachers',
    path: '/teachers',
    open: async (page) => {
      await page.getByRole('button', { name: /プロフィールを見る/ }).first().click();
    },
  },
];
const STAFF_SCREENS: Screen[] = [
  { name: 't-lessons', path: '/' },
  { name: 't-availability', path: '/availability' },
  { name: 't-reviews', path: '/reviews' },
  { name: 't-profile', path: '/profile' },
];
const MANAGE_SCREENS: Screen[] = [
  { name: 'm-dashboard', path: '/' },
  { name: 'm-calendar', path: '/calendar' },
  { name: 'm-students', path: '/students' },
  { name: 'm-school-hours', path: '/school-hours' },
  { name: 'm-settings', path: '/settings' },
  { name: 'm-system', path: '/system' },
];

/** 画面の中で見た目の問題を探す。見つかったものを文で返す */
async function layoutIssues(page: Page): Promise<string[]> {
  // スマホの表示では、中身が広いと画面全体が縮んで innerWidth も広がるため、端末の幅と比べる
  const W = page.viewportSize()!.width;
  return page.evaluate(async (W) => {
    const issues: string[] = [];
    const visible = (e: Element) => {
      // 閉じた <details> の中身は見えていない（ブラウザによっては大きさを返す）
      if (e.closest('details:not([open])') && !e.closest('summary')) return false;
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !e.closest('[aria-hidden="true"],.visually-hidden');
    };
    const label = (e: Element) =>
      `${e.tagName.toLowerCase()}${typeof (e as HTMLElement).className === 'string' && (e as HTMLElement).className ? '.' + (e as HTMLElement).className.trim().split(/\s+/).slice(0, 2).join('.') : ''} 「${((e as HTMLElement).innerText || e.getAttribute('aria-label') || '').trim().slice(0, 20)}」`;
    // 横に送る作りの部品（日付の帯・表・タブ）は、中身が幅を超えてよい
    const scroller = '.date-strip,.child-switcher,.table-wrap,.tabs,.cal-grid';
    const all = [...document.querySelectorAll('body *')].filter(visible);

    if (document.documentElement.scrollWidth > W + 1) issues.push(`ページが横にはみ出している（${document.documentElement.scrollWidth}px）`);
    for (const e of all) {
      if (e.closest(scroller)) continue;
      const r = e.getBoundingClientRect();
      if (r.right > W + 1) issues.push(`画面の右へはみ出している ${label(e)}`);
    }
    // 枠からのはみ出し（長い URL など）
    for (const e of document.querySelectorAll('p,span,a,strong,dd,li,h1,h2,h3')) {
      if (!visible(e) || e.closest(scroller)) continue;
      const parent = e.parentElement;
      if (!parent || getComputedStyle(parent).overflowX !== 'visible') continue;
      if (e.getBoundingClientRect().right > parent.getBoundingClientRect().right + 2) issues.push(`枠からはみ出している ${label(e)}`);
    }
    // 文章の中の折り返せない文字列（URL など）が、段落の幅を超えている
    for (const e of document.querySelectorAll('p,dd,li,h1,h2,h3,label')) {
      if (!visible(e) || e.closest(scroller)) continue;
      const el = e as HTMLElement;
      if (getComputedStyle(el).overflowX === 'visible' && el.scrollWidth > el.clientWidth + 2) issues.push(`文が枠からはみ出している ${label(e)}`);
    }
    // 文字の切れ（省略記号や行数の指定で、わざと切っているものは除く）
    for (const e of document.querySelectorAll('h1,h2,h3,p,span,strong,a,button,label,dd,dt,td,th,li')) {
      if (!visible(e)) continue;
      const s = getComputedStyle(e);
      if (s.textOverflow === 'ellipsis' || (s.webkitLineClamp && s.webkitLineClamp !== 'none')) continue;
      const el = e as HTMLElement;
      if ((s.overflowX === 'hidden' || s.overflow === 'hidden') && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2) issues.push(`文字が切れている ${label(e)}`);
    }
    // 小さすぎる文字（10px 未満）
    for (const e of all) {
      const hasText = [...e.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
      if (hasText && parseFloat(getComputedStyle(e).fontSize) < 10) issues.push(`文字が小さすぎる（${getComputedStyle(e).fontSize}） ${label(e)}`);
    }
    // 重なり（同じ親の中の、普通に並んでいる要素どうし）
    const parents = new Set(all.map((e) => e.parentElement));
    for (const parent of parents) {
      if (!parent) continue;
      const kids = [...parent.children].filter(
        (k) => visible(k) && !['fixed', 'sticky', 'absolute'].includes(getComputedStyle(k).position) && !k.matches('dialog,svg,input[type=radio],input[type=checkbox]'),
      );
      for (let i = 0; i < kids.length; i++)
        for (let j = i + 1; j < kids.length; j++) {
          const ka = kids[i]!;
          const kb = kids[j]!;
          const a = ka.getBoundingClientRect();
          const b = kb.getBoundingClientRect();
          const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ox > 2 && oy > 2) issues.push(`重なっている ${label(ka)} と ${label(kb)}`);
        }
    }
    // 押せる所は縦横44px以上（UI-04）。カレンダーのマスは7列で幅が決まるので除く
    for (const e of document.querySelectorAll('button,.btn,.choice,.tabbar a,select,input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden])')) {
      if (!visible(e) || e.closest('.cal-grid')) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 44 || r.height < 44) issues.push(`押せる所が小さい（${Math.round(r.width)}x${Math.round(r.height)}） ${label(e)}`);
    }
    // いちばん下まで送ったとき、最後の中身が下のタブに隠れない
    const bar = document.querySelector('.tabbar');
    const main = document.querySelector('main');
    if (bar && main && visible(bar) && !document.querySelector('dialog[open]')) {
      // いちばん下まで送り切るまで待つ（読み込みで高さが伸びることがある）
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      const atEnd = () => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1;
      for (let i = 0; i < 30 && (i === 0 || !atEnd()); i++) {
        window.scrollTo(0, document.documentElement.scrollHeight);
        await frame();
      }
      const top = bar.getBoundingClientRect().top;
      let lastEl: Element | null = null;
      let last = 0;
      for (const e of main.querySelectorAll('*')) {
        if (!visible(e)) continue;
        const b = e.getBoundingClientRect().bottom;
        if (b > last) (last = b), (lastEl = e);
      }
      if (lastEl && last <= window.innerHeight + 1 && last > top + 1) issues.push(`いちばん下の中身が下のタブに隠れている（${Math.round(last)} > ${Math.round(top)}） ${label(lastEl)} scrollY=${Math.round(window.scrollY)}`);
      window.scrollTo(0, 0);
    }
    return [...new Set(issues)];
  }, W);
}

async function check(page: Page, base: string, screens: Screen[], viewport: string) {
  for (const s of screens) {
    await page.goto(`${base}${s.path}`);
    await page.locator('main h1').first().waitFor();
    await expect(page.locator('.skeleton')).toHaveCount(0);
    if (s.open) await s.open(page);
    expect(await layoutIssues(page), `${viewport} ${s.name}`).toEqual([]);
    if (process.env.VISUAL_SHOTS) {
      // 下のタブを最後に置いて、全体を1枚に撮る
      await page.addStyleTag({ content: '.app{position:relative}.tabbar{position:absolute!important;bottom:0}.toasts{display:none}' });
      await page.screenshot({ path: `${process.env.VISUAL_SHOTS}/${viewport.replace(/\s+/g, '-')}/${s.name}.png`, fullPage: true });
    }
  }
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  // 長い名前・経歴・レビューを入れる
  const page = await browser.newPage();
  await loginAdmin(page);
  await page.evaluate(
    async ([name]) => {
      const list = (await (await fetch('/api/students')).json()) as { id: string; accountEmail: string }[];
      const s = list.find((x) => x.accountEmail === 'parent@example.test')!;
      await fetch(`/api/students/${s.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    },
    [LONG_NAME],
  );
  await page.context().clearCookies();
  await login(page, STAFF, 'teacher@example.test');
  await page.evaluate(async () => {
    const p = (await (await fetch('/api/profile')).json()) as { career?: string; message?: string; instruments?: string[] };
    await fetch('/api/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruments: p.instruments, message: p.message ?? '', career: `${p.career ?? ''}\n${'経歴を長く書いた場合の表示の確認です。'.repeat(12)}` }),
    });
  });
  await page.context().clearCookies();
  await login(page, STUDENT, 'parent@example.test');
  await page.evaluate(async () => {
    const [s] = (await (await fetch('/api/students')).json()) as { id: string }[];
    if (!s) return;
    const [t] = (await (await fetch(`/api/students/${s.id}/teachers`)).json()) as { teacherId: string }[];
    if (!t) return;
    const body = `${'とても丁寧に教えていただきました。'.repeat(18)}https://example.test/a/very/long/url/without/any/break/points/to/check/wrapping`;
    await fetch(`/api/students/${s.id}/reviews`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teacherId: t.teacherId, body }) });
  });
  await page.close();
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await loginAdmin(page);
  await page.evaluate(
    async ([name]) => {
      const list = (await (await fetch('/api/students')).json()) as { id: string; accountEmail: string }[];
      const s = list.find((x) => x.accountEmail === 'parent@example.test')!;
      await fetch(`/api/students/${s.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    },
    [ORIGINAL_NAME],
  );
  await page.close();
});

for (const vp of VIEWPORTS) {
  test.describe(`${vp.name}（${vp.width}px）`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test(`UI-00 / UI-04 / MB-08 生徒の画面は重ならず、はみ出さない（${vp.width}px）`, async ({ page }) => {
      await login(page, STUDENT, 'parent@example.test');
      await check(page, STUDENT, STUDENT_SCREENS, vp.name);
      // 予約の確認画面が画面に収まる
      await page.goto(`${STUDENT}/book`);
      await page.locator('.slot-grid .choice').first().click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      // 下から出てくる動きが終わってから測る
      await dialog.evaluate((d) => Promise.all(d.getAnimations().map((a) => a.finished)));
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 1);
      expect(await layoutIssues(page)).toEqual([]);
    });

    test(`UI-00 / UI-04 / MB-08 講師の画面は重ならず、はみ出さない（${vp.width}px）`, async ({ page }) => {
      await login(page, STAFF, 'teacher@example.test');
      await check(page, STAFF, STAFF_SCREENS, vp.name);
    });

    test(`UI-00 / UI-04 / MB-08 管理の画面は重ならず、はみ出さない（${vp.width}px）`, async ({ page }) => {
      await loginAdmin(page);
      await check(page, MANAGE, MANAGE_SCREENS, vp.name);
      // スマホの引き出しメニュー
      await page.getByRole('button', { name: 'メニューを開く' }).click();
      await expect(page.getByRole('navigation', { name: '管理メニュー' })).toBeVisible();
      expect(await layoutIssues(page)).toEqual([]);
    });
  });
}
