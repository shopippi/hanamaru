import { describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { accounts, closures, creditLedger, notifications, payments, reservations, students } from '../src/db/schema.js';
import {
  createCourse,
  handlePaymentEvent,
  prepareMonth,
  recordCashPayment,
  savePackage,
  startEnrollment,
} from '../src/domain/billing.js';
import { authenticate, changePassword, login, requestPasswordReset, setPasswordWithToken } from '../src/domain/auth.js';
import { bookAsStudent, cancelAsStudent, decidePending } from '../src/domain/booking.js';
import { balance, closeMonth } from '../src/domain/credits.js';
import { changeStudentStatus, createStudent, importStudentsCsv, setTeacherActive, updateStudent } from '../src/domain/people.js';
import { createClosure } from '../src/domain/schedule.js';
import { updateSettings } from '../src/domain/settings.js';
import { bookTrialAsAdmin, submitTrialRequest } from '../src/domain/trial.js';
import { StripeGateway } from '../src/integrations/stripe.js';
import { totpCode } from '../src/lib/crypto.js';
import { jst } from '../src/lib/time.js';
import { setup } from './fixtures.js';
import { PASSWORD, setupHttp } from './http.js';

// 公開前の見直しで見つかった不具合の再発防止

/** 入会セットをカードで払い、自動課金を始めた生徒 */
async function cardStudent(now?: Date) {
  const f = await setupHttp(now);
  const course = await createCourse(f.ctx, f.admin, { name: '月4回コース', lessonsPerMonth: 4, amount: 14300 });
  const pkg = await savePackage(f.ctx, f.admin, null, { name: '入会金＋4回', admissionFee: 5500, lessonCount: 4, lessonsPrice: 14300 });
  const s = await f.mkStudent('太郎', { autopay: false });
  await f.db.update(students).set({ status: 'enrolling', courseId: course.id }).where(eq(students.id, s.student.id));
  await startEnrollment(f.ctx, s.actor, s.student.id, { packageId: pkg.id, method: 'card', agreed: true });
  const paymentId = f.gateway.checkouts.at(-1)!.paymentId;
  await handlePaymentEvent(f.ctx, { id: `evt_${paymentId}`, type: 'checkout_paid', paymentId, sessionId: 'cs', paymentMethodId: 'pm_card_visa' });
  const reload = async () => (await f.db.select().from(students).where(eq(students.id, s.student.id)))[0]!;
  const subId = (await reload()).stripeSubscriptionId!;
  const sub = () => f.gateway.subscriptions.find((x) => x.id === subId)!;
  return { f, course, pkg, ...s, reload, subId, sub };
}

const invoice = (subscriptionId: string, month: string, id: string, type: 'invoice_paid' | 'invoice_failed' = 'invoice_paid') =>
  type === 'invoice_paid'
    ? { id: `evt_${id}_${type}`, type, subscriptionId, invoiceId: id, periodStart: jst(`${month}-01`, '09:00'), amount: 14300 }
    : { id: `evt_${id}_${type}`, type, subscriptionId, invoiceId: id, periodStart: jst(`${month}-01`, '09:00'), amount: 14300, hostedUrl: null };

describe('PY-05 課金日のずれと、止めたあとの通知', () => {
  test('PY-05 課金日が日本時間の前月末にずれた請求も、その月の月謝として回数を付ける', async () => {
    const f = await setup(jst('2026-12-31', '10:00'));
    const { student } = await f.mkStudent('太郎');
    // 日本時間 12月31日 0:00（UTC 12月30日 15:00）に始まる期間の請求 = 1月分
    const r = await handlePaymentEvent(f.ctx, {
      id: 'evt_jan',
      type: 'invoice_paid',
      subscriptionId: 'sub_test',
      invoiceId: 'in_jan',
      periodStart: new Date('2026-12-30T15:00:00Z'),
      amount: 14300,
    });
    expect(r).toBe('processed');
    expect(await balance(f.db, student.id, '2027-01')).toBe(4);
    expect(await balance(f.db, student.id, '2026-12')).toBe(0);
  });

  test('PY-05 / ST-05 休会を予定して課金を止めたあとに届いた入金の通知も、その月の入金として反映する', async () => {
    const { f, student, subId } = await cardStudent();
    f.clock.now = jst('2026-11-01', '10:00');
    await handlePaymentEvent(f.ctx, invoice(subId, '2026-11', 'in_nov', 'invoice_failed'));
    await changeStudentStatus(f.ctx, f.admin, student.id, 'suspended');
    // Stripe の再試行で引き落とせた
    expect(await handlePaymentEvent(f.ctx, invoice(subId, '2026-11', 'in_nov'))).toBe('processed');
    expect(await balance(f.db, student.id, '2026-11')).toBe(4);
    const [p] = await f.db.select().from(payments).where(and(eq(payments.studentId, student.id), eq(payments.month, '2026-11')));
    expect(p!.status).toBe('succeeded');
  });

  test('PY-11 入金済みの月に遅れて失敗の通知が届いても、失敗のメールは送らない', async () => {
    const { f, subId } = await cardStudent();
    f.clock.now = jst('2026-11-01', '10:00');
    await handlePaymentEvent(f.ctx, invoice(subId, '2026-11', 'in_nov'));
    const before = f.mail.sent.length;
    await handlePaymentEvent(f.ctx, invoice(subId, '2026-11', 'in_nov', 'invoice_failed'));
    expect(f.mail.sent.slice(before).filter((m) => m.subject.includes('お支払いができませんでした'))).toEqual([]);
  });

  test('ST-05 自動課金が Stripe 側で終わったら、自動課金として扱わない', async () => {
    const { f, reload, subId } = await cardStudent();
    expect(await handlePaymentEvent(f.ctx, { id: 'evt_del', type: 'subscription_deleted', subscriptionId: subId } as never)).toBe('processed');
    expect((await reload()).stripeSubscriptionId).toBeNull();
  });
});

describe('ST-05 退会・休会の予定の取りやめ', () => {
  test('ST-05 予定していた休会を取りやめると、月末で止める設定にした自動課金を元に戻す', async () => {
    const { f, student, reload, subId, sub } = await cardStudent();
    await changeStudentStatus(f.ctx, f.admin, student.id, 'suspended');
    expect(sub().cancelAtPeriodEnd).toBe(true);
    await changeStudentStatus(f.ctx, f.admin, student.id, 'active');
    expect(sub().cancelAtPeriodEnd).toBe(false);
    const s = await reload();
    expect(s).toMatchObject({ status: 'active', scheduledStatus: null, stripeSubscriptionId: subId });
    // 新しいサブスクリプションは作らない（二重に課金しない）
    expect(f.gateway.subscriptions.filter((x) => x.id !== 'sub_test')).toHaveLength(1);
  });

  test('ST-05 退会の日より後の予約は、支払いのない月の分なので取り消して回数を戻す', async () => {
    const f = await setup(jst('2026-10-26', '10:00'));
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const oct = await bookAsStudent(f.ctx, actor, { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt: jst('2026-10-29', '15:00') });
    const nov = await bookAsStudent(f.ctx, actor, { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt: jst('2026-11-02', '15:00') });
    await changeStudentStatus(f.ctx, f.admin, student.id, 'withdrawn');
    const rows = await f.db.select().from(reservations).where(eq(reservations.studentId, student.id));
    expect(rows.find((r) => r.id === oct.id)!.status).toBe('confirmed');
    expect(rows.find((r) => r.id === nov.id)).toMatchObject({ status: 'cancelled' });
    expect(await balance(f.db, student.id, '2026-11')).toBe(0);
  });
});

describe('PY-03 サブスクリプションの二重作成', () => {
  test('PY-03 作成のあとで処理が失敗して通知が再送されても、サブスクリプションを二重に作らない', async () => {
    const f = await setupHttp();
    const course = await createCourse(f.ctx, f.admin, { name: '月4回コース', lessonsPerMonth: 4, amount: 14300 });
    const pkg = await savePackage(f.ctx, f.admin, null, { name: '入会金＋4回', admissionFee: 5500, lessonCount: 4, lessonsPrice: 14300 });
    const s = await f.mkStudent('太郎', { autopay: false });
    await f.db.update(students).set({ status: 'enrolling', courseId: course.id }).where(eq(students.id, s.student.id));
    await startEnrollment(f.ctx, s.actor, s.student.id, { packageId: pkg.id, method: 'card', agreed: true });
    const paymentId = f.gateway.checkouts.at(-1)!.paymentId;
    // Stripe ではできたのに、応答が届かず失敗した（タイムアウトなど）
    const create = f.gateway.createSubscription.bind(f.gateway);
    let first = true;
    f.gateway.createSubscription = async (input) => {
      const id = await create(input);
      if (first) {
        first = false;
        throw new Error('timeout');
      }
      return id;
    };
    const ev = { id: 'evt_enroll', type: 'checkout_paid' as const, paymentId, sessionId: 'cs', paymentMethodId: 'pm' };
    await expect(handlePaymentEvent(f.ctx, ev)).rejects.toThrow();
    expect(await handlePaymentEvent(f.ctx, ev)).toBe('processed');
    expect(f.gateway.subscriptions.filter((x) => x.id !== 'sub_test' && !x.cancelAtPeriodEnd)).toHaveLength(1);
  });
});

describe('PY-16 支払いリンク', () => {
  test('PY-16 支払いリンクの作成に失敗しても、ほかの生徒の請求は作り、次の実行で作り直して送る', async () => {
    const f = await setup(jst('2026-11-01', '00:10'));
    const course = await createCourse(f.ctx, f.admin, { name: '月4回コース', lessonsPerMonth: 4, amount: 14300 });
    const a = await f.mkStudent('太郎', { autopay: false });
    const b = await f.mkStudent('花子', { autopay: false });
    for (const s of [a, b]) {
      await f.db.update(students).set({ courseId: course.id, billingMethod: 'konbini' }).where(eq(students.id, s.student.id));
    }
    f.gateway.failNext = true;
    await expect(prepareMonth(f.ctx, '2026-11')).rejects.toThrow();
    expect(await f.db.select().from(payments)).toHaveLength(2);
    await prepareMonth(f.ctx, '2026-11');
    const rows = await f.db.select().from(payments);
    expect(rows.every((p) => p.stripeCheckoutSessionId)).toBe(true);
    expect(f.mail.sent.filter((m) => m.subject.includes('月謝のお支払いのお願い'))).toHaveLength(2);
    // 3回目は何もしない
    await prepareMonth(f.ctx, '2026-11');
    expect(f.mail.sent.filter((m) => m.subject.includes('月謝のお支払いのお願い'))).toHaveLength(2);
  });
});

describe('PY-06 / PY-14 / SR-01 生徒の編集と現金の入金', () => {
  test('SR-01 編集で送らなかった項目（支払い方法・LINE）は変わらない', async () => {
    const f = await setup();
    const { student } = await f.mkStudent('太郎', { autopay: false });
    await f.db.update(students).set({ billingMethod: 'konbini', lineUserId: 'U123' }).where(eq(students.id, student.id));
    await updateStudent(f.ctx, f.admin, student.id, { phone: '090-0000-0000' });
    const [s] = await f.db.select().from(students).where(eq(students.id, student.id));
    expect(s).toMatchObject({ billingMethod: 'konbini', lineUserId: 'U123', phone: '090-0000-0000' });
  });

  test('PY-14 コースを変えると、次回の課金から新しいコースの料金になる', async () => {
    const { f, student, sub } = await cardStudent();
    const big = await createCourse(f.ctx, f.admin, { name: '月8回コース', lessonsPerMonth: 8, amount: 26000 });
    await updateStudent(f.ctx, f.admin, student.id, { courseId: big.id });
    expect(f.gateway.prices.find((p) => p.id === sub().priceId)!.amount).toBe(26000);
  });

  test('PY-06 カード払いをやめて現金にすると、自動課金を月末で止める', async () => {
    const { f, student, sub, reload } = await cardStudent();
    await updateStudent(f.ctx, f.admin, student.id, { billingMethod: 'cash' });
    expect(sub().cancelAtPeriodEnd).toBe(true);
    expect((await reload()).stripeSubscriptionId).toBeNull();
  });

  test('PY-06 現金で入金済みにした月のカードの請求は取り消し、あとから引き落とされたら教室に知らせる', async () => {
    const { f, student, subId } = await cardStudent();
    f.clock.now = jst('2026-11-02', '10:00');
    await handlePaymentEvent(f.ctx, invoice(subId, '2026-11', 'in_nov', 'invoice_failed'));
    await recordCashPayment(f.ctx, f.admin, { studentId: student.id, month: '2026-11' });
    expect(f.gateway.voided).toEqual(['in_nov']);
    await handlePaymentEvent(f.ctx, invoice(subId, '2026-11', 'in_nov'));
    const alert = f.mail.sent.find((m) => m.subject.includes('入金済みの月にカードの課金'));
    expect(alert?.to).toBe('matsuda@example.test');
    expect(await balance(f.db, student.id, '2026-11')).toBe(4);
  });
});

describe('RS-01 / RS-06 / RS-08 予約の取り合い', () => {
  test('RS-01 回数が1回の生徒が、別々の講師の枠を同時に予約しても、1件だけ予約できる', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 1, teachers: [f.teacherA.teacher.id, f.teacherB.teacher.id] });
    const results = await Promise.allSettled([
      bookAsStudent(f.ctx, actor, { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt: jst('2026-10-28', '15:00') }),
      bookAsStudent(f.ctx, actor, { studentId: student.id, teacherId: f.teacherB.teacher.id, lessonTypeId: f.privateType.id, startsAt: jst('2026-10-28', '16:00') }),
      bookAsStudent(f.ctx, actor, { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt: jst('2026-10-29', '15:00') }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await balance(f.db, student.id, '2026-10')).toBe(0);
  });

  test('RS-01 同じ生徒は、同じ時間に2つの予約を持てない（グループの2席目も）', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const slot = { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.groupType.id, startsAt: jst('2026-10-24', '10:00') };
    await bookAsStudent(f.ctx, actor, slot);
    await expect(bookAsStudent(f.ctx, actor, slot)).rejects.toThrow('すでに別の予約があります');
    expect(await balance(f.db, student.id, '2026-10')).toBe(3);
  });

  test('RS-06 確認のあとに生徒が取り消した仮予約は、承認しても確定に戻らない', async () => {
    const f = await setup();
    await updateSettings(f.db, { approvalRequired: true }, null);
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const r = await bookAsStudent(f.ctx, actor, { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt: jst('2026-10-28', '15:00') });
    // 管理者が仮予約を読み込んだあと、承認の書き込みの直前に生徒が取り消す
    const db = f.ctx.db;
    const original = db.transaction.bind(db);
    (db as { transaction: unknown }).transaction = async (...args: Parameters<typeof db.transaction>) => {
      (db as { transaction: unknown }).transaction = original;
      await cancelAsStudent(f.ctx, actor, r.id);
      return original(...args);
    };
    await expect(decidePending(f.ctx, f.admin, r.id, true)).rejects.toThrow();
    const [row] = await f.db.select().from(reservations).where(eq(reservations.id, r.id));
    expect(row!.status).toBe('cancelled');
    expect(await balance(f.db, student.id, '2026-10')).toBe(4);
  });

  test('TC-04 無効にした講師の枠は、新しく予約できない', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    await setTeacherActive(f.ctx, f.admin, f.teacherA.teacher.id, false);
    await expect(
      bookAsStudent(f.ctx, actor, { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt: jst('2026-10-28', '15:00') }),
    ).rejects.toThrow();
  });
});

describe('AV-04 / NT-01 休講', () => {
  test('AV-04 休講を作っても、始まったレッスンは取り消さず、過ぎた日は休講にできない', async () => {
    const f = await setup(jst('2026-10-20', '10:00'));
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    // 前日の締切より前に予約しておく
    f.clock.now = jst('2026-10-19', '10:00');
    const early = await bookAsStudent(f.ctx, actor, { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt: jst('2026-10-21', '15:00') });
    const later = await bookAsStudent(f.ctx, actor, { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt: jst('2026-10-21', '17:00') });
    f.clock.now = jst('2026-10-21', '15:30');
    const { cancelled } = await createClosure(f.ctx, f.admin, { date: '2026-10-21', reason: '臨時休講' });
    expect(cancelled).toBe(1);
    const rows = await f.db.select().from(reservations).where(eq(reservations.studentId, student.id));
    expect(rows.find((r) => r.id === early.id)!.status).toBe('confirmed');
    expect(rows.find((r) => r.id === later.id)!.status).toBe('cancelled');
    await expect(createClosure(f.ctx, f.admin, { date: '2026-10-20' })).rejects.toThrow('過ぎた日');
  });

  test('NT-01 体験レッスンの予約が取り消されたら、申込者にもメールで知らせる', async () => {
    const f = await setup();
    const { id } = await submitTrialRequest(f.ctx, { name: '体験 花子', email: 'trial@example.test' });
    await bookTrialAsAdmin(f.ctx, f.admin, id, { teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt: jst('2026-10-28', '15:00') });
    await createClosure(f.ctx, f.admin, { date: '2026-10-28' });
    const mail = f.mail.sent.filter((m) => m.to === 'trial@example.test').at(-1)!;
    expect(mail.subject).toContain('体験レッスンの予約を取り消しました');
    expect(mail.text).toContain('教室の都合・休講');
  });

  test('OP-03 管理画面から休講を削除できる（本文のない削除を受け付ける）', async () => {
    const f = await setupHttp();
    const b = await f.adminBrowser();
    const created = await b.post('/closures', { date: '2026-11-03', reason: '祝日' });
    expect(created.status).toBe(201);
    expect((await b.del(`/closures/${created.data.closure.id}`)).status).toBeLessThan(300);
    expect(await f.db.select().from(closures)).toHaveLength(0);
    // 本文のある状態変更は、引き続き JSON だけを受け付ける
    const form = await f.app.request(`/api/manage/closures/${created.data.closure.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=1',
    });
    expect(form.status).toBe(415);
  });
});

describe('AU-03 / AU-05 / AU-06 ログイン', () => {
  test('AU-05 公開の生徒の画面で管理者のメールを何度間違えても、管理者はロックされない', async () => {
    const f = await setupHttp();
    await f.setPassword(f.adminAccount.id);
    for (let i = 0; i < 8; i++) {
      await expect(login(f.ctx, 'student', f.adminAccount.email, 'wrong-password')).rejects.toThrow('メールアドレスまたはパスワードが正しくありません');
    }
    const r = await login(f.ctx, 'admin', f.adminAccount.email, PASSWORD);
    expect(r.mfa).toBe('setup');
  });

  test('AU-06 確認コードは一度しか使えず、続けて間違えるとロックし、確認待ちのログインも切る', async () => {
    const f = await setupHttp();
    await f.setPassword(f.adminAccount.id);
    const b = f.browser('manage');
    await b.login(f.adminAccount.email);
    const { secret } = (await b.post('/auth/mfa/setup')).data;
    const code = totpCode(secret, f.clock.now);
    expect((await b.post('/auth/mfa/verify', { code })).status).toBe(200);
    // 同じコードの使い回し
    const replay = f.browser('manage');
    await replay.login(f.adminAccount.email);
    expect((await replay.post('/auth/mfa/verify', { code })).status).toBe(401);
    // 総当たり
    const attacker = f.browser('manage');
    await attacker.login(f.adminAccount.email);
    // 使い回しの1回と合わせて、5回目の失敗でロックする（AU-05 と同じ上限）
    const errors: string[] = [];
    for (let i = 0; i < 4; i++) errors.push((await attacker.post('/auth/mfa/verify', { code: String(100000 + i) })).data.error);
    expect(errors.at(-1)).toContain('一時的にログインできません');
    f.clock.now = new Date(f.clock.now.getTime() + 60_000);
    expect((await attacker.post('/auth/mfa/verify', { code: totpCode(secret, f.clock.now) })).status).toBe(401);
    const [a] = await f.db.select().from(accounts).where(eq(accounts.id, f.adminAccount.id));
    expect(a!.lockedUntil!.getTime()).toBeGreaterThan(f.clock.now.getTime());
  });

  test('AU-03 パスワードを変えると、ほかの端末のログインと使っていない再設定リンクは無効になる', async () => {
    const f = await setupHttp();
    const { account } = await f.mkStudent('太郎');
    await f.setPassword(account.id);
    const here = await login(f.ctx, 'student', account.email, PASSWORD);
    const there = await login(f.ctx, 'student', account.email, PASSWORD);
    await requestPasswordReset(f.ctx, 'student', account.email);
    const token = /token=([\w-]+)/.exec(f.mail.sent.at(-1)!.text)![1]!;
    const auth = (await authenticate(f.ctx, 'student', here.token))!;
    await changePassword(f.ctx, auth, PASSWORD, 'new-password-1');
    expect(await authenticate(f.ctx, 'student', here.token)).not.toBeNull();
    expect(await authenticate(f.ctx, 'student', there.token)).toBeNull();
    await expect(setPasswordWithToken(f.ctx, token, 'attacker-pass-1')).rejects.toThrow();
  });
});

describe('NT-02 招待・再設定のメール', () => {
  test('NT-02 招待のメールは「送らない」にできず、送信記録にはリンクを残さない', async () => {
    const f = await setup();
    await updateSettings(f.db, { notifications: { invite: false } }, null);
    await createStudent(f.ctx, f.admin, { accountEmail: 'new@example.test', name: '新しい生徒' });
    const mail = f.mail.sent.find((m) => m.to === 'new@example.test');
    expect(mail?.text).toMatch(/token=[\w-]{20,}/);
    const [row] = await f.db.select().from(notifications).where(eq(notifications.recipient, 'new@example.test'));
    expect(row!.status).toBe('sent');
    expect(row!.body).not.toMatch(/token=[\w-]{20,}/);
  });
});

describe('PY-07 / ST-01 締めと一括登録', () => {
  test('PY-07 締めた月にあとから回数が戻っても、繰越は上限を超えない', async () => {
    const f = await setup(jst('2026-11-01', '00:10'));
    await updateSettings(f.db, { carryoverEnabled: true, carryoverMax: 1 }, null);
    const { student } = await f.mkStudent('太郎');
    await f.grant(student.id, '2026-10', 3);
    await closeMonth(f.ctx, '2026-10');
    expect(await balance(f.db, student.id, '2026-11')).toBe(1);
    // 締めたあとの返金（講師都合の取消など）
    await f.db.insert(creditLedger).values({ studentId: student.id, month: '2026-10', delta: 1, reason: 'refund' });
    await closeMonth(f.ctx, '2026-10');
    expect(await balance(f.db, student.id, '2026-11')).toBe(1);
    expect(await balance(f.db, student.id, '2026-10')).toBe(0);
  });

  test('ST-01 CSV の途中の行が登録できないときは、何も登録せず招待も送らない', async () => {
    const f = await setup();
    const before = (await f.db.select().from(students)).length;
    const csv = [
      'ログインメール,保護者名,生徒名,電話番号,生徒のメール,住所',
      'ok@example.test,山田,山田 一郎,,,',
      `${f.teacherA.account.email},講師,講師の子,,,`,
    ].join('\n');
    const r = await importStudentsCsv(f.ctx, f.admin, csv);
    expect(r).toEqual({ created: 0, errors: [{ line: 3, message: expect.stringContaining('講師・管理者') }] });
    expect(await f.db.select().from(students)).toHaveLength(before);
    expect(f.mail.sent.filter((m) => m.to === 'ok@example.test')).toEqual([]);
  });
});

describe('PY-13 カード管理画面', () => {
  test('PY-13 解約できない設定（STRIPE_PORTAL_CONFIGURATION_ID）がなければ、カード管理画面を開かない', async () => {
    const gw = new StripeGateway('sk_test_dummy', 'whsec_x', undefined);
    await expect(gw.billingPortalUrl('cus_1', 'https://student.example.test/')).rejects.toThrow('STRIPE_PORTAL_CONFIGURATION_ID');
  });

  test('ST-05 Stripe のサブスクリプション終了の通知を読み取る', async () => {
    const secret = 'whsec_test_secret';
    const gw = new StripeGateway('sk_test_dummy', secret, 'bpc_1');
    const raw = JSON.stringify({ id: 'evt_sub_del', object: 'event', type: 'customer.subscription.deleted', data: { object: { id: 'sub_9', object: 'subscription' } } });
    const header = new Stripe('sk_test_dummy').webhooks.generateTestHeaderString({ payload: raw, secret });
    expect(await gw.parseWebhook(raw, header)).toEqual({ id: 'evt_sub_del', type: 'subscription_deleted', subscriptionId: 'sub_9' });
  });
});
