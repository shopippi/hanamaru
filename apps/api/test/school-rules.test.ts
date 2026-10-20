import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { availabilityRules, creditLedger, lessonTypes, students } from '../src/db/schema.js';
import { listSlots } from '../src/domain/availability.js';
import { createCourse, enrollmentOptions, savePackage, startEnrollment } from '../src/domain/billing.js';
import { bookAsStudent, cancelAsStudent, cancelPreview } from '../src/domain/booking.js';
import { balance, carriedRemaining, closeMonth } from '../src/domain/credits.js';
import { studentHome } from '../src/domain/home.js';
import { createClosure } from '../src/domain/schedule.js';
import { cancelDeadlineLabel, cancelDeadlineOf, getSettings, updateSettings } from '../src/domain/settings.js';
import { bookTrialAsAdmin, submitTrialRequest } from '../src/domain/trial.js';
import { jst } from '../src/lib/time.js';
import { setup } from './fixtures.js';

// 教室の決まり（オーナーからの情報）: キャンセルは前日20時まで、余った回数は翌月末まで、
// 入会金なし、体験レッスンの料金は当日現金、ピアノは対面かオンラインを選ぶ

const THU = jst('2026-10-22', '15:00');

describe('RS-04 キャンセルの締切は「レッスンの前日20時まで」', () => {
  test('RS-04 初期設定の締切は前日の20時（日本時間）。日付をまたぐ時刻でも、レッスンの日の前の日になる', async () => {
    const f = await setup();
    const s = await getSettings(f.db);
    expect(cancelDeadlineLabel(s)).toBe('レッスンの前日20時まで');
    expect(cancelDeadlineOf(s, jst('2026-10-22', '15:00'))).toEqual(jst('2026-10-21', '20:00'));
    expect(cancelDeadlineOf(s, jst('2026-10-23', '00:30'))).toEqual(jst('2026-10-22', '20:00'));
    expect(cancelDeadlineOf(s, jst('2026-11-01', '10:00'))).toEqual(jst('2026-10-31', '20:00'));
    expect(cancelDeadlineOf(s, jst('2027-01-01', '10:00'))).toEqual(jst('2026-12-31', '20:00'));
  });

  test('RS-04 前日19:59・20:00 のキャンセルは回数が戻り、20:01 は戻らない', async () => {
    for (const [at, refund] of [
      ['19:59', true],
      ['20:00', true],
      ['20:01', false],
    ] as const) {
      const f = await setup();
      const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
      const r = await bookAsStudent(f.ctx, actor, { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt: THU });
      f.clock.now = jst('2026-10-21', at);
      const preview = await cancelPreview(f.ctx, actor, r.id);
      expect(preview).toMatchObject({ refund, deadline: jst('2026-10-21', '20:00'), deadlineLabel: 'レッスンの前日20時まで' });
      expect(await cancelAsStudent(f.ctx, actor, r.id)).toEqual({ refunded: refund });
      expect(await balance(f.db, student.id, '2026-10')).toBe(refund ? 4 : 3);
    }
  });

  test('RS-04 「何時間前まで」の決め方に戻すこともできる', async () => {
    const f = await setup();
    await updateSettings(f.db, { cancelDeadlineMode: 'hoursBefore', cancelDeadlineHours: 24 }, null);
    const s = await getSettings(f.db);
    expect(cancelDeadlineLabel(s)).toBe('レッスンの24時間前まで');
    expect(cancelDeadlineOf(s, THU)).toEqual(jst('2026-10-21', '15:00'));
  });
});

describe('PY-07 余った回数は翌月末まで使える', () => {
  const consume = (f: Awaited<ReturnType<typeof setup>>, studentId: string, month: string, n: number) =>
    f.db.insert(creditLedger).values({ studentId, month, delta: -n, reason: 'consume' });

  test('PY-07 初期設定では、10月に余った回数はすべて11月に繰り越し、11月末で消える（繰り越しは1か月まで）', async () => {
    const f = await setup();
    const { student } = await f.mkStudent('太郎', { credits: 4 });
    await consume(f, student.id, '2026-10', 1);
    await closeMonth(f.ctx, '2026-10');
    expect(await balance(f.db, student.id, '2026-11')).toBe(3);
    expect(await carriedRemaining(f.db, student.id, '2026-11')).toBe(3);
    // 11月は4回付いたが1回も使わなかった: 繰り越しの3回は11月末で消え、11月の4回だけが12月へ
    await f.grant(student.id, '2026-11', 4);
    await closeMonth(f.ctx, '2026-11');
    expect(await balance(f.db, student.id, '2026-12')).toBe(4);
    expect(await carriedRemaining(f.db, student.id, '2026-12')).toBe(4);
  });

  test('PY-07 予約は繰り越した回数から先に使う。11月の分が残れば、その分だけ12月へ', async () => {
    const f = await setup();
    const { student } = await f.mkStudent('太郎', { credits: 2 });
    await closeMonth(f.ctx, '2026-10'); // 2回を11月へ
    await f.grant(student.id, '2026-11', 4);
    await consume(f, student.id, '2026-11', 3); // 繰越2回 + 11月の1回
    expect(await carriedRemaining(f.db, student.id, '2026-11')).toBe(0);
    await closeMonth(f.ctx, '2026-11');
    expect(await balance(f.db, student.id, '2026-12')).toBe(3);
  });

  test('PY-07 締めたあとに同じ月を締め直しても、二重に繰り越さない', async () => {
    const f = await setup();
    const { student } = await f.mkStudent('太郎', { credits: 4 });
    await closeMonth(f.ctx, '2026-10');
    await closeMonth(f.ctx, '2026-10');
    expect(await balance(f.db, student.id, '2026-11')).toBe(4);
  });

  test('PY-07 トップには、残り回数のうち先月からの分を出す', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 2 });
    await closeMonth(f.ctx, '2026-10');
    f.clock.now = jst('2026-11-02', '10:00');
    await f.grant(student.id, '2026-11', 4);
    const home = await studentHome(f.ctx, actor, student.id);
    expect(home).toMatchObject({ remaining: 6, carried: 2 });
  });
});

describe('RS-09 オンラインのレッスン', () => {
  async function withOnline() {
    const f = await setup();
    const [online] = await f.db
      .insert(lessonTypes)
      .values({ name: 'ポピュラーピアノ（オンライン）60分', kind: 'private', durationMinutes: 60, online: true })
      .returning();
    // 講師A: 毎日 15:00-23:00 にオンライン（教室の受付は平日21時まで、日曜は休み）
    for (let wd = 0; wd <= 6; wd++) {
      await f.db.insert(availabilityRules).values({ teacherId: f.teacherA.teacher.id, weekday: wd, startTime: '15:00', endTime: '23:00', lessonTypeId: online!.id });
    }
    return { f, online: online! };
  }

  test('RS-09 オンラインは教室の受付時間に関係なく、講師の空き時間で予約できる（日曜・21時以降も）', async () => {
    const { f, online } = await withOnline();
    const slots = await listSlots(f.db, { teacherIds: [f.teacherA.teacher.id], from: '2026-10-25', to: '2026-10-26' });
    const onlineTimes = slots.filter((s) => s.lessonTypeId === online.id).map((s) => s.startsAt.toISOString());
    expect(onlineTimes).toContain(jst('2026-10-25', '15:00').toISOString()); // 日曜（教室は休み）
    expect(onlineTimes).toContain(jst('2026-10-26', '22:00').toISOString()); // 月曜 22時（教室は21時まで）
    // 対面のレッスンは教室の休みの日には出ない
    expect(slots.some((s) => s.lessonTypeId === f.privateType.id && s.startsAt.getTime() === jst('2026-10-25', '15:00').getTime())).toBe(false);
  });

  test('RS-09 講師は同じ時間に対面とオンラインの両方を受けられない', async () => {
    const { f, online } = await withOnline();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    await bookAsStudent(f.ctx, actor, { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt: THU });
    const slots = await listSlots(f.db, { teacherIds: [f.teacherA.teacher.id], from: '2026-10-22', to: '2026-10-22' });
    expect(slots.some((s) => s.lessonTypeId === online.id && s.startsAt.getTime() === THU.getTime())).toBe(false);
    const { student: other, actor: otherActor } = await f.mkStudent('花子', { credits: 4 });
    await expect(
      bookAsStudent(f.ctx, otherActor, { studentId: other.id, teacherId: f.teacherA.teacher.id, lessonTypeId: online.id, startsAt: THU }),
    ).rejects.toThrow();
  });

  test('RS-09 / AV-04 休講日はオンラインも予約できない', async () => {
    const { f, online } = await withOnline();
    await createClosure(f.ctx, f.admin, { date: '2026-10-26', reason: '臨時休講' });
    const slots = await listSlots(f.db, { teacherIds: [f.teacherA.teacher.id], from: '2026-10-26', to: '2026-10-26' });
    expect(slots.filter((s) => s.lessonTypeId === online.id)).toHaveLength(0);
  });

  test('RS-09 オンラインの予約の確定メールには、参加用のURLは講師から連絡することを書く', async () => {
    const { f, online } = await withOnline();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    await bookAsStudent(f.ctx, actor, { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: online.id, startsAt: jst('2026-10-26', '22:00') });
    const mail = f.mail.sent.find((m) => m.subject.includes('予約確定'))!;
    expect(mail.text).toContain('（オンライン）');
    expect(mail.text).toContain('参加用のURLは講師からご連絡します');
  });
});

describe('PY-03 入会金なし', () => {
  test('PY-03 入会金0円の入会セットで、最初の月の月謝だけを払える。画面の契約の内容にも入会金は出さない', async () => {
    const f = await setup();
    const course = await createCourse(f.ctx, f.admin, { name: '1h×月3回コース', lessonsPerMonth: 3, amount: 15000 });
    const pkg = await savePackage(f.ctx, f.admin, null, { name: '1h×月3回（最初の月）', admissionFee: 0, lessonCount: 3, lessonsPrice: 15000 });
    const { student, actor } = await f.mkStudent('太郎', { autopay: false });
    await f.db.update(students).set({ status: 'enrolling', courseId: course.id }).where(eq(students.id, student.id));
    const opts = await enrollmentOptions(f.ctx, actor, student.id);
    expect(opts.packages[0]).toMatchObject({ admissionFee: 0, total: 15000 });
    await startEnrollment(f.ctx, actor, student.id, { packageId: pkg.id, method: 'card', agreed: true });
    expect(f.gateway.checkouts.at(-1)).toMatchObject({ amount: 15000 });
  });
});

describe('TR-01 体験レッスンの料金は当日に教室で', () => {
  test('TR-01 申込の受付と予約確定のメールに、料金は当日教室で払うことを書く（金額はコードに持たない）', async () => {
    const f = await setup();
    const req = await submitTrialRequest(f.ctx, { name: '体験 花子', email: 'trial@example.test' });
    expect(f.mail.sent.find((m) => m.to === 'trial@example.test')!.text).toContain('料金は、当日教室でお支払いください');
    await bookTrialAsAdmin(f.ctx, f.admin, req.id, { teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt: THU });
    const confirmed = f.mail.sent.filter((m) => m.to === 'trial@example.test').at(-1)!;
    expect(confirmed.subject).toContain('ご予約が確定しました');
    expect(confirmed.text).toContain('料金は、当日教室でお支払いください');
  });
});
