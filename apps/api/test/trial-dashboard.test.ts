import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { availabilityRules, creditLedger, payments, students } from '../src/db/schema.js';
import { bookAsStudent, cancelAsAdmin, slotsForStudent } from '../src/domain/booking.js';
import { recordCashPayment } from '../src/domain/billing.js';
import { jst } from '../src/lib/time.js';
import { setupHttp } from './http.js';

async function trialWorld() {
  const f = await setupHttp();
  // 講師Aの金曜 10:00-12:00 を体験専用の枠にする
  await f.db.insert(availabilityRules).values({
    teacherId: f.teacherA.teacher.id,
    weekday: 5,
    startTime: '10:00',
    endTime: '12:00',
    lessonTypeId: f.privateType.id,
    forTrial: true,
  });
  const admin = await f.adminBrowser();
  const visitor = f.browser('student');
  return { f, admin, visitor };
}

const applicant = { name: '体験 太郎', email: 'trial@example.test', phone: '090-0000-0000', instrument: 'ピアノ', preferredTimes: '平日夕方' };

describe('TR-01 体験レッスンの申込', () => {
  test('申込が管理者に届き、管理者が代理予約できる。体験では回数を使わない', async () => {
    const { f, admin, visitor } = await trialWorld();
    const res = await visitor.post('/trial/requests', applicant);
    expect(res.status).toBe(201);
    expect(f.mail.sent.map((m) => m.to)).toEqual(['matsuda@example.test', 'trial@example.test']);
    const [req] = (await admin.get('/trial-requests')).data;
    expect(req).toMatchObject({ name: '体験 太郎', status: 'new' });
    const booked = await admin.post(`/trial-requests/${req.id}/reservations`, {
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: jst('2026-10-22', '15:00').toISOString(),
    });
    expect(booked.status).toBe(201);
    expect((await admin.get('/trial-requests')).data[0].status).toBe('scheduled');
    expect(f.mail.sent.at(-1)).toMatchObject({ to: 'trial@example.test', subject: expect.stringContaining('体験レッスンのご予約が確定') });
    expect(await f.db.select().from(creditLedger)).toHaveLength(0);
    const day = (await admin.get('/reservations?from=2026-10-22&to=2026-10-22')).data;
    expect(day.map((r: any) => r.trialRequestId)).toEqual([req.id]);
  });

  test('ボット確認に失敗した申込は受け付けない（NF-06）', async () => {
    const { f, visitor } = await trialWorld();
    f.captcha.ok = false;
    expect((await visitor.post('/trial/requests', applicant)).status).toBe(400);
  });
});

describe('TR-02 体験専用の枠の一般公開', () => {
  test('OFF のときは体験枠を表示・予約できない', async () => {
    const { visitor } = await trialWorld();
    expect((await visitor.get('/trial/slots')).status).toBe(404);
  });

  test('ON のときだけ体験枠が誰でも予約でき、通常の枠は表示されない', async () => {
    const { f, admin, visitor } = await trialWorld();
    await admin.patch('/settings', { trialPublicSlots: true });
    const slots = (await visitor.get('/trial/slots')).data;
    // 金曜（10/23、10/30 …）の 10:00 と 11:00 だけ。通常の枠（15:00-18:00）は出ない
    expect(slots.slice(0, 2).map((s: any) => s.startsAt)).toEqual([
      jst('2026-10-23', '10:00').toISOString(),
      jst('2026-10-23', '11:00').toISOString(),
    ]);
    expect(slots.every((s: any) => s.startsAt.endsWith('01:00:00.000Z') || s.startsAt.endsWith('02:00:00.000Z'))).toBe(true);
    const slot = { teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt: slots[0].startsAt };
    expect((await visitor.post('/trial/reservations', { ...applicant, slot })).status).toBe(201);
    // 同じ枠は2回予約できない
    expect((await visitor.post('/trial/reservations', { ...applicant, slot })).status).toBe(422);
    // 通常の枠を体験として予約しようとしても拒否される
    const normal = { ...slot, startsAt: jst('2026-10-23', '15:00').toISOString() };
    expect((await visitor.post('/trial/reservations', { ...applicant, slot: normal })).status).toBe(422);
    expect((await admin.get('/trial-requests')).data).toHaveLength(1);
  });

  test('生徒の予約画面には体験専用の枠が出ない', async () => {
    const { f } = await trialWorld();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const slots = await slotsForStudent(f.ctx, actor, student.id, f.teacherA.teacher.id, '2026-10-23', '2026-10-23');
    expect(slots.map((s) => s.startsAt)).toEqual([jst('2026-10-23', '15:00'), jst('2026-10-23', '16:00'), jst('2026-10-23', '17:00')]);
  });
});

describe('DB-01〜04 管理者のダッシュボード', () => {
  test('DB-01 状態別の人数が、生徒一覧の件数と一致する', async () => {
    const { f, admin } = await trialWorld();
    await f.mkStudent('在籍1');
    await f.mkStudent('在籍2');
    const s = await f.mkStudent('休会');
    await f.db.update(students).set({ status: 'suspended' }).where(eq(students.id, s.student.id));
    const counts = (await admin.get('/dashboard')).data.studentCounts;
    expect(counts).toEqual({ trial: 0, enrolling: 0, active: 2, suspended: 1, withdrawn: 0 });
    for (const status of ['active', 'suspended'] as const) {
      expect((await admin.get(`/students?status=${status}`)).data).toHaveLength(counts[status]);
    }
  });

  test('DB-02 今日と今週の予約に、予約の追加・取消が反映される', async () => {
    const { f, admin } = await trialWorld();
    f.clock.now = jst('2026-10-19', '10:00'); // 月曜
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const r = await bookAsStudent(f.ctx, actor, {
      studentId: student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: jst('2026-10-21', '15:00'),
    });
    let d = (await admin.get('/dashboard')).data.reservations;
    expect(d.week.map((x: any) => [x.studentName, x.teacherName])).toEqual([['太郎', '講師A']]);
    expect(d.today).toEqual([]);
    expect(d.weekStart).toBe('2026-10-19');
    await cancelAsAdmin(f.ctx, f.admin, r.id, { refund: true });
    d = (await admin.get('/dashboard')).data.reservations;
    expect(d.week).toEqual([]);
  });

  test('DB-03 未払い・決済失敗の生徒と猶予期間の残り日数。入金済みにすると消える', async () => {
    const { f, admin } = await trialWorld();
    f.clock.now = jst('2026-11-03', '10:00');
    const { student } = await f.mkStudent('太郎');
    await f.db
      .insert(payments)
      .values({ studentId: student.id, kind: 'monthly', method: 'cash', month: '2026-11', amount: 14300, status: 'pending' });
    let unpaid = (await admin.get('/dashboard')).data.unpaid;
    expect(unpaid.map((u: any) => [u.studentName, u.graceDaysLeft])).toEqual([['太郎', 5]]);
    await recordCashPayment(f.ctx, f.admin, { studentId: student.id, month: '2026-11' });
    unpaid = (await admin.get('/dashboard')).data.unpaid;
    expect(unpaid).toEqual([]);
  });

  test('DB-04 講師別の今月のレッスン数と講師都合キャンセル。月を切り替えて過去の月も見られる', async () => {
    const { f, admin } = await trialWorld();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    await bookAsStudent(f.ctx, actor, {
      studentId: student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: jst('2026-10-22', '15:00'),
    });
    const now = (await admin.get('/dashboard')).data.teacherStats;
    expect(now.month).toBe('2026-10');
    expect(now.teachers.find((t: any) => t.name === '講師A')).toMatchObject({ lessons: 1, teacherCancels: 0 });
    const past = (await admin.get('/dashboard?month=2026-09')).data.teacherStats;
    expect(past.teachers.find((t: any) => t.name === '講師A')).toMatchObject({ lessons: 0 });
  });
});
