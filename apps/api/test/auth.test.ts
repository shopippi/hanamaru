import { describe, expect, test } from 'vitest';
import { totpCode } from '../src/lib/crypto.js';
import { jst } from '../src/lib/time.js';
import { PASSWORD, setupHttp } from './http.js';

const linkToken = (text: string) => /token=([\w-]+)/.exec(text)![1]!;

describe('AU-01 / URL-05 ロールごとの画面', () => {
  test('各ロールは自分のポータルにだけログインでき、他のポータルは拒否される', async () => {
    const f = await setupHttp();
    const { account } = await f.mkStudent('太郎', { credits: 4 });
    await f.setPassword(account.id);
    await f.setPassword(f.teacherA.account.id);

    const student = f.browser('student');
    expect((await student.login(account.email)).status).toBe(200);
    expect((await student.get('/students')).status).toBe(200);

    // 生徒が講師・管理のポータルを開いても拒否される（URL-05）
    const staffWithStudentCookie = f.browser('staff');
    for (const [k, v] of student.jar) staffWithStudentCookie.jar.set(k.replace('student', 'staff'), v);
    expect((await staffWithStudentCookie.get('/lessons?from=2026-10-20&to=2026-10-27')).status).toBe(401);

    // 講師アカウントは生徒のポータルにログインできない
    expect((await f.browser('student').login(f.teacherA.account.email)).status).toBe(401);
    const teacher = f.browser('staff');
    expect((await teacher.login(f.teacherA.account.email)).status).toBe(200);
    expect((await teacher.get('/students')).status).toBe(200);
  });
});

describe('AU-02 ログインの誤り', () => {
  test('メールとパスワードのどちらが違うかを特定させない', async () => {
    const f = await setupHttp();
    const { account } = await f.mkStudent('太郎');
    await f.setPassword(account.id);
    const wrongPassword = await f.browser('student').login(account.email, 'wrong-password');
    const unknownEmail = await f.browser('student').login('nobody@example.test', 'wrong-password');
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.data.error).toBe(unknownEmail.data.error);
  });
});

describe('AU-03 パスワードの再設定', () => {
  test('メールのリンクで再設定でき、一度使うと無効になる', async () => {
    const f = await setupHttp();
    const { account } = await f.mkStudent('太郎');
    await f.setPassword(account.id);
    const b = f.browser('student');
    expect((await b.post('/auth/password-reset', { email: account.email })).status).toBe(200);
    const token = linkToken(f.mail.sent.at(-1)!.text);
    expect(f.mail.sent.at(-1)!.text).toContain('https://student.example.test/reset-password?token=');
    expect((await b.post('/auth/password', { token, password: 'new-password-1' })).status).toBe(200);
    expect((await b.login(account.email, 'new-password-1')).status).toBe(200);
    const reuse = await b.post('/auth/password', { token, password: 'another-pass-1' });
    expect(reuse.status).toBe(400);
  });

  test('リンクは一定時間で失効する', async () => {
    const f = await setupHttp();
    const { account } = await f.mkStudent('太郎');
    const b = f.browser('student');
    await b.post('/auth/password-reset', { email: account.email });
    const token = linkToken(f.mail.sent.at(-1)!.text);
    f.clock.now = new Date(f.clock.now.getTime() + 61 * 60_000);
    expect((await b.post('/auth/password', { token, password: 'new-password-1' })).status).toBe(400);
  });

  test('存在しないメールでも同じ応答で、メールは送らない', async () => {
    const f = await setupHttp();
    const res = await f.browser('student').post('/auth/password-reset', { email: 'nobody@example.test' });
    expect(res.status).toBe(200);
    expect(f.mail.sent).toHaveLength(0);
  });

  test('ボット確認（Turnstile）に失敗すると受け付けない（NF-06）', async () => {
    const f = await setupHttp();
    f.captcha.ok = false;
    expect((await f.browser('student').post('/auth/password-reset', { email: 'a@example.test' })).status).toBe(400);
  });
});

describe('AU-04 ログイン状態を保つ', () => {
  test('設定の期間内なら再訪問でログインし直さずに使える', async () => {
    const f = await setupHttp();
    const { account } = await f.mkStudent('太郎');
    await f.setPassword(account.id);
    const b = f.browser('student');
    await b.login(account.email);
    f.clock.now = new Date(f.clock.now.getTime() + 59 * 86_400_000);
    expect((await b.get('/students')).status).toBe(200);
    f.clock.now = new Date(f.clock.now.getTime() + 2 * 86_400_000);
    const expired = await b.get('/students');
    expect(expired.status).toBe(401);
    expect(expired.data.code).toBe('login_required');
  });
});

describe('AU-05 ログインの失敗回数の制限', () => {
  test('一定回数失敗すると、正しいパスワードでも一時的にログインできない', async () => {
    const f = await setupHttp();
    const { account } = await f.mkStudent('太郎');
    await f.setPassword(account.id);
    const b = f.browser('student');
    for (let i = 0; i < 5; i++) await b.login(account.email, 'wrong-password');
    const locked = await b.login(account.email);
    expect(locked.status).toBe(401);
    expect(locked.data.error).toContain('一時的にログインできません');
    f.clock.now = new Date(f.clock.now.getTime() + 16 * 60_000);
    expect((await b.login(account.email)).status).toBe(200);
  });
});

describe('AU-06 管理者の二段階認証', () => {
  test('初回は認証アプリの登録を求め、確認コードを入れるまで管理画面を使えない', async () => {
    const f = await setupHttp();
    await f.setPassword(f.adminAccount.id);
    const b = f.browser('manage');
    const login = await b.login(f.adminAccount.email);
    expect(login.data.mfa).toBe('setup');
    const blocked = await b.get('/students');
    expect(blocked.status).toBe(401);
    expect(blocked.data.code).toBe('mfa_required');
    const { secret, uri } = (await b.post('/auth/mfa/setup')).data;
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect((await b.post('/auth/mfa/verify', { code: '000000' })).status).toBe(401);
    expect((await b.post('/auth/mfa/verify', { code: totpCode(secret, f.clock.now) })).status).toBe(200);
    expect((await b.get('/students')).status).toBe(200);

    // 2回目以降は確認コードの入力を求める（一度使ったコードは使えないので、次の30秒のコードで）
    f.clock.now = new Date(f.clock.now.getTime() + 30_000);
    const again = f.browser('manage');
    expect((await again.login(f.adminAccount.email)).data.mfa).toBe('verify');
    expect((await again.get('/students')).status).toBe(401);
    expect((await again.post('/auth/mfa/verify', { code: totpCode(secret, f.clock.now) })).status).toBe(200);
    expect((await again.get('/students')).status).toBe(200);
  });

  test('講師・生徒のログインでは二段階認証を求めない', async () => {
    const f = await setupHttp();
    await f.setPassword(f.teacherA.account.id);
    expect((await f.browser('staff').login(f.teacherA.account.email)).data.mfa).toBe('none');
  });
});

describe('ST-06 予約に関わるページはログイン必須', () => {
  test('ログインせずに開くと 401（画面はログイン画面に移る）', async () => {
    const f = await setupHttp();
    const { student } = await f.mkStudent('太郎');
    for (const path of ['/students', `/students/${student.id}/home`, `/students/${student.id}/reservations`]) {
      const res = await f.browser('student').get(path);
      expect(res.status).toBe(401);
      expect(res.data.code).toBe('login_required');
    }
  });

  test('フォーム形式の送信は受け付けない（CSRF 対策）', async () => {
    const f = await setupHttp();
    const res = await f.app.request('/api/student/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=a&password=b',
    });
    expect(res.status).toBe(415);
  });
});

describe('ST-01 管理者による登録と招待', () => {
  test('登録すると招待メールが届き、リンクからパスワードを設定するとログインできる', async () => {
    const f = await setupHttp();
    const admin = await f.adminBrowser();
    const res = await admin.post('/students', {
      accountEmail: 'Parent@Example.test',
      guardianName: '山田 花子',
      name: '山田 太郎',
      phone: '090-0000-0000',
      teacherIds: [f.teacherA.teacher.id],
    });
    expect(res.status).toBe(201);
    const mail = f.mail.sent.at(-1)!;
    expect(mail.to).toBe('parent@example.test');
    expect(mail.text).toContain('https://student.example.test/invite?token=');
    const b = f.browser('student');
    expect((await b.post('/auth/password', { token: linkToken(mail.text), password: PASSWORD })).status).toBe(200);
    expect((await b.login('parent@example.test')).status).toBe(200);
    expect((await b.get('/students')).data.map((s: any) => s.name)).toEqual(['山田 太郎']);
  });

  test('同じメールで登録すると、同じ保護者に兄弟として紐付く（ST-04）', async () => {
    const f = await setupHttp();
    const admin = await f.adminBrowser();
    await admin.post('/students', { accountEmail: 'p@example.test', name: '長女' });
    await admin.post('/students', { accountEmail: 'p@example.test', name: '長男' });
    const list = (await admin.get('/students')).data.filter((s: any) => s.accountEmail === 'p@example.test');
    expect(list.map((s: any) => s.name).sort()).toEqual(['長女', '長男']);
  });

  test('CSVで一括登録できる。誤りがある行があれば何も登録せず行番号を返す', async () => {
    const f = await setupHttp();
    const admin = await f.adminBrowser();
    const header = 'ログインメール,保護者名,生徒名,電話番号,生徒のメール,住所';
    const bad = await admin.post('/students/import', {
      csv: `${header}\na@example.test,保護者A,生徒A,090,,\nnot-an-email,保護者B,生徒B,090,,`,
    });
    expect(bad.data).toEqual({ created: 0, errors: [{ line: 3, message: 'メールアドレスの形式が正しくありません' }] });
    const ok = await admin.post('/students/import', {
      csv: `﻿${header}\r\na@example.test,保護者A,生徒A,090,,"東京都,千代田区"\r\nb@example.test,保護者B,生徒B,090,,\r\n`,
    });
    expect(ok.data).toEqual({ created: 2, errors: [] });
    expect(f.mail.sent.filter((m) => m.subject.includes('ご登録のご案内'))).toHaveLength(2);
  });
});

describe('ST-02 / ST-03 自己登録と招待コード', () => {
  test('OFF のときは登録画面が表示されない', async () => {
    const f = await setupHttp();
    const b = f.browser('student');
    expect((await b.get('/registration')).data.enabled).toBe(false);
    const res = await b.post('/registration', { email: 'x@example.test', password: PASSWORD, studentName: 'x', phone: '090' });
    expect(res.status).toBe(404);
  });

  test('自己登録した直後は予約できず、管理者が承認すると予約できる', async () => {
    const f = await setupHttp();
    const admin = await f.adminBrowser();
    await admin.patch('/settings', { selfRegistration: true });
    const b = f.browser('student');
    const reg = await b.post('/registration', {
      email: 'new@example.test',
      password: PASSWORD,
      guardianName: '新井',
      studentName: '新井 一郎',
      phone: '090-1111-1111',
    });
    expect(reg.status).toBe(201);
    await b.login('new@example.test');
    const [me] = (await b.get('/students')).data;
    expect((await b.get(`/students/${me.id}/home`)).data.blocker).toContain('承認待ち');

    const pending = (await admin.get('/students?pendingApproval=1')).data;
    expect(pending.map((s: any) => s.name)).toEqual(['新井 一郎']);
    await admin.post(`/students/${me.id}/approve`);
    await admin.post(`/students/${me.id}/status`, { status: 'active' });
    await admin.put(`/students/${me.id}/teachers`, { teacherIds: [f.teacherA.teacher.id] });
    await admin.post(`/students/${me.id}/credits`, { month: '2026-10', delta: 4, note: '初回' });
    expect((await b.get(`/students/${me.id}/home`)).data.blocker).toBeNull();
    const booked = await b.post(`/students/${me.id}/reservations`, {
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: jst('2026-10-22', '15:00').toISOString(),
    });
    expect(booked.status).toBe(201);
  });

  test('招待コードは有効なものだけ使え、無効・期限切れは拒否される', async () => {
    const f = await setupHttp();
    const admin = await f.adminBrowser();
    await admin.patch('/settings', { inviteCodeRegistration: true });
    const code = (await admin.post('/invite-codes', { validDays: 30 })).data.code as string;
    const b = f.browser('student');
    expect((await b.get('/registration')).data).toEqual({ enabled: true, inviteCodeRequired: true });
    const base = { password: PASSWORD, studentName: '生徒', phone: '090' };
    expect((await b.post('/registration', { ...base, email: 'n1@example.test' })).status).toBe(400);
    expect((await b.post('/registration', { ...base, email: 'n1@example.test', inviteCode: 'WRONGCODE' })).status).toBe(400);
    expect((await b.post('/registration', { ...base, email: 'n1@example.test', inviteCode: code.toLowerCase() })).status).toBe(201);
    f.clock.now = new Date(f.clock.now.getTime() + 31 * 86_400_000);
    const expired = await b.post('/registration', { ...base, email: 'n2@example.test', inviteCode: code });
    expect(expired.status).toBe(400);
    expect(expired.data.error).toContain('有効期限');
  });
});
