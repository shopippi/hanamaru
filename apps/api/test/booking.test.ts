import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { payments, reservations, studentTeachers, students } from '../src/db/schema.js';
import {
  bookAsAdmin,
  bookAsStudent,
  cancelAsAdmin,
  cancelAsStudent,
  cancelPreview,
  changeAsStudent,
  createSeries,
  decidePending,
  markAttendance,
  reservationsOfStudent,
  slotsForStudent,
  studentBlocker,
} from '../src/domain/booking.js';
import { balance } from '../src/domain/credits.js';
import { getSettings, updateSettings } from '../src/domain/settings.js';
import { DomainError } from '../src/domain/errors.js';
import { jst } from '../src/lib/time.js';
import { setup } from './fixtures.js';

const THU = jst('2026-10-22', '15:00'); // 予約締切（24時間前）より後で、公開期間内

async function expectError(p: Promise<unknown>, code: DomainError['code'], message?: RegExp) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(DomainError);
  expect((e as DomainError).code).toBe(code);
  if (message) expect((e as DomainError).message).toMatch(message);
}

describe('RS-01 予約すると、その月の残り回数が1減る', () => {
  test('担当講師の空き枠を予約できる', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const r = await bookAsStudent(f.ctx, actor, {
      studentId: student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: THU,
    });
    expect(r.status).toBe('confirmed');
    expect(r.lessonMonth).toBe('2026-10');
    expect(await balance(f.db, student.id, '2026-10')).toBe(3);
    expect(f.mail.sent.map((m) => m.subject)).toContain('【予約確定】レッスンの予約が確定しました');
  });

  test('回数は「レッスン日が属する月」から使う', async () => {
    const f = await setup(jst('2026-10-30', '10:00'));
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    await f.grant(student.id, '2026-11', 4);
    await bookAsStudent(f.ctx, actor, {
      studentId: student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: jst('2026-11-02', '15:00'),
    });
    expect(await balance(f.db, student.id, '2026-10')).toBe(4);
    expect(await balance(f.db, student.id, '2026-11')).toBe(3);
  });
});

describe('RS-02 予約できない生徒には理由を示す', () => {
  test('残り回数が0なら「今月の回数を使い切りました」', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 1 });
    const input = { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id };
    await bookAsStudent(f.ctx, actor, { ...input, startsAt: THU });
    await expectError(
      bookAsStudent(f.ctx, actor, { ...input, startsAt: jst('2026-10-22', '16:00') }),
      'rule',
      /今月の回数を使い切りました/,
    );
  });

  test('休会中は予約できない', async () => {
    const f = await setup();
    const { student } = await f.mkStudent('太郎', { credits: 4 });
    await f.db.update(students).set({ status: 'suspended' }).where(eq(students.id, student.id));
    const s = (await f.db.select().from(students).where(eq(students.id, student.id)))[0]!;
    expect(await studentBlocker(f.db, s, f.clock.now, await getSettings(f.db))).toBe('休会中のため予約できません');
  });

  test('未払いで猶予期間（初期値7日）を過ぎると予約できない（PY-10）', async () => {
    const f = await setup(jst('2026-10-05', '10:00'));
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    await f.db
      .insert(payments)
      .values({ studentId: student.id, kind: 'monthly', method: 'card', month: '2026-10', amount: 12000, status: 'failed' });
    const input = { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id };
    // 10月5日は猶予期間内なので予約できる
    await bookAsStudent(f.ctx, actor, { ...input, startsAt: jst('2026-10-07', '15:00') });
    // 10月9日は猶予期間（10月1日 + 7日）を過ぎている
    f.clock.now = jst('2026-10-09', '10:00');
    await expectError(
      bookAsStudent(f.ctx, actor, { ...input, startsAt: jst('2026-10-12', '15:00') }),
      'rule',
      /お支払いが確認できていない/,
    );
  });

  test('承認前の生徒（自己登録直後）は予約できない（ST-02）', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    await f.db.update(students).set({ approved: false }).where(eq(students.id, student.id));
    await expectError(
      bookAsStudent(f.ctx, actor, { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt: THU }),
      'rule',
      /承認待ち/,
    );
  });

  test('翌月から休会の予定なら、翌月の日付は予約できない（ST-05）', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    await f.db
      .update(students)
      .set({ scheduledStatus: 'suspended', scheduledStatusAt: jst('2026-11-01') })
      .where(eq(students.id, student.id));
    const input = { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id };
    await bookAsStudent(f.ctx, actor, { ...input, startsAt: THU });
    await expectError(bookAsStudent(f.ctx, actor, { ...input, startsAt: jst('2026-11-02', '15:00') }), 'rule', /11月から休会/);
  });
});

describe('3.4 翌月分の先行予約', () => {
  test('自動課金が有効なら、翌月はコースの回数まで先に予約できる', async () => {
    const f = await setup(jst('2026-10-26', '10:00'));
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const input = { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id };
    for (const d of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']) {
      await bookAsStudent(f.ctx, actor, { ...input, startsAt: jst(d, '15:00') });
    }
    // 5回目はコースの回数（月4回）を超える
    await expectError(bookAsStudent(f.ctx, actor, { ...input, startsAt: jst('2026-11-06', '15:00') }), 'rule', /11月の回数を使い切りました/);
    expect(await balance(f.db, student.id, '2026-11')).toBe(-4);
    // 11月1日に月額の回数（4回）が付くと、ちょうど0になる
    await f.grant(student.id, '2026-11', 4);
    expect(await balance(f.db, student.id, '2026-11')).toBe(0);
  });

  test('自動課金でない生徒は、翌月分の支払い前に予約できない', async () => {
    const f = await setup(jst('2026-10-26', '10:00'));
    const { student, actor } = await f.mkStudent('花子', { credits: 4, autopay: false });
    await expectError(
      bookAsStudent(f.ctx, actor, {
        studentId: student.id,
        teacherId: f.teacherA.teacher.id,
        lessonTypeId: f.privateType.id,
        startsAt: jst('2026-11-02', '15:00'),
      }),
      'rule',
      /11月の回数を使い切りました/,
    );
  });
});

describe('RS-03 予約を公開する期間', () => {
  test('期間より先の日付は生徒に表示されず、予約もできない', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const slots = await slotsForStudent(f.ctx, actor, student.id, f.teacherA.teacher.id, '2026-10-20', '2026-12-31');
    const last = slots.at(-1)!.startsAt;
    expect(last.getTime()).toBeLessThanOrEqual(jst('2026-11-17', '10:00').getTime());
    expect(slots[0]!.startsAt.getTime()).toBeGreaterThanOrEqual(jst('2026-10-21', '10:00').getTime());
    await expectError(
      bookAsStudent(f.ctx, actor, {
        studentId: student.id,
        teacherId: f.teacherA.teacher.id,
        lessonTypeId: f.privateType.id,
        startsAt: jst('2026-11-24', '15:00'),
      }),
      'rule',
      /まだ予約を受け付けていない/,
    );
  });
});

describe('RS-04 / RS-05 キャンセル・変更の締切', () => {
  test('締切前のキャンセルで残り回数が1増える', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const r = await bookAsStudent(f.ctx, actor, {
      studentId: student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: THU,
    });
    expect((await cancelPreview(f.ctx, actor, r.id)).refund).toBe(true);
    expect(await cancelAsStudent(f.ctx, actor, r.id)).toEqual({ refunded: true });
    expect(await balance(f.db, student.id, '2026-10')).toBe(4);
  });

  test('締切後のキャンセルでは残り回数は変わらない', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const r = await bookAsStudent(f.ctx, actor, {
      studentId: student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: THU,
    });
    f.clock.now = jst('2026-10-22', '09:00'); // 6時間前
    expect((await cancelPreview(f.ctx, actor, r.id)).refund).toBe(false);
    expect(await cancelAsStudent(f.ctx, actor, r.id)).toEqual({ refunded: false });
    expect(await balance(f.db, student.id, '2026-10')).toBe(3);
    const [row] = await f.db.select().from(reservations).where(eq(reservations.id, r.id));
    expect(row!.cancelKind).toBe('student_late');
  });

  test('無断欠席でも、予約時に使った回数は戻らない', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const r = await bookAsStudent(f.ctx, actor, {
      studentId: student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: THU,
    });
    f.clock.now = jst('2026-10-22', '17:00');
    await markAttendance(f.ctx, f.admin, r.id, 'no_show');
    expect(await balance(f.db, student.id, '2026-10')).toBe(3);
  });

  test('締切前の変更では回数が新しい予約に移る', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const r = await bookAsStudent(f.ctx, actor, {
      studentId: student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: THU,
    });
    const moved = await changeAsStudent(f.ctx, actor, r.id, {
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: jst('2026-10-23', '16:00'),
    });
    expect(moved.startsAt).toEqual(jst('2026-10-23', '16:00'));
    expect(await balance(f.db, student.id, '2026-10')).toBe(3);
    const list = await reservationsOfStudent(f.ctx, actor, student.id);
    expect(list.filter((x) => x.status !== 'cancelled')).toHaveLength(1);
  });

  test('締切後は変更できない', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const r = await bookAsStudent(f.ctx, actor, {
      studentId: student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: THU,
    });
    f.clock.now = jst('2026-10-22', '09:00');
    await expectError(
      changeAsStudent(f.ctx, actor, r.id, { teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt: jst('2026-10-24', '15:00') }),
      'rule',
      /変更の締切/,
    );
  });

  test('締切は予約・変更・キャンセルごとに設定できる', async () => {
    const f = await setup();
    await updateSettings(f.db, { cancelDeadlineMode: 'hoursBefore', cancelDeadlineHours: 2 }, null);
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const r = await bookAsStudent(f.ctx, actor, {
      studentId: student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: THU,
    });
    f.clock.now = jst('2026-10-22', '09:00'); // キャンセル締切（2時間前）より前
    expect(await cancelAsStudent(f.ctx, actor, r.id)).toEqual({ refunded: true });
  });
});

describe('RS-06 承認制', () => {
  test('承認制のときは仮予約になり、承認で確定する。却下すると回数が戻る', async () => {
    const f = await setup();
    await updateSettings(f.db, { approvalRequired: true }, null);
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const input = { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id };
    const r1 = await bookAsStudent(f.ctx, actor, { ...input, startsAt: THU });
    expect(r1.status).toBe('pending');
    expect(f.mail.sent.at(-1)!.subject).toContain('仮予約');
    await decidePending(f.ctx, f.admin, r1.id, true);
    const [after] = await f.db.select().from(reservations).where(eq(reservations.id, r1.id));
    expect(after!.status).toBe('confirmed');

    const r2 = await bookAsStudent(f.ctx, actor, { ...input, startsAt: jst('2026-10-23', '15:00') });
    expect(await balance(f.db, student.id, '2026-10')).toBe(2);
    await decidePending(f.ctx, f.admin, r2.id, false);
    expect(await balance(f.db, student.id, '2026-10')).toBe(3);
  });
});

describe('RS-07 管理者の予約と繰り返し予約', () => {
  test('管理者は公開期間より先や締切後でも予約を入れられる', async () => {
    const f = await setup();
    const { student } = await f.mkStudent('太郎', { credits: 4 });
    const input = { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id };
    const far = await bookAsAdmin(f.ctx, f.admin, { ...input, startsAt: jst('2026-12-07', '15:00') });
    expect(far.reservation.status).toBe('confirmed');
    const soon = await bookAsAdmin(f.ctx, f.admin, { ...input, startsAt: jst('2026-10-20', '15:00') });
    expect(soon.warning).toBeNull();
  });

  test('毎週の繰り返し予約は各月の回数から使い、足りない月は警告が出る', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const res = await createSeries(f.ctx, f.admin, {
      studentId: student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      weekday: 4, // 木曜
      startTime: '15:00',
      startDate: '2026-10-22',
      endDate: '2026-11-26',
    });
    // 10/22, 10/29, 11/5, 11/12, 11/19, 11/26
    expect(res.created).toHaveLength(6);
    expect(await balance(f.db, student.id, '2026-10')).toBe(2);
    expect(await balance(f.db, student.id, '2026-11')).toBe(-4);
    // 11月はまだ付与前だが、自動課金なので先行分（4回）の範囲内。足りない月はない
    expect(res.warnings).toEqual([]);
    const list = await reservationsOfStudent(f.ctx, actor, student.id);
    expect(list).toHaveLength(6);

    const more = await createSeries(f.ctx, f.admin, {
      studentId: student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      weekday: 5,
      startTime: '15:00',
      startDate: '2026-11-06',
      endDate: '2026-11-13',
    });
    expect(more.warnings).toEqual(['11月の回数が2回足りません']);
  });

  test('RS-07 繰り返し予約の期間は、終わりが始まりより後で、今日以降、設定の週数まで', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const base = { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, weekday: 4, startTime: '15:00' };
    await expect(createSeries(f.ctx, f.admin, { ...base, startDate: '2026-11-26', endDate: '2026-11-05' })).rejects.toThrow('終わりの日');
    await expect(createSeries(f.ctx, f.admin, { ...base, startDate: '2026-10-01', endDate: '2026-11-05' })).rejects.toThrow('今日より前');
    // 初期値は52週まで。100年先までのような入力で、何千件も作らない
    await expect(createSeries(f.ctx, f.admin, { ...base, startDate: '2026-10-22', endDate: '2099-12-31' })).rejects.toThrow('52週');
    expect(await reservationsOfStudent(f.ctx, actor, student.id)).toEqual([]);
  });

  test('管理者は締切後の連絡を、回数を戻さない取消として扱える', async () => {
    const f = await setup();
    const { student } = await f.mkStudent('太郎', { credits: 4 });
    const { reservation } = await bookAsAdmin(f.ctx, f.admin, {
      studentId: student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: THU,
    });
    await cancelAsAdmin(f.ctx, f.admin, reservation.id, { refund: false });
    expect(await balance(f.db, student.id, '2026-10')).toBe(3);
  });
});

describe('RS-08 グループレッスンの定員', () => {
  test('定員に達した枠は予約できない', async () => {
    const f = await setup();
    const sat = jst('2026-10-24', '10:00');
    const kids = await Promise.all(['A', 'B', 'C'].map((n) => f.mkStudent(`生徒${n}`, { credits: 4 })));
    const book = (k: (typeof kids)[number]) =>
      bookAsStudent(f.ctx, k.actor, {
        studentId: k.student.id,
        teacherId: f.teacherA.teacher.id,
        lessonTypeId: f.groupType.id,
        startsAt: sat,
      });
    await book(kids[0]!);
    const slots = await slotsForStudent(f.ctx, kids[2]!.actor, kids[2]!.student.id, f.teacherA.teacher.id, '2026-10-24', '2026-10-24');
    expect(slots.find((s) => s.startsAt.getTime() === sat.getTime())?.booked).toBe(1);
    await book(kids[1]!);
    await expectError(book(kids[2]!), 'rule', /予約できません/);
  });

  test('個人レッスンは同じ時間に2人予約できない', async () => {
    const f = await setup();
    const a = await f.mkStudent('A', { credits: 4 });
    const b = await f.mkStudent('B', { credits: 4 });
    const input = { teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt: THU };
    const results = await Promise.allSettled([
      bookAsStudent(f.ctx, a.actor, { ...input, studentId: a.student.id }),
      bookAsStudent(f.ctx, b.actor, { ...input, studentId: b.student.id }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('TC-02 / TC-03 / TC-04 担当講師', () => {
  test('生徒には担当講師の枠だけを出し、担当外はサーバー側で拒否する', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    await expectError(slotsForStudent(f.ctx, actor, student.id, f.teacherB.teacher.id, '2026-10-20', '2026-10-31'), 'forbidden');
    await expectError(
      bookAsStudent(f.ctx, actor, {
        studentId: student.id,
        teacherId: f.teacherB.teacher.id,
        lessonTypeId: f.privateType.id,
        startsAt: jst('2026-10-28', '15:00'),
      }),
      'forbidden',
    );
  });

  test('担当が2人なら両方の枠を選べる', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', {
      credits: 4,
      teachers: [f.teacherA.teacher.id, f.teacherB.teacher.id],
    });
    const b = await slotsForStudent(f.ctx, actor, student.id, f.teacherB.teacher.id, '2026-10-20', '2026-10-31');
    expect(b.length).toBeGreaterThan(0);
  });

  test('担当を外しても既存の予約は残り、新しい予約だけができなくなる', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎', { credits: 4 });
    const input = { studentId: student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id };
    await bookAsStudent(f.ctx, actor, { ...input, startsAt: THU });
    await f.db.delete(studentTeachers).where(eq(studentTeachers.studentId, student.id));
    const list = await reservationsOfStudent(f.ctx, actor, student.id);
    expect(list.filter((r) => r.status === 'confirmed')).toHaveLength(1);
    await expectError(bookAsStudent(f.ctx, actor, { ...input, startsAt: jst('2026-10-23', '15:00') }), 'forbidden');
  });
});

describe('5.2 権限: 生徒は他の生徒の予約を操作できない', () => {
  test('他の家庭の生徒として予約・キャンセル・一覧はできない', async () => {
    const f = await setup();
    const mine = await f.mkStudent('太郎', { credits: 4 });
    const other = await f.mkStudent('次郎', { credits: 4 });
    const r = await bookAsStudent(f.ctx, other.actor, {
      studentId: other.student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: THU,
    });
    await expectError(
      bookAsStudent(f.ctx, mine.actor, {
        studentId: other.student.id,
        teacherId: f.teacherA.teacher.id,
        lessonTypeId: f.privateType.id,
        startsAt: jst('2026-10-23', '15:00'),
      }),
      'not_found',
    );
    await expectError(cancelAsStudent(f.ctx, mine.actor, r.id), 'not_found');
    await expectError(reservationsOfStudent(f.ctx, mine.actor, other.student.id), 'not_found');
  });

  test('保護者は自分の子どもを切り替えて、それぞれ予約できる（ST-04）', async () => {
    const f = await setup();
    const first = await f.mkStudent('長女', { credits: 4 });
    const second = await f.mkStudent('長男', { credits: 1, account: first.account });
    const input = { teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id };
    await bookAsStudent(f.ctx, first.actor, { ...input, studentId: second.student.id, startsAt: THU });
    expect(await balance(f.db, second.student.id, '2026-10')).toBe(0);
    expect(await balance(f.db, first.student.id, '2026-10')).toBe(4);
    expect(await reservationsOfStudent(f.ctx, first.actor, first.student.id)).toHaveLength(0);
  });
});
