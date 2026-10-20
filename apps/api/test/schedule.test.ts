import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLogs, reservations } from '../src/db/schema.js';
import { bookAsStudent, slotsForStudent } from '../src/domain/booking.js';
import { balance } from '../src/domain/credits.js';
import { changeAvailability, createClosure, teacherMonthStats } from '../src/domain/schedule.js';
import { DomainError } from '../src/domain/errors.js';
import { jst } from '../src/lib/time.js';
import { setup } from './fixtures.js';

describe('AV-01 講師の空き時間', () => {
  test('講師が設定した枠が、担当生徒の予約画面に表示される', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4, teachers: [f.teacherB.teacher.id] });
    // 講師Bが金曜 10:00-12:00 を追加し、10月30日だけ 13:00-14:00 を足す
    const res = await changeAvailability(
      f.ctx,
      f.teacherB.actor,
      f.teacherB.teacher.id,
      {
        rules: [
          { weekday: 3, startTime: '15:00', endTime: '18:00', lessonTypeId: f.privateType.id },
          { weekday: 5, startTime: '10:00', endTime: '12:00', lessonTypeId: f.privateType.id },
        ],
        addExceptions: [{ date: '2026-10-30', kind: 'extra', startTime: '13:00', endTime: '14:00', lessonTypeId: f.privateType.id }],
      },
      false,
    );
    expect(res.applied).toBe(true);
    const slots = await slotsForStudent(f.ctx, actor, student.id, f.teacherB.teacher.id, '2026-10-30', '2026-10-30');
    expect(slots.map((s) => s.startsAt)).toEqual([jst('2026-10-30', '10:00'), jst('2026-10-30', '11:00'), jst('2026-10-30', '13:00')]);
  });

  test('日付ごとの不在（block）はその時間の枠を消す', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    await changeAvailability(
      f.ctx,
      f.teacherA.actor,
      f.teacherA.teacher.id,
      { addExceptions: [{ date: '2026-10-23', kind: 'block', startTime: '15:00', endTime: '16:00' }] },
      false,
    );
    const slots = await slotsForStudent(f.ctx, actor, student.id, f.teacherA.teacher.id, '2026-10-23', '2026-10-23');
    expect(slots.map((s) => s.startsAt)).toEqual([jst('2026-10-23', '16:00'), jst('2026-10-23', '17:00')]);
  });

  test('講師は他の講師の空き時間を変えられない', async () => {
    const f = await setup();
    const e = await changeAvailability(f.ctx, f.teacherA.actor, f.teacherB.teacher.id, { rules: [] }, true).catch((x) => x);
    expect(e).toBeInstanceOf(DomainError);
    expect((e as DomainError).code).toBe('forbidden');
  });

  test('営業時間外の空き時間は枠にならない（3.8）', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    // 日曜は休業日
    await changeAvailability(
      f.ctx,
      f.admin,
      f.teacherA.teacher.id,
      { addExceptions: [{ date: '2026-10-25', kind: 'extra', startTime: '10:00', endTime: '12:00', lessonTypeId: f.privateType.id }] },
      false,
    );
    expect(await slotsForStudent(f.ctx, actor, student.id, f.teacherA.teacher.id, '2026-10-25', '2026-10-25')).toEqual([]);
  });
});

describe('AV-02 / AV-03 予約が入っている時間帯の変更', () => {
  async function withBooking() {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const r = await bookAsStudent(f.ctx, actor, {
      studentId: student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: jst('2026-10-22', '15:00'),
    });
    return { f, student, r };
  }

  test('確認しなければ変更されず、件数・生徒名・日時を返す', async () => {
    const { f, r } = await withBooking();
    const res = await changeAvailability(f.ctx, f.teacherA.actor, f.teacherA.teacher.id, { rules: [] }, false);
    expect(res.applied).toBe(false);
    expect(res.affected).toEqual([{ reservationId: r.id, studentName: '太郎', startsAt: jst('2026-10-22', '15:00') }]);
    const [row] = await f.db.select().from(reservations).where(eq(reservations.id, r.id));
    expect(row!.status).toBe('confirmed');
    // 空き時間も変わっていない
    const again = await changeAvailability(f.ctx, f.teacherA.actor, f.teacherA.teacher.id, { addExceptions: [] }, false);
    expect(again.applied).toBe(true);
  });

  test('確認して変更すると講師都合のキャンセルになり、回数が戻り、生徒と管理者にメールが届く', async () => {
    const { f, student, r } = await withBooking();
    f.mail.sent.length = 0;
    const res = await changeAvailability(
      f.ctx,
      f.teacherA.actor,
      f.teacherA.teacher.id,
      { addExceptions: [{ date: '2026-10-22', kind: 'block', startTime: null, endTime: null }] },
      true,
    );
    expect(res.applied).toBe(true);
    expect(res.affected).toHaveLength(1);
    const [row] = await f.db.select().from(reservations).where(eq(reservations.id, r.id));
    expect(row!.status).toBe('cancelled');
    expect(row!.cancelKind).toBe('teacher');
    expect(await balance(f.db, student.id, '2026-10')).toBe(4);
    expect(f.mail.sent.map((m) => m.to).sort()).toEqual(['matsuda@example.test', '太郎@example.test']);
    expect(f.mail.sent[0]!.text).toContain('講師の都合');
    const logs = await f.db.select().from(auditLogs).where(eq(auditLogs.action, 'availability.change'));
    expect(logs).toHaveLength(1);
  });
});

describe('AV-04 休講日', () => {
  test('休講日の枠は表示されず、既存の予約は取り消されて回数が戻る', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    await bookAsStudent(f.ctx, actor, {
      studentId: student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: jst('2026-10-22', '16:00'),
    });
    const res = await createClosure(f.ctx, f.admin, { date: '2026-10-22', reason: '台風' });
    expect(res.cancelled).toBe(1);
    expect(await balance(f.db, student.id, '2026-10')).toBe(4);
    expect(await slotsForStudent(f.ctx, actor, student.id, f.teacherA.teacher.id, '2026-10-22', '2026-10-22')).toEqual([]);
    const [row] = await f.db.select().from(reservations);
    expect(row!.cancelKind).toBe('school');
  });

  test('時間帯だけの臨時休講', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    await createClosure(f.ctx, f.admin, { date: '2026-10-22', startTime: '15:00', endTime: '16:00' });
    const slots = await slotsForStudent(f.ctx, actor, student.id, f.teacherA.teacher.id, '2026-10-22', '2026-10-22');
    expect(slots.map((s) => s.startsAt)).toEqual([jst('2026-10-22', '16:00'), jst('2026-10-22', '17:00')]);
  });

  test('講師は休講日を設定できない', async () => {
    const f = await setup();
    const e = await createClosure(f.ctx, f.teacherA.actor, { date: '2026-10-22' }).catch((x) => x);
    expect((e as DomainError).code).toBe('forbidden');
  });
});

describe('AV-05 講師都合のキャンセル件数', () => {
  test('講師別にその月のレッスン数と講師都合キャンセルの件数を出す', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const input = { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id };
    await bookAsStudent(f.ctx, actor, { ...input, startsAt: jst('2026-10-22', '15:00') });
    await bookAsStudent(f.ctx, actor, { ...input, startsAt: jst('2026-10-23', '15:00') });
    await changeAvailability(
      f.ctx,
      f.teacherA.actor,
      f.teacherA.teacher.id,
      { addExceptions: [{ date: '2026-10-23', kind: 'block', startTime: null, endTime: null }] },
      true,
    );
    const stats = await teacherMonthStats(f.db, '2026-10');
    expect(stats.find((s) => s.name === '講師A')).toMatchObject({ lessons: 1, teacherCancels: 1 });
    expect(stats.find((s) => s.name === '講師B')).toMatchObject({ lessons: 0, teacherCancels: 0 });
  });
});
