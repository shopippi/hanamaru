import { describe, expect, test } from 'vitest';
import { bookAsStudent } from '../src/domain/booking.js';
import { applyScheduledStatuses } from '../src/domain/people.js';
import { teacherProfilesForStudent, updateProfileAsAdmin } from '../src/domain/teacher-profiles.js';
import { jst } from '../src/lib/time.js';
import { setupHttp } from './http.js';

async function world() {
  const f = await setupHttp();
  const admin = await f.adminBrowser();
  // 太郎: 講師A・Bが担当、次郎: 講師Aだけ
  const taro = await f.mkStudent('太郎', { credits: 4, teachers: [f.teacherA.teacher.id, f.teacherB.teacher.id] });
  const jiro = await f.mkStudent('次郎', { credits: 4 });
  await admin.patch(`/students/${taro.student.id}`, { address: '東京都千代田区1-1', phone: '090-1234-5678' });
  await admin.put(`/students/${taro.student.id}/notes/admin`, { text: '月謝は祖母が支払い' });
  for (const a of [taro.account, jiro.account, f.teacherA.account, f.teacherB.account]) await f.setPassword(a.id);
  const studentTaro = f.browser('student');
  await studentTaro.login(taro.account.email);
  const teacherA = f.browser('staff');
  await teacherA.login(f.teacherA.account.email);
  const teacherB = f.browser('staff');
  await teacherB.login(f.teacherB.account.email);
  return { f, admin, taro, jiro, studentTaro, teacherA, teacherB };
}

describe('TC-01 / TC-05 / TC-06 担当講師とプロフィール', () => {
  test('生徒の詳細画面で講師を選ぶだけで担当を設定でき、変更は操作記録に残る', async () => {
    const { admin, jiro, f } = await world();
    await admin.put(`/students/${jiro.student.id}/teachers`, { teacherIds: [f.teacherB.teacher.id] });
    const detail = (await admin.get(`/students/${jiro.student.id}`)).data;
    expect(detail.teachers.map((t: any) => t.name)).toEqual(['講師B']);
    const logs = (await admin.get(`/audit-logs?targetType=student&targetId=${jiro.student.id}`)).data;
    expect(logs.map((l: any) => l.action)).toContain('student.teachers');
  });

  test('生徒には担当講師のプロフィールだけが表示され、管理画面で入れた内容が反映される', async () => {
    const { f, jiro } = await world();
    await updateProfileAsAdmin(f.ctx, f.admin, f.teacherA.teacher.id, { instruments: ['ピアノ'], career: '音大卒', message: 'よろしく' });
    await updateProfileAsAdmin(f.ctx, f.admin, f.teacherB.teacher.id, { instruments: ['ギター'], career: '', message: '' });
    const profiles = await teacherProfilesForStudent(f.ctx, jiro.actor, jiro.student.id);
    expect(profiles).toEqual([
      { teacherId: f.teacherA.teacher.id, name: f.teacherA.teacher.name, photo: null, instruments: ['ピアノ'], career: '音大卒', message: 'よろしく' },
    ]);
  });
});

describe('SR-01 / SR-02 生徒情報と状態', () => {
  test('管理者は生徒の詳細で全項目を見て編集できる', async () => {
    const { admin, taro } = await world();
    const d = (await admin.get(`/students/${taro.student.id}`)).data;
    expect(d).toMatchObject({ name: '太郎', phone: '090-1234-5678', address: '東京都千代田区1-1', status: 'active', adminNote: '月謝は祖母が支払い' });
    expect(d.accountEmail).toBe('太郎@example.test');
    expect(Array.isArray(d.creditLedger)).toBe(true);
  });

  test('状態の切り替えは操作記録に残る', async () => {
    const { admin, jiro } = await world();
    await admin.post(`/students/${jiro.student.id}/status`, { status: 'active', immediately: true });
    const logs = (await admin.get(`/audit-logs?targetType=student&targetId=${jiro.student.id}`)).data;
    expect(logs.find((l: any) => l.action === 'student.status')).toBeTruthy();
  });
});

describe('ST-05 退会・休会', () => {
  test('退会しても今月末までは予約でき、翌月になるとログインできない', async () => {
    const { f, admin, taro, studentTaro } = await world();
    const res = await admin.post(`/students/${taro.student.id}/status`, { status: 'withdrawn' });
    expect(res.data.status).toBe('active');
    expect(res.data.scheduledStatus).toBe('withdrawn');
    const booked = await studentTaro.post(`/students/${taro.student.id}/reservations`, {
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: jst('2026-10-22', '15:00').toISOString(),
    });
    expect(booked.status).toBe(201);
    f.clock.now = jst('2026-11-01', '00:05');
    await applyScheduledStatuses(f.ctx);
    expect((await studentTaro.get('/students')).status).toBe(401);
    expect((await f.browser('student').login(taro.account.email)).status).toBe(401);
  });

  test('休会中の生徒はログインできるが予約できない', async () => {
    const { f, admin, taro, studentTaro } = await world();
    await admin.post(`/students/${taro.student.id}/status`, { status: 'suspended' });
    f.clock.now = jst('2026-11-01', '00:05');
    await applyScheduledStatuses(f.ctx);
    const home = await studentTaro.get(`/students/${taro.student.id}/home`);
    expect(home.data.blocker).toBe('休会中のため予約できません');
  });

  test('退会・休会は管理者だけが操作する（生徒・講師は不可）', async () => {
    const { taro, studentTaro, teacherA } = await world();
    // 生徒・講師のポータルには状態を変える API がない
    expect((await studentTaro.post(`/students/${taro.student.id}/status`, { status: 'withdrawn' })).status).toBe(404);
    expect((await teacherA.post(`/students/${taro.student.id}/status`, { status: 'withdrawn' })).status).toBe(404);
  });
});

describe('SR-03〜SR-07 備考とレッスン記録', () => {
  test('SR-03 講師には管理用備考が表示されず、担当講師Aが書いた講師用備考を担当講師Bも読める', async () => {
    const { taro, teacherA, teacherB } = await world();
    expect((await teacherA.put(`/students/${taro.student.id}/teacher-note`, { text: '左手が苦手' })).status).toBe(200);
    const seenByB = (await teacherB.get(`/students/${taro.student.id}`)).data;
    expect(seenByB.teacherNote).toBe('左手が苦手');
    expect(JSON.stringify(seenByB)).not.toContain('祖母');
  });

  test('SR-04 講師は担当レッスンからレッスン記録を書け、生徒ごとに日付順で一覧できる', async () => {
    const { f, taro, teacherA, teacherB } = await world();
    const r1 = await bookAsStudent(f.ctx, taro.actor, {
      studentId: taro.student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: jst('2026-10-23', '15:00'),
    });
    const r2 = await bookAsStudent(f.ctx, taro.actor, {
      studentId: taro.student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: jst('2026-10-22', '15:00'),
    });
    const lessons = (await teacherA.get('/lessons?from=2026-10-20&to=2026-10-31')).data;
    expect(lessons.map((l: any) => l.studentName)).toEqual(['太郎', '太郎']);
    await teacherA.put(`/lessons/${r1.id}/record`, { content: 'ブルグミュラー2番', progress: '半分まで' });
    await teacherA.put(`/lessons/${r2.id}/record`, { content: 'ハノン1番' });
    // 担当していないレッスン（講師Bの予約ではない）には書けない
    expect((await teacherB.put(`/lessons/${r1.id}/record`, { content: 'x' })).status).toBe(404);
    const records = (await teacherB.get(`/students/${taro.student.id}`)).data.lessonRecords;
    expect(records.map((r: any) => r.content)).toEqual(['ハノン1番', 'ブルグミュラー2番']);
  });

  test('SR-05 生徒の画面とAPIの応答にレッスン記録・備考・住所が含まれない', async () => {
    const { f, taro, studentTaro, teacherA, admin } = await world();
    const r = await bookAsStudent(f.ctx, taro.actor, {
      studentId: taro.student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: jst('2026-10-22', '15:00'),
    });
    await teacherA.put(`/lessons/${r.id}/record`, { content: '秘密の記録' });
    await admin.put(`/students/${taro.student.id}/notes/teacher`, { text: '講師向けメモ' });
    const sid = taro.student.id;
    for (const path of ['/students', `/students/${sid}/home`, `/students/${sid}/reservations`, `/students/${sid}/teachers`]) {
      const res = await studentTaro.get(path);
      expect(res.status).toBe(200);
      for (const secret of ['秘密の記録', '講師向けメモ', '祖母', '千代田区', 'teacherNote', 'adminNote', 'lessonRecords']) {
        expect(res.text).not.toContain(secret);
      }
    }
  });

  test('講師用のAPIの応答に住所と管理用備考が含まれない（SR-06）', async () => {
    const { taro, teacherA } = await world();
    const res = await teacherA.get(`/students/${taro.student.id}`);
    expect(Object.keys(res.data).sort()).toEqual(['email', 'id', 'lessonRecords', 'name', 'phone', 'teacherNote']);
    expect(res.text).not.toContain('千代田区');
    expect(res.text).not.toContain('祖母');
  });

  test('担当を外した直後から、その講師の画面に表示されない（SR-07）', async () => {
    const { f, admin, taro, teacherB } = await world();
    expect((await teacherB.get('/students')).data.map((s: any) => s.name)).toEqual(['太郎']);
    await admin.put(`/students/${taro.student.id}/teachers`, { teacherIds: [f.teacherA.teacher.id] });
    expect((await teacherB.get('/students')).data).toEqual([]);
    expect((await teacherB.get(`/students/${taro.student.id}`)).status).toBe(404);
    expect((await teacherB.put(`/students/${taro.student.id}/teacher-note`, { text: 'x' })).status).toBe(404);
  });
});

describe('5.2 権限の自動テスト', () => {
  test('生徒は他の生徒の予約・連絡先・入金情報を見られない', async () => {
    const { jiro, studentTaro, f } = await world();
    const other = jiro.student.id;
    for (const path of [`/students/${other}/home`, `/students/${other}/reservations`, `/students/${other}/teachers`]) {
      expect((await studentTaro.get(path)).status).toBe(404);
    }
    expect((await studentTaro.get(`/students/${other}/slots?teacherId=${f.teacherA.teacher.id}&from=2026-10-21&to=2026-10-28`)).status).toBe(404);
    const list = (await studentTaro.get('/students')).data;
    expect(list.map((s: any) => s.name)).toEqual(['太郎']);
  });

  test('講師は担当外の生徒の情報を見られない', async () => {
    const { jiro, teacherB } = await world();
    expect((await teacherB.get(`/students/${jiro.student.id}`)).status).toBe(404);
    expect((await teacherB.get('/students')).data.map((s: any) => s.name)).not.toContain('次郎');
  });

  test('講師と生徒は管理の API を使えない', async () => {
    const { f, taro } = await world();
    const asTeacher = f.browser('manage');
    expect((await asTeacher.login(f.teacherA.account.email)).status).toBe(401);
    const asStudent = f.browser('manage');
    expect((await asStudent.login(taro.account.email)).status).toBe(401);
    expect((await asStudent.get('/students')).status).toBe(401);
  });

  test('講師は他の講師の空き時間を変えられず、自分の分だけ変えられる', async () => {
    const { teacherA, f } = await world();
    const mine = await teacherA.post('/availability', { change: { addExceptions: [{ date: '2026-10-30', kind: 'block' }] } });
    expect(mine.data.applied).toBe(true);
    // 講師のポータルには他の講師を指定する口がない
    expect((await teacherA.post(`/teachers/${f.teacherB.teacher.id}/availability`, { change: {} })).status).toBe(404);
  });
});

describe('AV-02 講師の画面での警告', () => {
  test('予約がある時間帯を消そうとすると、件数・生徒名・日時を返し、確認なしでは変わらない', async () => {
    const { f, taro, teacherA } = await world();
    await bookAsStudent(f.ctx, taro.actor, {
      studentId: taro.student.id,
      teacherId: f.teacherA.teacher.id,
      lessonTypeId: f.privateType.id,
      startsAt: jst('2026-10-22', '15:00'),
    });
    const res = await teacherA.post('/availability', { change: { rules: [] } });
    expect(res.data.applied).toBe(false);
    expect(res.data.affected).toEqual([
      { reservationId: expect.any(String), studentName: '太郎', startsAt: jst('2026-10-22', '15:00').toISOString() },
    ]);
    const confirmed = await teacherA.post('/availability', { change: { rules: [] }, confirm: true });
    expect(confirmed.data.applied).toBe(true);
  });
});
