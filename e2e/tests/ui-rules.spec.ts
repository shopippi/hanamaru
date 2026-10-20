import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MANAGE, STAFF, STUDENT, login, loginAdmin } from './helpers.js';

// 画面の決まり（4.2、4.3）をブラウザで測って確かめる

/** 表示中の要素を調べ、決まりに合わないものを返す */
async function audit(page: Page) {
  return page.evaluate(() => {
    const problems: string[] = [];
    const parse = (c: string) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const [r, g, b, a = '1'] = m[1]!.split(/[ ,/]+/).filter(Boolean);
      return { r: Number(r), g: Number(g), b: Number(b), a: Number(a) };
    };
    const lum = (c: { r: number; g: number; b: number }) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const bgOf = (el: Element | null): { r: number; g: number; b: number } => {
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c && c.a > 0.5) return c;
      }
      return { r: 255, g: 255, b: 255 };
    };
    const name = (e: Element) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').join('.') : ''} "${(e.textContent ?? '').trim().slice(0, 20)}"`;
    const visible = (e: Element) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !e.closest('[aria-hidden="true"], .visually-hidden, dialog:not([open])');
    };
    // UI-01: 白・黒・グレーと、差し色のトークン（暗い青と未確認の赤い点）だけ。値はスタイルシートのトークンから読む
    const root = getComputedStyle(document.documentElement);
    const allowed = new Set(
      ['--accent', '--accent-hover', '--accent-soft', '--accent-line', '--dot'].map((t) => {
        const hex = root.getPropertyValue(t).trim().replace('#', '');
        return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(',');
      }),
    );
    for (const e of document.querySelectorAll('body *')) {
      if (!visible(e)) continue;
      const s = getComputedStyle(e);
      for (const prop of ['color', 'backgroundColor', 'borderTopColor'] as const) {
        const c = parse(s[prop]);
        if (c && c.a > 0 && !(c.r === c.g && c.g === c.b) && !allowed.has(`${c.r},${c.g},${c.b}`)) problems.push(`UI-01 ${prop} ${s[prop]} ${name(e)}`);
      }
      // UI-05: 文字と背景の明暗差（大きい文字は 3:1、それ以外は 4.5:1）。押せない状態のボタンは対象外
      const hasText = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
      if (hasText && !(e as HTMLButtonElement).disabled && !e.closest(':disabled, .skeleton')) {
        const fg = parse(s.color)!;
        const bg = bgOf(e);
        const [l1, l2] = [lum(fg), lum(bg)].sort((x, y) => y - x) as [number, number];
        const ratio = (l1 + 0.05) / (l2 + 0.05);
        const size = parseFloat(s.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
        if (ratio < (large ? 3 : 4.5)) problems.push(`UI-05 contrast ${ratio.toFixed(2)} ${name(e)}`);
      }
    }
    // UI-04: 押せる場所は縦横44px以上（文章の中のリンクは除く）
    for (const e of document.querySelectorAll('button, .btn, .choice, .tabbar a, .nav-link, .date-chip, .child-chip, .tabs button, .checkbox, select, input:not([type=checkbox]):not([type=radio]):not([type=file])')) {
      if (!visible(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 44 || r.height < 44) problems.push(`UI-04 ${Math.round(r.width)}x${Math.round(r.height)} ${name(e)}`);
    }
    // UI-03: 文字を入力する欄は16px以上（iPhone で入力時に拡大されないように）。チェックボックスなどは対象外
    for (const e of document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=file]), select, textarea')) {
      if (!visible(e)) continue;
      if (parseFloat(getComputedStyle(e).fontSize) < 16) problems.push(`UI-03 ${name(e)}`);
    }
    // UI-19: ボタンと入力欄に名前（ラベル）
    for (const e of document.querySelectorAll('button, input, select, textarea, a')) {
      if (!visible(e) && !(e as HTMLInputElement).labels?.length) continue;
      const label =
        (e as HTMLElement).innerText?.trim() ||
        e.getAttribute('aria-label') ||
        e.getAttribute('aria-labelledby') ||
        ((e as HTMLInputElement).labels?.length ?? 0) > 0 ||
        e.querySelector('img[alt]:not([alt=""])');
      if (!label && (e as HTMLInputElement).type !== 'hidden') problems.push(`UI-19 ${name(e)}`);
    }
    return problems;
  });
}

const STUDENT_PAGES = ['/', '/book', '/reservations', '/teachers'];

test('UI-01 / UI-03 / UI-04 / UI-05 / UI-19 生徒の画面', async ({ page }) => {
  await page.goto(`${STUDENT}/login`);
  expect(await audit(page)).toEqual([]);
  await login(page, STUDENT, 'parent@example.test');
  for (const path of STUDENT_PAGES) {
    await page.goto(`${STUDENT}${path}`);
    await page.locator('main h1, main .big-number').first().waitFor();
    await page.waitForTimeout(300);
    expect(await audit(page), path).toEqual([]);
  }
  // 確認画面（ダイアログ）も
  await page.goto(`${STUDENT}/book`);
  await page.locator('.slot-grid .choice').first().click();
  await page.getByRole('dialog').waitFor();
  expect(await audit(page), 'dialog').toEqual([]);
});

test('UI-01 / UI-03 / UI-04 / UI-05 / UI-19 講師の画面', async ({ page }) => {
  await login(page, STAFF, 'teacher@example.test');
  for (const path of ['/', '/students', '/availability', '/reviews', '/profile']) {
    await page.goto(`${STAFF}${path}`);
    await page.locator('main h1').first().waitFor();
    await page.waitForTimeout(400);
    expect(await audit(page), path).toEqual([]);
  }
});

test('UI-01 / UI-03 / UI-04 / UI-05 / UI-19 管理の画面', async ({ page }) => {
  await loginAdmin(page);
  for (const path of ['/', '/calendar', '/students', '/teachers', '/payments', '/charges', '/trials', '/pricing', '/school-hours', '/closures', '/settings', '/audit', '/system']) {
    await page.goto(`${MANAGE}${path}`);
    await page.locator('main h1').first().waitFor();
    await page.waitForTimeout(500);
    expect(await audit(page), path).toEqual([]);
  }
  // 講師の詳細（プロフィールと写真: TC-06）
  await page.goto(`${MANAGE}/teachers`);
  await page.getByRole('link', { name: 'プロフィール' }).first().click();
  await page.getByRole('button', { name: 'プロフィールを保存' }).waitFor();
  await page.waitForTimeout(400);
  expect(await audit(page), '/teachers/:id').toEqual([]);
});

test('UI-02 強い警告は太い黒枠・警告アイコン・太字', async ({ page, context }) => {
  await login(page, STUDENT, 'parent@example.test');
  await context.setOffline(true);
  const warning = page.locator('.warning').first();
  await expect(warning).toBeVisible();
  const style = await warning.evaluate((e) => ({ border: getComputedStyle(e).borderTopWidth, weight: getComputedStyle(e).fontWeight }));
  expect(parseFloat(style.border)).toBeGreaterThanOrEqual(2);
  expect(style.weight).toBe('700');
  await expect(warning.locator('.notice-icon svg')).toBeVisible();
  await context.setOffline(false);
});

test.describe('UI-07〜UI-11 読み込み中・失敗の表示', () => {
  const HOME = '**/api/students/*/home';

  test('UI-07 / UI-08 / UI-10 0.3秒までは出さず、その後は同じ配置のスケルトンとシマーを出す', async ({ page }) => {
    await login(page, STUDENT, 'parent@example.test');
    await page.route(HOME, async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });
    await page.goto(`${STUDENT}/`);
    await page.waitForTimeout(150);
    const sk = page.locator('.skeleton').first();
    await expect(sk).toBeHidden(); // 0.3秒未満はちらつきを防ぐため出さない
    await expect(sk).toBeVisible({ timeout: 1500 });
    const anim = await sk.evaluate((e) => {
      const a = getComputedStyle(e, '::after');
      return { name: a.animationName, duration: a.animationDuration, iteration: a.animationIterationCount };
    });
    expect(anim).toEqual({ name: 'shimmer', duration: '1.5s', iteration: 'infinite' });
    // 読み込みが終わったら同じ位置に中身が入れ替わる
    await expect(page.locator('.big-number')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.skeleton')).toHaveCount(0);
  });

  test('UI-10 すぐに読み込めたときはスケルトンを一度も出さない', async ({ page }) => {
    await login(page, STUDENT, 'parent@example.test');
    await page.addInitScript(() => {
      (window as unknown as { seen: boolean }).seen = false;
      new MutationObserver(() => {
        for (const e of document.querySelectorAll('.skeleton')) {
          if (getComputedStyle(e.parentElement!).visibility !== 'hidden' && e.getBoundingClientRect().height > 0) {
            (window as unknown as { seen: boolean }).seen = true;
          }
        }
      }).observe(document, { subtree: true, childList: true, attributes: true });
    });
    await page.goto(`${STUDENT}/`);
    await page.locator('.big-number').waitFor();
    expect(await page.evaluate(() => (window as unknown as { seen: boolean }).seen)).toBe(false);
  });

  test('UI-11 失敗したら「読み込めませんでした」と「再読み込み」を出し、押すと読み込み直す', async ({ page }) => {
    await login(page, STUDENT, 'parent@example.test');
    await page.route(HOME, (route) => route.fulfill({ status: 500, body: '{"error":"x"}', contentType: 'application/json' }));
    await page.goto(`${STUDENT}/`);
    await expect(page.getByText(/読み込めませんでした/)).toBeVisible();
    await page.unroute(HOME);
    await page.getByRole('button', { name: '再読み込み' }).click();
    await expect(page.locator('.big-number')).toBeVisible();
  });

  test('UI-11 10秒たっても届かなければスケルトンを出し続けない', async ({ page }) => {
    test.setTimeout(40_000);
    await login(page, STUDENT, 'parent@example.test');
    await page.route(HOME, () => {}); // 応答を返さない
    await page.goto(`${STUDENT}/`);
    await expect(page.locator('.skeleton').first()).toBeVisible();
    await expect(page.getByText('読み込めませんでした')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('.skeleton')).toHaveCount(0);
  });
});

test.describe('UI-09 動きを減らす設定', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });
  test('シマーを止めて静止したスケルトンだけを出す', async ({ page }) => {
    await login(page, STUDENT, 'parent@example.test');
    await page.route('**/api/students/*/home', async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.continue();
    });
    await page.goto(`${STUDENT}/`);
    const sk = page.locator('.skeleton').first();
    await expect(sk).toBeVisible({ timeout: 1500 });
    const after = await sk.evaluate((e) => getComputedStyle(e, '::after'));
    expect([after.animationName === 'none', after.display === 'none'].some(Boolean)).toBe(true);
  });
});

test('UI-13 / UI-14 予約のボタンは連打しても1回だけ送り、失敗は画面下のメッセージで知らせる', async ({ page }) => {
  await login(page, STUDENT, 'parent@example.test');
  let posts = 0;
  await page.route('**/api/students/*/reservations', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++;
    await new Promise((r) => setTimeout(r, 800));
    await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'この枠は先に予約されました。ほかの時間を選んでください', code: 'rule' }) });
  });
  await page.goto(`${STUDENT}/book`);
  await page.locator('.slot-grid .choice').first().click();
  const confirm = page.getByRole('dialog').getByRole('button', { name: '予約する' });
  await confirm.click();
  await expect(page.getByRole('dialog').getByRole('button', { name: /処理中/ })).toBeDisabled();
  await page.getByRole('dialog').getByRole('button', { name: /処理中/ }).click({ force: true }).catch(() => {});
  await expect(page.locator('.toast-error')).toHaveText(/この枠は先に予約されました/);
  expect(posts).toBe(1);
  await expect(page.getByText('予約しました')).toHaveCount(0); // サーバーで確定するまで「予約しました」と出さない
});

test('UI-17 メール・電話は適したキーボードと自動入力に対応する', async ({ page }) => {
  await page.goto(`${STUDENT}/login`);
  await expect(page.getByLabel('メールアドレス')).toHaveAttribute('type', 'email');
  await expect(page.getByLabel('メールアドレス')).toHaveAttribute('autocomplete', 'username');
  await expect(page.getByLabel('パスワード')).toHaveAttribute('autocomplete', 'current-password');
  await page.goto(`${STUDENT}/trial`);
  await expect(page.getByLabel('電話番号')).toHaveAttribute('type', 'tel');
  await expect(page.getByLabel('電話番号')).toHaveAttribute('autocomplete', 'tel');
});

test('UI-18 日付は「10月20日（火）」、時刻は「15:00」の形', async ({ page }) => {
  await login(page, STUDENT, 'parent@example.test');
  await page.goto(`${STUDENT}/book`);
  const option = (await page.locator('.date-chip').first().getAttribute('aria-label'))!;
  expect(option).toMatch(/^\d{1,2}月\d{1,2}日（[日月火水木金土]）/);
  expect(await page.locator('.slot-grid .choice').first().innerText()).toMatch(/^\d{2}:\d{2}$/);
});

test('MB-02 生徒のトップの主な操作は1つ', async ({ page }) => {
  await login(page, STUDENT, 'parent@example.test');
  await page.locator('.big-number').waitFor();
  expect(await page.locator('main .btn-primary:visible').count()).toBe(1);
});

test('MB-06 / PW-03 ホーム画面への追加は、在籍中で未追加のときだけ案内し、閉じたら出さない', async ({ page, browser }) => {
  await login(page, STUDENT, 'parent@example.test');
  await expect(page.getByText('ホーム画面に追加すると、アプリのようにすぐ開けます。')).toBeVisible();
  await expect(page.getByText('iPhone では、ホーム画面から初めて開いたときにもう一度ログインが必要です。')).toBeVisible();
  await page.getByRole('button', { name: '今は追加しない' }).click();
  await page.reload();
  await page.locator('.big-number').waitFor();
  await expect(page.getByText('ホーム画面に追加すると')).toHaveCount(0);

  // ホーム画面から開いている（追加済み）ときは出さない
  const ctx = await browser.newContext({ ...test.info().project.use });
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    const orig = window.matchMedia.bind(window);
    window.matchMedia = (q: string) => (q.includes('display-mode: standalone') ? ({ matches: true } as MediaQueryList) : orig(q));
  });
  await login(p, STUDENT, 'parent@example.test');
  await p.locator('.big-number').waitFor();
  await expect(p.getByText('ホーム画面に追加すると')).toHaveCount(0);
  await ctx.close();

  // 入会前（入会手続き中）は案内しない。ほかのテストで入会が進んでも左右されないよう、状態だけを差し替える
  const ctx2 = await browser.newContext({ ...test.info().project.use });
  const q = await ctx2.newPage();
  await q.route('**/api/students/*/home', async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    json.student.status = 'enrolling';
    await route.fulfill({ response: res, json });
  });
  await login(q, STUDENT, 'parent@example.test');
  await q.getByRole('link', { name: '入会手続きへ進む' }).waitFor();
  await expect(q.getByText('ホーム画面に追加すると')).toHaveCount(0);
  await ctx2.close();
});

test('UI-06 3つの画面で同じ部品とスタイルを使う', async () => {
  for (const app of ['student', 'staff', 'manage']) {
    const main = readFileSync(fileURLToPath(new URL(`../../apps/${app}/src/main.tsx`, import.meta.url)), 'utf8');
    expect(main).toContain("import '@hanamaru/ui/styles.css';");
    expect(main).toContain("from '@hanamaru/ui'");
  }
});

test('URL-01 / URL-02 / URL-03 公開トップページの入口と転送', async () => {
  const html = readFileSync(fileURLToPath(new URL('../../apps/top/index.html', import.meta.url)), 'utf8');
  expect(html).toContain('href="https://student.hanamarumusic.com/"');
  expect(html).toContain('href="https://staff.hanamarumusic.com/login"');
  expect(html).not.toContain('manage.hanamarumusic.com'); // URL-02: 管理画面は載せない
  const redirects = readFileSync(fileURLToPath(new URL('../../apps/top/_redirects', import.meta.url)), 'utf8');
  expect(redirects).toMatch(/^\/student https:\/\/student\.hanamarumusic\.com\/login 301$/m);
  expect(redirects).toMatch(/^\/staff https:\/\/staff\.hanamarumusic\.com\/login 301$/m);
});
