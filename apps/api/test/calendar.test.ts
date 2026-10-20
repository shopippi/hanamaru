import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { reservations, schoolHours } from '../src/db/schema.js';
import { listSlots } from '../src/domain/availability.js';
import { bookAsStudent, createSeries } from '../src/domain/booking.js';
import { balance } from '../src/domain/credits.js';
import { DomainError } from '../src/domain/errors.js';
import { schoolCalendar, setSchoolHours, setTeacherDay, teacherCalendar } from '../src/domain/schedule.js';
import { updateSettings } from '../src/domain/settings.js';
import { publicTrialSlots } from '../src/domain/trial.js';
import { jst, timeOf } from '../src/lib/time.js';
import { setup } from './fixtures.js';

// 不定休の教室: 教室の受付時間（AV-06）と講師の日ごとの空き時間（AV-07）が両方空いている時間だけ予約できる（AV-08）

const WED = '2026-10-28'; // 講師A: 毎週の型は 15:00〜18:00（個人60分）

async function expectError(p: Promise<unknown>, code: DomainError['code'], message?: RegExp) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(DomainError);
  expect((e as DomainError).code).toBe(code);
  if (message) expect((e as DomainError).message).toMatch(message);
}

async function times(f: Awaited<ReturnType<typeof setup>>, teacherId: string, date: string) {
  const slots = await listSlots(f.db, { teacherIds: [teacherId], from: date, to: date });
  return slots.filter((s) => s.booked < s.capacity).map((s) => timeOf(s.startsAt));
}

describe('AV-06 教室の受付時間（日付ごと）', () => {
  test('AV-06 受付時間のない日は、講師が空いていても枠が出ず、予約もできない', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    expect(await times(f, f.teacherA.teacher.id, WED)).toEqual(['15:00', '16:00', '17:00']);
    expect((await setSchoolHours(f.ctx, f.admin, { dates: [WED], windows: [] }, false)).applied).toBe(true);
    expect(await times(f, f.teacherA.teacher.id, WED)).toEqual([]);
    await expectError(
      bookAsStudent(f.ctx, actor, { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt: jst(WED, '15:00') }),
      'rule',
    );
  });

  test('AV-08 講師の空き時間と教室の受付時間が両方空いている時間だけが枠になる（1日に複数の時間帯も）', async () => {
    const f = await setup();
    await setSchoolHours(f.ctx, f.admin, { dates: [WED], windows: [{ startTime: '16:00', endTime: '17:00' }] }, false);
    expect(await times(f, f.teacherA.teacher.id, WED)).toEqual(['16:00']);
    await setSchoolHours(
      f.ctx,
      f.admin,
      { dates: [WED], windows: [{ startTime: '10:00', endTime: '15:30' }, { startTime: '16:00', endTime: '21:00' }] },
      false,
    );
    // 15:00〜15:30 は60分に足りないので枠にならない
    expect(await times(f, f.teacherA.teacher.id, WED)).toEqual(['16:00', '17:00']);
  });

  test('AV-06 複数の日をまとめて同じ時間にでき、カレンダーに日ごとの時間帯と予約の件数が出る', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    await bookAsStudent(f.ctx, actor, { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt: jst(WED, '15:00') });
    await setSchoolHours(f.ctx, f.admin, { dates: ['2026-10-26', '2026-10-27'], windows: [{ startTime: '13:00', endTime: '19:00' }] }, false);
    const cal = await schoolCalendar(f.ctx, f.admin, '2026-10');
    expect(cal.days).toHaveLength(31);
    const day = (d: string) => cal.days.find((x) => x.date === d)!;
    expect(day('2026-10-26').windows).toEqual([{ startTime: '13:00', endTime: '19:00' }]);
    expect(day('2026-10-27').windows).toEqual([{ startTime: '13:00', endTime: '19:00' }]);
    expect(day('2026-10-25').windows).toEqual([]); // 日曜
    expect(day(WED).reservations).toBe(1);
  });

  test('AV-06 / AV-02 予約が受付時間の外になる変更は、確認するまで何も変えず、予約の一覧を返す', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    await bookAsStudent(f.ctx, actor, { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt: jst(WED, '15:00') });
    const res = await setSchoolHours(f.ctx, f.admin, { dates: [WED], windows: [{ startTime: '16:00', endTime: '21:00' }] }, false);
    expect(res.applied).toBe(false);
    expect(res.affected.map((a) => a.studentName)).toEqual(['太郎']);
    const rows = await f.db.select().from(schoolHours).where(eq(schoolHours.date, WED));
    expect(rows.map((r) => [r.startTime, r.endTime])).toEqual([['10:00', '21:00']]);
  });

  test('AV-06 / AV-04 確認して受付時間を変えると、外になった予約は教室都合で取り消し、回数を戻して知らせる', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const r = await bookAsStudent(f.ctx, actor, { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt: jst(WED, '15:00') });
    expect(await balance(f.db, student.id, '2026-10')).toBe(3);
    const res = await setSchoolHours(f.ctx, f.admin, { dates: [WED], windows: [] }, true);
    expect(res.applied).toBe(true);
    expect(res.affected).toHaveLength(1);
    const [after] = await f.db.select().from(reservations).where(eq(reservations.id, r.id));
    expect(after).toMatchObject({ status: 'cancelled', cancelKind: 'school' });
    expect(await balance(f.db, student.id, '2026-10')).toBe(4);
    expect(f.mail.sent.some((m) => m.to === '太郎@example.test')).toBe(true);
  });

  test('AV-06 受付時間の中に収まる予約は、時間を変えてもそのまま', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const r = await bookAsStudent(f.ctx, actor, { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt: jst(WED, '16:00') });
    const res = await setSchoolHours(f.ctx, f.admin, { dates: [WED], windows: [{ startTime: '16:00', endTime: '17:00' }] }, false);
    expect(res).toEqual({ applied: true, affected: [] });
    const [after] = await f.db.select().from(reservations).where(eq(reservations.id, r.id));
    expect(after!.status).toBe('confirmed');
  });

  test('AV-06 過ぎた日・重なる時間帯・終了が開始より前は受け付けない', async () => {
    const f = await setup();
    await expectError(setSchoolHours(f.ctx, f.admin, { dates: ['2026-10-19'], windows: [] }, false), 'validation', /過ぎた日/);
    await expectError(
      setSchoolHours(f.ctx, f.admin, { dates: [WED], windows: [{ startTime: '10:00', endTime: '15:00' }, { startTime: '14:00', endTime: '18:00' }] }, false),
      'validation',
      /重なって/,
    );
    await expectError(setSchoolHours(f.ctx, f.admin, { dates: [WED], windows: [{ startTime: '18:00', endTime: '10:00' }] }, false), 'validation');
    await expectError(setSchoolHours(f.ctx, f.admin, { dates: [], windows: [] }, false), 'validation');
  });

  test('AV-06 教室の受付時間を変えられるのは管理者だけ', async () => {
    const f = await setup();
    const { actor } = await f.mkStudent('太郎');
    await expectError(setSchoolHours(f.ctx, f.teacherA.actor, { dates: [WED], windows: [] }, true), 'forbidden');
    await expectError(setSchoolHours(f.ctx, actor, { dates: [WED], windows: [] }, true), 'forbidden');
    await expectError(schoolCalendar(f.ctx, f.teacherA.actor, '2026-10'), 'forbidden');
  });
});

describe('AV-07 講師の日ごとの空き時間', () => {
  test('AV-07 日ごとに決めた日は、毎週の型を使わずその日の時間だけが空きになる。毎週の型に戻せる', async () => {
    const f = await setup();
    const t = f.teacherA;
    const day = { date: WED, windows: [{ startTime: '19:00', endTime: '21:00', lessonTypeId: f.privateType.id }] };
    expect((await setTeacherDay(f.ctx, t.actor, t.teacher.id, day, false)).applied).toBe(true);
    expect(await times(f, t.teacher.id, WED)).toEqual(['19:00', '20:00']);
    // ほかの水曜日は毎週の型のまま
    expect(await times(f, t.teacher.id, '2026-11-04')).toEqual(['15:00', '16:00', '17:00']);
    const cal = await teacherCalendar(f.ctx, t.actor, t.teacher.id, '2026-10');
    const wed = cal.days.find((d) => d.date === WED)!;
    expect(wed.overridden).toBe(true);
    expect(wed.windows.map((w) => [w.startTime, w.endTime])).toEqual([['19:00', '21:00']]);
    expect(wed.school).toEqual([{ startTime: '10:00', endTime: '21:00' }]);

    // 空の時間帯で、その日は休み
    await setTeacherDay(f.ctx, t.actor, t.teacher.id, { date: WED, windows: [] }, false);
    expect(await times(f, t.teacher.id, WED)).toEqual([]);
    // 毎週の型に戻す
    await setTeacherDay(f.ctx, t.actor, t.teacher.id, { date: WED, windows: null }, false);
    expect(await times(f, t.teacher.id, WED)).toEqual(['15:00', '16:00', '17:00']);
    expect((await teacherCalendar(f.ctx, t.actor, t.teacher.id, '2026-10')).days.find((d) => d.date === WED)!.overridden).toBe(false);
  });

  test('AV-07 / AV-08 講師が教室の受付時間の外に空き時間を入れても、受付時間の中だけが枠になる', async () => {
    const f = await setup();
    // 日曜は教室が休み
    await setTeacherDay(f.ctx, f.teacherA.actor, f.teacherA.teacher.id, { date: '2026-11-01', windows: [{ startTime: '10:00', endTime: '12:00', lessonTypeId: f.privateType.id }] }, false);
    expect(await times(f, f.teacherA.teacher.id, '2026-11-01')).toEqual([]);
    // 土曜は 18:00 まで
    await setTeacherDay(f.ctx, f.teacherA.actor, f.teacherA.teacher.id, { date: '2026-10-31', windows: [{ startTime: '16:00', endTime: '20:00', lessonTypeId: f.privateType.id }] }, false);
    expect(await times(f, f.teacherA.teacher.id, '2026-10-31')).toEqual(['16:00', '17:00']);
  });

  test('AV-07 / AV-02 / AV-03 予約がある日を変えるときは確認を求め、確認すると講師都合で取り消す', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const r = await bookAsStudent(f.ctx, actor, { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt: jst(WED, '15:00') });
    const day = { date: WED, windows: [{ startTime: '16:00', endTime: '18:00', lessonTypeId: f.privateType.id }] };
    const first = await setTeacherDay(f.ctx, f.teacherA.actor, f.teacherA.teacher.id, day, false);
    expect(first.applied).toBe(false);
    expect(first.affected.map((a) => a.studentName)).toEqual(['太郎']);
    expect(await times(f, f.teacherA.teacher.id, WED)).toEqual(['16:00', '17:00']); // 15:00 は予約で埋まっている
    const second = await setTeacherDay(f.ctx, f.teacherA.actor, f.teacherA.teacher.id, day, true);
    expect(second.applied).toBe(true);
    const [after] = await f.db.select().from(reservations).where(eq(reservations.id, r.id));
    expect(after).toMatchObject({ status: 'cancelled', cancelKind: 'teacher' });
    expect(await balance(f.db, student.id, '2026-10')).toBe(4);
  });

  test('AV-07 ほかの講師の日ごとの空き時間は、見ることも変えることもできない', async () => {
    const f = await setup();
    const day = { date: WED, windows: [] };
    await expectError(setTeacherDay(f.ctx, f.teacherB.actor, f.teacherA.teacher.id, day, true), 'forbidden');
    await expectError(teacherCalendar(f.ctx, f.teacherB.actor, f.teacherA.teacher.id, '2026-10'), 'forbidden');
    const { actor } = await f.mkStudent('太郎');
    await expectError(setTeacherDay(f.ctx, actor, f.teacherA.teacher.id, day, true), 'forbidden');
    // 管理者は変えられる
    expect((await setTeacherDay(f.ctx, f.admin, f.teacherA.teacher.id, day, false)).applied).toBe(true);
  });

  test('AV-07 過ぎた日と、終了が開始より前の時間帯は受け付けない', async () => {
    const f = await setup();
    await expectError(setTeacherDay(f.ctx, f.teacherA.actor, f.teacherA.teacher.id, { date: '2026-10-19', windows: null }, false), 'validation', /過ぎた日/);
    await expectError(
      setTeacherDay(f.ctx, f.teacherA.actor, f.teacherA.teacher.id, { date: WED, windows: [{ startTime: '18:00', endTime: '15:00', lessonTypeId: f.privateType.id }] }, false),
      'validation',
    );
  });
});

describe('AV-08 どの予約の入口も同じ空きを使う', () => {
  test('TR-02 / AV-08 体験の公開枠も、教室の受付時間のない日には出ない', async () => {
    const f = await setup();
    await updateSettings(f.db, { trialPublicSlots: true }, null);
    const THU = '2026-10-29';
    await setTeacherDay(f.ctx, f.admin, f.teacherB.teacher.id, { date: THU, windows: [{ startTime: '15:00', endTime: '17:00', lessonTypeId: f.privateType.id, forTrial: true }] }, false);
    const on = await publicTrialSlots(f.ctx);
    expect(on.filter((s) => s.teacherId === f.teacherB.teacher.id).map((s) => timeOf(s.startsAt))).toEqual(['15:00', '16:00']);
    await setSchoolHours(f.ctx, f.admin, { dates: [THU], windows: [] }, false);
    expect((await publicTrialSlots(f.ctx)).filter((s) => s.teacherId === f.teacherB.teacher.id)).toEqual([]);
  });

  test('RS-07 / AV-08 繰り返し予約は、教室の休みの日を飛ばして作り、飛ばした日を返す', async () => {
    const f = await setup();
    const { student } = await f.mkStudent('太郎', { credits: 4 });
    await setSchoolHours(f.ctx, f.admin, { dates: ['2026-11-04'], windows: [] }, false);
    const res = await createSeries(f.ctx, f.admin, {
      studentId: student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      weekday: 3,
      startTime: '15:00',
      startDate: WED,
      endDate: '2026-11-11',
    });
    expect(res.created.map((r) => r.startsAt)).toEqual([jst(WED, '15:00'), jst('2026-11-11', '15:00')]);
    expect(res.skipped.map((s) => s.date)).toEqual(['2026-11-04']);
  });
});
