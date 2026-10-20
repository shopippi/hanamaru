import { devices, expect, test, type Browser, type Page } from '@playwright/test';
import { MANAGE, STAFF, STUDENT, adminNav, login, loginAdmin, mails, runJobs, setClock } from './helpers.js';

// 3章の流れを、管理者・生徒・講師の画面をまたいで通す。
// 前のテストで作ったデータを次のテストで使うので、この順番で1つずつ流す。

test.describe.configure({ mode: 'serial' });

const EMAIL = `e2e-${Date.now()}@example.test`;
const NAME = '通し 太郎';

async function open(browser: Browser, device: 'iPhone 13' | 'Desktop Chrome' = 'iPhone 13') {
  const ctx = await browser.newContext({ ...devices[device], locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  return ctx.newPage();
}

async function adminPage(browser: Browser) {
  const page = await open(browser, 'Desktop Chrome');
  await loginAdmin(page);
  return page;
}

async function studentPage(browser: Browser) {
  const page = await open(browser);
  await login(page, STUDENT, EMAIL, 'student-pass-1');
  await expect(page.getByLabel('表示中の生徒')).toHaveText(NAME);
  return page;
}

/**
 * 空き枠が nth+1 個以上ある日を選ぶ。実際の時計で動くので、時刻によっては最初の日の枠が締切で減っている
 */
async function pickDayWithSlots(page: Page, nth: number) {
  await page.locator('.date-chip').first().waitFor();
  for (const chip of await page.locator('.date-chip').all()) {
    const n = Number(/空き(\d+)枠/.exec((await chip.getAttribute('aria-label')) ?? '')?.[1] ?? 0);
    if (n > nth) {
      await chip.click();
      return;
    }
  }
  throw new Error(`空き枠が${nth + 1}個以上ある日がありません`);
}

/** 最初の空き枠を予約し、予約した日時の文字列を返す */
async function bookFirstSlot(page: Page, nth = 0) {
  await page.goto(`${STUDENT}/book`);
  await pickDayWithSlots(page, nth);
  const slot = page.locator('.slot-grid .choice').nth(nth);
  const label = (await slot.getAttribute('aria-label'))!;
  await slot.click();
  await page.getByRole('dialog').getByRole('button', { name: '予約する' }).click();
  await expect(page).toHaveURL(/\/reservations/);
  return label;
}

async function remaining(page: Page) {
  await page.goto(`${STUDENT}/`);
  return Number((await page.locator('.big-number').innerText()).replace(/\D/g, ''));
}

async function adminSetting(browser: Browser, label: string, on: boolean) {
  const a = await adminPage(browser);
  await adminNav(a, '設定');
  const box = a.getByLabel(label);
  if ((await box.isChecked()) !== on) {
    await box.setChecked(on);
    await a.getByRole('button', { name: '設定を保存する' }).click();
    await expect(a.getByText('設定を保存しました')).toBeVisible();
  }
  await a.context().close();
}

test('ST-01 / AU-03 / PY-01〜05 / SR-02 / OP-04 / MB-03 / UI-12 管理者が登録し、招待メールから入会して回数が付く', async ({ browser }) => {
  const admin = await adminPage(browser);
  await adminNav(admin, '生徒');
  await admin.getByRole('button', { name: '生徒を登録' }).click();
  await admin.getByLabel('生徒の名前').fill(NAME);
  await admin.getByLabel('ログインメール（保護者または本人）').fill(EMAIL);
  await admin.getByLabel('電話番号').fill('090-1111-2222');
  await admin.getByLabel('月額コース').selectOption({ label: '月4回コース' });
  await admin.getByLabel('見本 花子').check();
  await admin.getByRole('button', { name: '登録して招待メールを送る' }).click();
  await expect(admin.getByRole('heading', { name: NAME })).toBeVisible();

  // 招待メールのリンクからパスワードを設定する
  const invite = (await mails()).findLast((m) => m.to === EMAIL && m.subject.includes('ご登録のご案内'))!;
  const link = /http\S+invite\?token=\S+/.exec(invite.text)![0];
  const s = await open(browser);
  await s.goto(link.replace('localhost', '127.0.0.1'));
  await s.getByLabel('パスワード', { exact: true }).fill('student-pass-1');
  await s.getByLabel('パスワード（確認）').fill('student-pass-1');
  await s.getByRole('button', { name: '設定する' }).click();
  await expect(s.getByRole('heading', { name: '設定しました' })).toBeVisible();
  // 一度使ったリンクは無効
  await s.goto(link.replace('localhost', '127.0.0.1'));
  await s.getByLabel('パスワード', { exact: true }).fill('student-pass-2');
  await s.getByLabel('パスワード（確認）').fill('student-pass-2');
  await s.getByRole('button', { name: '設定する' }).click();
  await expect(s.getByRole('alert')).toContainText('無効');

  await s.goto(`${STUDENT}/login`);
  await s.getByLabel('メールアドレス').fill(EMAIL);
  await s.getByLabel('パスワード').fill('student-pass-1');
  await s.getByRole('button', { name: 'ログイン' }).click();
  await s.getByRole('link', { name: '入会手続きへ進む' }).click();
  await expect(s.getByText('（税込）').first()).toBeVisible(); // MB-03
  await s.getByLabel('契約の内容と利用規約に同意します').check();
  await s.getByRole('button', { name: /を支払う/ }).click();
  await s.getByRole('button', { name: 'テストで支払う' }).click();
  await expect(s).toHaveURL(/checkout=done/);
  await expect(s.locator('.big-number')).toHaveText(/^4/);
  // 0件のときは理由と次の操作（UI-12）
  await s.getByRole('link', { name: '予約一覧' }).click();
  await expect(s.getByText('予約はまだありません')).toBeVisible();
  await expect(s.getByRole('main').getByRole('link', { name: '予約する' })).toBeVisible();

  // 管理者の生徒詳細: 在籍中・入金記録・回数の履歴
  await admin.reload();
  await expect(admin.getByText('在籍中').first()).toBeVisible();
  await expect(admin.getByRole('cell', { name: '入金済み' })).toBeVisible();
  await admin.getByText(/回数の履歴/).click();
  await expect(admin.getByRole('cell', { name: '入会セット' })).toBeVisible();

  // 入会セットはパスワードとは別に、同じ生徒としてもう一度は払えない
  await s.goto(`${STUDENT}/enroll`);
  await expect(s.getByText('入会手続きは済んでいます')).toBeVisible();

  await s.context().close();
  await admin.context().close();
  // 入金確認のメール
  expect((await mails()).some((m) => m.to === EMAIL && m.subject.includes('お支払いを確認しました'))).toBe(true);
});

test('RS-06 承認制のときは仮予約になり、管理者が承認すると確定する', async ({ browser }) => {
  await adminSetting(browser, '予約を管理者の承認制にする（承認まで「仮予約」）', true);
  const s = await studentPage(browser);
  await s.goto(`${STUDENT}/book`);
  await s.locator('.slot-grid .choice').first().click();
  await s.getByRole('dialog').getByRole('button', { name: '予約する' }).click();
  await expect(s.getByText('仮予約しました。教室の確認後に確定します')).toBeVisible();
  await expect(s.locator('.badge', { hasText: '仮予約' })).toBeVisible();

  const a = await adminPage(browser);
  await adminNav(a, '予約');
  for (let i = 0; i < 4; i++) {
    await a.waitForLoadState('networkidle');
    await a.locator('section.panel h2').first().or(a.getByText('この週の予約はありません')).waitFor();
    if (await a.getByRole('button', { name: '承認', exact: true }).isVisible()) break;
    await a.getByRole('button', { name: '次の週' }).click();
  }
  await a.getByRole('button', { name: '承認', exact: true }).click();
  await expect(a.getByText('承認しました')).toBeVisible();
  await s.reload();
  await expect(s.locator('.badge', { hasText: '仮予約' })).toHaveCount(0);
  await a.context().close();
  await s.context().close();
  await adminSetting(browser, '予約を管理者の承認制にする（承認まで「仮予約」）', false);
});

test('RS-04 生徒は締切前なら日時を変更でき、回数は新しい予約に移る', async ({ browser }) => {
  const s = await studentPage(browser);
  const before = await remaining(s);
  await s.getByRole('link', { name: '予約一覧' }).click();
  await s.getByRole('link', { name: '日時を変更' }).first().click();
  await expect(s.getByRole('heading', { name: '日時を変更する' })).toBeVisible();
  await pickDayWithSlots(s, 1);
  await s.locator('.slot-grid .choice').nth(1).click();
  await s.getByRole('dialog').getByRole('button', { name: '変更する' }).click();
  await expect(s.getByText('日時を変更しました')).toBeVisible();
  expect(await remaining(s)).toBe(before);
  // 変更のメール（NT-01）
  expect((await mails()).some((m) => m.to === EMAIL && m.subject.includes('予約変更'))).toBe(true);
  await s.context().close();
});

test('AV-02 / AV-03 / PY-08 講師が予約のある日を不在にすると警告が出て、確認すると講師都合のキャンセルになる', async ({ browser }) => {
  const s = await studentPage(browser);
  const before = await remaining(s);
  const label = await bookFirstSlot(s, 2);
  expect(await remaining(s)).toBe(before - 1);
  // 予約した日（aria-label の「10月22日（木）」）を YYYY-MM-DD にする
  const [, m, d] = /(\d+)月(\d+)日/.exec(label)!;
  const now = new Date();
  const year = Number(m) < now.getMonth() + 1 ? now.getFullYear() + 1 : now.getFullYear();
  const date = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  const t = await open(browser);
  await login(t, STAFF, 'teacher@example.test');
  await t.getByRole('navigation').getByRole('link', { name: '空き時間', exact: true }).click();
  await t.getByLabel('日付').fill(date);
  await t.getByRole('button', { name: '例外を追加する' }).click();
  const dialog = t.getByRole('dialog');
  await expect(dialog.getByText('予約が入っている時間帯があります')).toBeVisible();
  await expect(dialog.getByText(NAME).first()).toBeVisible();
  // 件数・生徒名・日時を並べる（AV-02）。この生徒の予約が何件取り消されるか数える
  const mine = await dialog.locator('li', { hasText: NAME }).count();
  await expect(dialog.getByText(new RegExp(`${m}月${d}日`)).first()).toBeVisible();
  await dialog.getByRole('button', { name: '予約を取り消して変更する' }).click();
  await expect(t.getByText(/件の予約を講師都合で取り消しました/)).toBeVisible();

  // 取り消した分の回数が戻る
  expect(await remaining(s)).toBe(before - 1 + mine);
  await s.getByRole('link', { name: '予約一覧' }).click();
  await s.getByText(/これまでの予約/).click();
  await expect(s.getByText('講師の都合で中止').first()).toBeVisible();
  const sent = await mails();
  expect(sent.some((x) => x.to === EMAIL && x.text.includes('講師の都合'))).toBe(true);
  expect(sent.some((x) => x.to === 'admin@example.test' && x.text.includes('講師の都合'))).toBe(true);

  // 後片付け: 不在の日を消す
  await t.getByRole('button', { name: '削除' }).last().click();
  await t.context().close();
  await s.context().close();
});

test('AV-04 休講日を設定すると、その日の予約は教室都合で取り消され回数が戻る', async ({ browser }) => {
  const s = await studentPage(browser);
  const before = await remaining(s);
  const label = await bookFirstSlot(s, 3);
  const [, m, d] = /(\d+)月(\d+)日/.exec(label)!;
  const now = new Date();
  const year = Number(m) < now.getMonth() + 1 ? now.getFullYear() + 1 : now.getFullYear();
  const date = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  const a = await adminPage(browser);
  await adminNav(a, '休講');
  await a.getByLabel('日付').fill(date);
  await a.getByLabel('理由').fill('通しテスト');
  await a.getByRole('main').getByRole('button', { name: '休講にする' }).first().click();
  await a.getByRole('dialog').getByRole('button', { name: '休講にする' }).click();
  await expect(a.getByText(/件の予約を取り消し、回数を戻しました/)).toBeVisible();
  expect(await remaining(s)).toBe(before);
  // 休講日の枠は表示されない
  await s.goto(`${STUDENT}/book`);
  await expect(s.getByRole('option', { name: new RegExp(`^${m}月${d}日`) })).toHaveCount(0);
  await a.getByRole('button', { name: '削除' }).first().click();
  await a.context().close();
  await s.context().close();
});

test('RS-07 管理者が毎週の繰り返し予約を作ると、各回が生徒の予約一覧に出る', async ({ browser }) => {
  const a = await adminPage(browser);
  await adminNav(a, '予約');
  await a.getByRole('button', { name: '繰り返し予約' }).click();
  await a.getByLabel('生徒', { exact: true }).selectOption({ label: NAME });
  await a.getByLabel('担当講師').selectOption({ label: '見本 花子' });
  await a.getByLabel('レッスン種別').selectOption({ label: '個人 45分' });
  await a.getByLabel('曜日').selectOption({ label: '月曜日' });
  await a.getByLabel('開始時刻').fill('18:45');
  await a.getByRole('button', { name: '繰り返し予約を作る' }).click();
  await expect(a.getByText(/回分を予約しました/)).toBeVisible();
  // 回数が足りない月は警告が出る
  await expect(a.getByText(/回数が\d+回足りません/).first()).toBeVisible();
  await a.context().close();

  const s = await studentPage(browser);
  await s.getByRole('link', { name: '予約一覧' }).click();
  await expect(s.getByText(/18:45〜19:30/).first()).toBeVisible();
  await s.context().close();
});

test('SR-04 / SR-05 講師がレッスン記録を書くと、管理者と担当講師は見られ、生徒には出ない', async ({ browser }) => {
  const t = await open(browser);
  await login(t, STAFF, 'teacher@example.test');
  for (let i = 0; i < 6; i++) {
    await t.locator('ul.list').or(t.getByText('この週の担当レッスンはありません')).first().waitFor();
    if (await t.locator('li', { hasText: NAME }).first().isVisible()) break;
    await t.getByRole('button', { name: '次の週' }).click();
  }
  const row = t.locator('li', { hasText: NAME }).first();
  await row.getByRole('link', { name: /記録を/ }).click();
  await t.getByLabel('その回の内容').fill('通しテストの記録: ハノン1番');
  await t.getByRole('button', { name: '保存する' }).click();
  await expect(t.getByText('記録を保存しました')).toBeVisible();

  const a = await adminPage(browser);
  await adminNav(a, '生徒');
  await a.getByRole('cell').getByRole('link', { name: NAME, exact: true }).click();
  await expect(a.getByText('通しテストの記録: ハノン1番')).toBeVisible();
  await a.context().close();

  const s = await studentPage(browser);
  for (const path of ['/', '/reservations', '/teachers']) {
    await s.goto(`${STUDENT}${path}`);
    await expect(s.getByText('ハノン1番')).toHaveCount(0);
  }
  await s.context().close();
  await t.context().close();
});

test('ST-02 / UI-16 自己登録は入力の誤りを欄の下に出し、登録後は承認されるまで予約できない', async ({ browser }) => {
  await adminSetting(browser, '自己登録を受け付ける（管理者の承認が必要）', true);
  const v = await open(browser);
  await v.goto(`${STUDENT}/register`);
  await v.getByLabel('メールアドレス').fill('bad-address');
  await v.getByRole('button', { name: '登録する' }).click();
  await expect(v.getByText('生徒の名前を入力してください')).toBeVisible();
  await expect(v.getByText('メールアドレスの形式が正しくありません')).toBeVisible();
  await expect(v.getByLabel('メールアドレス')).toHaveValue('bad-address'); // 入力した内容は消さない
  const email = `self-${Date.now()}@example.test`;
  await v.getByLabel('生徒のお名前').fill('自己 登録');
  await v.getByLabel('電話番号').fill('090-0000-9999');
  await v.getByLabel('メールアドレス').fill(email);
  await v.getByLabel('パスワード').fill('self-pass-1');
  await v.getByRole('button', { name: '登録する' }).click();
  await expect(v.getByText('登録しました。教室で確認したあと、予約できるようになります。')).toBeVisible();
  await v.goto(`${STUDENT}/login`);
  await v.getByLabel('メールアドレス').fill(email);
  await v.getByLabel('パスワード').fill('self-pass-1');
  await v.getByRole('button', { name: 'ログイン' }).click();
  await expect(v.getByRole('link', { name: '入会手続きへ進む' })).toBeVisible();

  const a = await adminPage(browser);
  await adminNav(a, '生徒');
  await a.getByRole('button', { name: '承認待ち' }).click();
  await a.getByRole('cell').getByRole('link', { name: '自己 登録', exact: true }).click();
  await a.getByRole('button', { name: '登録を承認する' }).click();
  await expect(a.getByText('承認しました')).toBeVisible();
  await a.context().close();
  await v.context().close();
  await adminSetting(browser, '自己登録を受け付ける（管理者の承認が必要）', false);
});

test('TR-02 体験枠を公開すると誰でも予約でき、管理者の画面に届く', async ({ browser }) => {
  const v = await open(browser);
  await v.goto(`${STUDENT}/trial`);
  await expect(v.getByText('体験レッスンの枠から選ぶ')).toHaveCount(0); // OFF のときは出ない
  await adminSetting(browser, '体験専用の枠を一般に公開する', true);
  await v.reload();
  await v.getByLabel('お名前', { exact: true }).fill('体験 通し');
  await v.getByLabel('メールアドレス').fill('trial-open@example.test');
  await v.getByRole('heading', { name: '体験レッスンの枠から選ぶ' }).waitFor();
  await v.locator('section').getByRole('button').first().click();
  await v.getByRole('dialog').getByRole('button', { name: '予約する' }).click();
  await expect(v.getByRole('heading', { name: 'ご予約が確定しました' })).toBeVisible();
  const a = await adminPage(browser);
  await adminNav(a, '体験');
  await expect(a.locator('li', { hasText: '体験 通し' }).getByText('日時確定')).toBeVisible();
  await a.context().close();
  await v.context().close();
  await adminSetting(browser, '体験専用の枠を一般に公開する', false);
});

test('TR-01 体験の申込に、管理者が枠を押さえて連絡する', async ({ browser }) => {
  const v = await open(browser);
  await v.goto(`${STUDENT}/trial`);
  await v.getByLabel('お名前', { exact: true }).fill('体験 申込');
  await v.getByLabel('メールアドレス').fill('trial-request@example.test');
  await v.getByLabel('ご希望の日時').fill('平日の夕方');
  await v.getByRole('button', { name: '申し込む' }).click();
  await expect(v.getByRole('heading', { name: 'お申込を受け付けました' })).toBeVisible();
  await v.context().close();
  expect((await mails()).some((m) => m.to === 'admin@example.test' && m.text.includes('体験 申込'))).toBe(true);

  // 平日（講師Aの空き時間がある日）を選ぶ
  const d = new Date(Date.now() + 2 * 86_400_000);
  while ([0, 6].includes(d.getDay())) d.setDate(d.getDate() + 1);
  const date = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

  const a = await adminPage(browser);
  await adminNav(a, '体験');
  const item = a.locator('li', { hasText: '体験 申込' });
  await item.getByRole('button', { name: '枠を押さえる' }).click();
  await item.getByLabel('講師').selectOption({ label: '見本 花子' });
  await item.getByLabel('日付').fill(date);
  await item.locator('.slot-grid button').first().click();
  await expect(a.getByText('予約しました。申込者に確定のメールを送りました')).toBeVisible();
  await expect(item.getByText('日時確定')).toBeVisible();
  await a.context().close();
  expect((await mails()).some((m) => m.to === 'trial-request@example.test' && m.subject.includes('ご予約が確定'))).toBe(true);
});

test('ST-03 招待コードで登録でき、無効なコードは拒否される', async ({ browser }) => {
  await adminSetting(browser, '招待コードでの登録を受け付ける', true);
  const a = await adminPage(browser);
  await adminNav(a, '設定');
  await a.getByRole('button', { name: '招待コードを作る' }).click();
  const code = (await a.locator('strong.num').first().innerText()).trim();
  await a.context().close();

  const v = await open(browser);
  await v.goto(`${STUDENT}/register`);
  const fill = async (c: string, email: string) => {
    await v.getByLabel('招待コード').fill(c);
    await v.getByLabel('生徒のお名前').fill('招待 太郎');
    await v.getByLabel('電話番号').fill('090-0000-1234');
    await v.getByLabel('メールアドレス').fill(email);
    await v.getByLabel('パスワード').fill('invite-pass-1');
    await v.getByRole('button', { name: '登録する' }).click();
  };
  await fill('WRONGCODE', `inv-ng-${Date.now()}@example.test`);
  await expect(v.getByRole('alert')).toContainText('招待コードが正しくないか');
  await fill(code, `inv-ok-${Date.now()}@example.test`);
  await expect(v.getByText('登録しました。教室で確認したあと、予約できるようになります。')).toBeVisible();
  await v.context().close();
  await adminSetting(browser, '招待コードでの登録を受け付ける', false);
});

test('PY-17 / PY-15 単発の請求の入金状況が分かり、入金履歴を CSV で書き出せる', async ({ browser }) => {
  const a = await adminPage(browser);
  await adminNav(a, '単発の請求');
  await a.getByRole('main').getByRole('button', { name: '請求を作る' }).first().click();
  await a.getByLabel('請求の名前').fill('発表会参加費');
  await a.getByLabel('金額（税込・円）').fill('3000');
  await a.getByRole('button', { name: 'すべて選ぶ' }).click();
  await a.getByRole('button', { name: /人に請求を作る/ }).click();
  await expect(a.getByText('請求を作りました')).toBeVisible();
  await a.getByRole('button', { name: /発表会参加費/ }).click();
  await a.getByRole('button', { name: '入金済みにする' }).first().click();
  await expect(a.getByText('入金済みにしました')).toBeVisible();
  await expect(a.getByText(/入金済み 1 \//)).toBeVisible();

  const today = new Date().toISOString().slice(0, 10);
  const res = await a.request.get(`${MANAGE}/api/payments.csv?from=2020-01-01&to=${today}`);
  expect(res.headers()['content-type']).toContain('text/csv');
  const csv = await res.text();
  expect(csv.split('\r\n')[0]).toBe('﻿入金日時,生徒,種類,対象月,方法,金額（税込）');
  expect(csv).toContain('単発');
  await a.context().close();
});

test('DB-02 ダッシュボードの予約は講師別・教室別に切り替えられる', async ({ browser }) => {
  const a = await adminPage(browser);
  await a.getByRole('button', { name: '今週' }).click();
  await a.getByRole('button', { name: '教室別' }).click();
  // 教室別では部屋の名前（指定がなければ「教室の指定なし」）でまとめる
  await expect(a.getByRole('heading', { name: /^(レッスン室1|教室の指定なし)\s*\d+件$/ }).first()).toBeVisible();
  await expect(a.getByRole('heading', { name: /^見本 花子\s*\d+件$/ })).toHaveCount(0);
  await a.getByRole('button', { name: '講師別' }).click();
  await expect(a.getByRole('heading', { name: /^見本 花子\s*\d+件$/ })).toBeVisible();
  await a.context().close();
});

test('3.4 / PY-07 / PY-09 / PY-10 月が変わると請求が並び、猶予を過ぎた未払いは予約できず、現金で入金済みにすると戻る', async ({ browser }) => {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const ym = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
  try {
    await setClock(`${ym}-01T00:10:00+09:00`);
    expect((await runJobs()).filter((j) => j.error)).toEqual([]);

    const a = await adminPage(browser);
    await adminNav(a, '入金');
    await a.getByRole('heading', { name: '入金状況' }).waitFor();
    await a.getByLabel('対象月').fill(ym);
    await a.getByLabel('未払い・決済失敗だけ').check();
    await expect(a.getByRole('cell').getByRole('link', { name: '山田 太郎', exact: true })).toBeVisible();
    // 前月の余った回数は失効している（PY-07、繰越なしの設定）
    await a.getByRole('cell').getByRole('link', { name: '山田 太郎', exact: true }).click();
    await a.getByText(/回数の履歴/).click();
    await expect(a.getByRole('cell', { name: '失効' }).first()).toBeVisible();

    // 猶予期間（7日）を過ぎると予約できない
    await setClock(`${ym}-09T10:00:00+09:00`);
    await runJobs();
    const p = await open(browser);
    await login(p, STUDENT, 'parent@example.test');
    await expect(p.getByText('お支払いが確認できていないため予約できません。教室にご連絡ください')).toBeVisible();
    await expect(p.getByRole('button', { name: '予約する' })).toBeDisabled();

    // 現金で入金済みにすると、記録が残り、予約できる状態に戻る（PY-06）
    await adminNav(a, '入金');
    await a.getByRole('heading', { name: '入金状況' }).waitFor();
    await a.getByLabel('対象月').fill(ym);
    await a.locator('tr', { hasText: '山田 太郎' }).getByRole('button', { name: '現金で入金済み' }).click();
    await expect(a.getByText('山田 太郎さんを入金済みにしました')).toBeVisible();
    await p.reload();
    await expect(p.getByText('お支払いが確認できていない')).toHaveCount(0);
    await adminNav(a, '操作記録');
    await expect(a.getByText('現金の入金記録').first()).toBeVisible();
    await p.context().close();
    await a.context().close();
  } finally {
    await setClock(null);
  }
});

test('PY-03 / PY-06 カード払いに切り替えた生徒は、メールのリンクからカードを登録すると自動課金になる', async ({ browser }) => {
  const a = await adminPage(browser);
  await adminNav(a, '生徒');
  await a.getByRole('row').filter({ hasText: EMAIL }).getByRole('link', { name: NAME }).click();
  const method = a.getByLabel('支払い方法');
  // いったん現金にしてカードの自動課金を止め、もう一度カード払いにする
  for (const value of ['cash', 'card']) {
    await method.selectOption(value);
    await a.getByRole('button', { name: '保存する', exact: true }).click();
    await expect(a.getByText('保存しました').first()).toBeVisible();
  }
  await a.reload();
  await expect(a.getByText('カードが登録されていません')).toBeVisible();

  const request = (await mails()).findLast((m) => m.to === EMAIL && m.subject.includes('カードのご登録のお願い'))!;
  const link = /http\S+\?billing=register/.exec(request.text)![0];
  const s = await studentPage(browser);
  await s.goto(link.replace('localhost', '127.0.0.1'));
  await s.getByRole('button', { name: 'テストのカードを登録する' }).click();
  await expect(s.getByText('カードを登録しました。翌月1日から毎月自動でお支払いいただきます。')).toBeVisible();
  await expect(s.getByText('カードの登録をお願いします')).toHaveCount(0);

  await a.reload();
  await expect(a.getByRole('heading', { name: NAME })).toBeVisible();
  await expect(a.getByText('カードが登録されていません')).toHaveCount(0);
  await a.context().close();
  await s.context().close();
});
