import { describe, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { students, studentTeachers, teacherPhotos, teachers } from '../src/db/schema.js';
import { createTeacher, importStudentsCsv, setStudentTeachers } from '../src/domain/people.js';
import { createReview, reviewsForTeacher } from '../src/domain/reviews.js';
import {
  importTeacherProfiles,
  myProfile,
  profileForAdmin,
  setMyPhoto,
  setPhotoAsAdmin,
  teacherProfilesForStudent,
  updateMyProfile,
  updateProfileAsAdmin,
} from '../src/domain/teacher-profiles.js';
import { updateSettings } from '../src/domain/settings.js';
import { setup } from './fixtures.js';
import { setupHttp } from './http.js';

// 講師のプロフィール（TC-05〜07）: データベースに持ち、管理画面と講師本人が編集する。講師を増やしても開発者の作業は要らない

/** 1×1 の JPEG・PNG（先頭の印だけ本物と同じ。中身は短い見本） */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);
const photo = (b: Buffer, contentType = 'image/jpeg') => ({ contentType, dataBase64: b.toString('base64') });

describe('TC-06 管理者が講師を増やし、プロフィールと写真を入れる', () => {
  test('TC-06 講師を登録するのにプロフィールのキーは要らず、管理画面で楽器・経歴・ひとこと・写真を入れると生徒に表示される', async () => {
    const f = await setup();
    const t = await createTeacher(f.ctx, f.admin, { name: '新しい 先生', email: 'new-teacher@example.test' });
    expect(f.mail.sent.at(-1)?.to).toBe('new-teacher@example.test');
    await updateProfileAsAdmin(f.ctx, f.admin, t.id, { instruments: ['サックス', ' フルート '], career: '音大卒', message: 'よろしくお願いします' });
    await setPhotoAsAdmin(f.ctx, f.admin, t.id, photo(JPEG));

    const { student, actor } = await f.mkStudent('太郎');
    await setStudentTeachers(f.ctx, f.admin, student.id, [t.id]);
    const [p] = await teacherProfilesForStudent(f.ctx, actor, student.id);
    expect(p).toMatchObject({ teacherId: t.id, name: '新しい 先生', instruments: ['サックス', 'フルート'], career: '音大卒', message: 'よろしくお願いします' });
    // 写真は生徒の画面の /api から見た場所。差し替えたら URL も変わる
    expect(p!.photo).toMatch(new RegExp(`^/api/students/${student.id}/teachers/${t.id}/photo\\?v=\\d+$`));

    // 新しい講師にもレビューを書ける（RV-01）。講師の画面に届く
    await createReview(f.ctx, actor, student.id, { teacherId: t.id, body: '分かりやすいです' });
    const acc = (await f.db.select().from(teachers).where(eq(teachers.id, t.id)))[0]!;
    const teacherActor = { kind: 'account' as const, accountId: acc.accountId, role: 'teacher' as const };
    expect((await reviewsForTeacher(f.ctx, teacherActor)).reviews.map((r: { body: string }) => r.body)).toEqual(['分かりやすいです']);
  });

  test('TC-06 プロフィールの入力の誤りは、理由を日本語で返す', async () => {
    const f = await setup();
    const id = f.teacherA.teacher.id;
    await expect(updateProfileAsAdmin(f.ctx, f.admin, id, { instruments: Array(11).fill('ピアノ'), career: '', message: '' })).rejects.toThrow('10個まで');
    await expect(updateProfileAsAdmin(f.ctx, f.admin, id, { instruments: [], career: 'あ'.repeat(2001), message: '' })).rejects.toThrow('2000文字まで');
    await expect(updateProfileAsAdmin(f.ctx, f.teacherA.actor, id, { instruments: [], career: '', message: '' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  test('TC-06 写真は JPEG・PNG・WebP だけで、中身が合っているものを受け付ける', async () => {
    const f = await setup();
    const id = f.teacherA.teacher.id;
    await expect(setPhotoAsAdmin(f.ctx, f.admin, id, photo(JPEG, 'image/gif'))).rejects.toThrow('JPEG・PNG・WebP');
    await expect(setPhotoAsAdmin(f.ctx, f.admin, id, photo(PNG, 'image/jpeg'))).rejects.toThrow('読めませんでした');
    await setPhotoAsAdmin(f.ctx, f.admin, id, photo(PNG, 'image/png'));
    const p = await profileForAdmin(f.ctx, f.admin, id);
    expect(p.photo).toMatch(/^\/api\/teachers\/.+\/photo\?v=\d+$/);
    expect(p).toMatchObject({ photoSize: PNG.length, photoLarge: false });
  });

  test('TC-06 おすすめの大きさ（初期値 800KB）を超えた写真も受け付け、大きめだと分かる。上限（初期値 15MB）を超えると日本語で断る', async () => {
    const f = await setup();
    const id = f.teacherA.teacher.id;
    const big = Buffer.concat([JPEG, Buffer.alloc(900 * 1024)]);
    await setPhotoAsAdmin(f.ctx, f.admin, id, photo(big));
    expect(await profileForAdmin(f.ctx, f.admin, id)).toMatchObject({ photoSize: big.length, photoLarge: true });
    // 講師本人の画面でも大きめだと分かる（TC-07）
    await setMyPhoto(f.ctx, f.teacherA.actor, photo(big));
    expect(await myProfile(f.ctx, f.teacherA.actor)).toMatchObject({ photoLarge: true });
    // 画質を下げて送り直すと、大きめの表示は消える
    await setPhotoAsAdmin(f.ctx, f.admin, id, photo(JPEG));
    expect((await profileForAdmin(f.ctx, f.admin, id)).photoLarge).toBe(false);
    // 上限はサーバーを守るためだけのもの
    await updateSettings(f.db, { teacherPhotoHardMaxMB: 1 }, null);
    const huge = Buffer.concat([JPEG, Buffer.alloc(1024 * 1024)]);
    await expect(setPhotoAsAdmin(f.ctx, f.admin, id, photo(huge))).rejects.toThrow('写真が大きすぎます（1MBまで）');
  });
});

describe('TC-07 講師は自分のプロフィールを編集できる', () => {
  test('TC-07 講師は自分のプロフィールと写真だけを変えられる', async () => {
    const f = await setup();
    await updateMyProfile(f.ctx, f.teacherA.actor, { instruments: ['ピアノ'], career: '', message: 'こんにちは' });
    await setMyPhoto(f.ctx, f.teacherA.actor, photo(JPEG));
    const mine = await myProfile(f.ctx, f.teacherA.actor);
    expect(mine).toMatchObject({ teacherId: f.teacherA.teacher.id, message: 'こんにちは' });
    expect(mine.photo).toMatch(/^\/api\/profile\/photo\?v=\d+$/);
    // 講師B のプロフィールは変わっていない
    expect((await profileForAdmin(f.ctx, f.admin, f.teacherB.teacher.id)).message).toBe('');
    // 生徒は講師のプロフィールを編集できない
    const { actor } = await f.mkStudent('太郎');
    await expect(updateMyProfile(f.ctx, actor, { instruments: [], career: '', message: '' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('TC-05 / 5.2 写真を見られる人', () => {
  test('TC-05 生徒は担当講師の写真だけを見られ、担当でない講師・ほかの家庭の生徒としては「見つからない」', async () => {
    const f = await setupHttp();
    await setPhotoAsAdmin(f.ctx, f.admin, f.teacherA.teacher.id, photo(JPEG));
    await setPhotoAsAdmin(f.ctx, f.admin, f.teacherB.teacher.id, photo(JPEG));
    const taro = await f.mkStudent('太郎');
    const other = await f.mkStudent('次郎');
    await f.setPassword(taro.account.id);
    const b = f.browser('student');
    await b.login(taro.account.email);

    const ok = await f.app.request(`/api/student/students/${taro.student.id}/teachers/${f.teacherA.teacher.id}/photo`, {
      headers: { cookie: [...b.jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/jpeg');
    expect(ok.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(Buffer.from(await ok.arrayBuffer()).equals(JPEG)).toBe(true);
    // 同じ写真なら 304
    const again = await f.app.request(`/api/student/students/${taro.student.id}/teachers/${f.teacherA.teacher.id}/photo`, {
      headers: { cookie: [...b.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'if-none-match': ok.headers.get('etag')! },
    });
    expect(again.status).toBe(304);

    expect((await b.get(`/students/${taro.student.id}/teachers/${f.teacherB.teacher.id}/photo`)).status).toBe(404);
    expect((await b.get(`/students/${other.student.id}/teachers/${f.teacherA.teacher.id}/photo`)).status).toBe(404);
    // ログインしていなければ見られない
    expect((await f.browser('student').get(`/students/${taro.student.id}/teachers/${f.teacherA.teacher.id}/photo`)).status).toBe(401);
  });

  test('TC-06 写真の送信も JSON だけを受け付ける（CSRF 対策）', async () => {
    const f = await setupHttp();
    const admin = await f.adminBrowser();
    const res = await f.app.request(`/api/manage/teachers/${f.teacherA.teacher.id}/photo`, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg', cookie: [...admin.jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: JPEG,
    });
    expect(res.status).toBe(415);
    expect((await admin.put(`/teachers/${f.teacherA.teacher.id}/photo`, photo(JPEG))).status).toBe(200);
  });
});

describe('TC-06 以前のデータファイルからの取り込み', () => {
  test('TC-06 プロフィールが空の講師にだけ入れ、何度実行しても同じ結果になる', async () => {
    const f = await setup();
    const dir = mkdtempSync(join(tmpdir(), 'profiles-'));
    writeFileSync(join(dir, 'a.jpg'), JPEG);
    writeFileSync(
      join(dir, 'profiles.json'),
      JSON.stringify([
        { slug: 'teacher-a', name: '講師A', photo: 'a.jpg', instruments: ['ピアノ'], career: '音大卒', message: 'よろしく' },
        { slug: 'teacher-b', name: '講師B', photo: null, instruments: ['ギター'], career: '', message: 'ギターです' },
        { slug: 'unknown', name: '誰か', photo: null, instruments: [], career: '', message: '' },
      ]),
    );
    // 講師B は管理画面で編集済み
    await updateProfileAsAdmin(f.ctx, f.admin, f.teacherB.teacher.id, { instruments: ['ドラム'], career: '', message: '' });
    const run = () => importTeacherProfiles(f.db, join(dir, 'profiles.json'), (p) => join(dir, p), f.clock.now);
    expect(await run()).toEqual({ profiles: 1, photos: 1 });
    expect(await run()).toEqual({ profiles: 0, photos: 0 });
    expect((await profileForAdmin(f.ctx, f.admin, f.teacherA.teacher.id)).instruments).toEqual(['ピアノ']);
    expect((await profileForAdmin(f.ctx, f.admin, f.teacherB.teacher.id)).instruments).toEqual(['ドラム']);
    expect(await f.db.select().from(teacherPhotos)).toHaveLength(1);
  });
});

describe('ST-01 CSV で生徒をまとめて登録する（コース・担当講師も）', () => {
  test('ST-01 7列目から「月額コース」「担当講師」を書くと、コースと担当講師も入る。以前の6列の CSV もそのまま使える', async () => {
    const f = await setup();
    const head = 'ログインメール,保護者名,生徒名,電話番号,生徒のメール,住所';
    const old = await importStudentsCsv(f.ctx, f.admin, `${head}\nold@example.test,保護者,前の形,090-0000-0000,,`);
    expect(old).toEqual({ created: 1, errors: [] });

    const csv = `${head},月額コース,担当講師\nnew1@example.test,,花子,,,,月4回,講師A、講師B\nnew2@example.test,,次郎,,,,,`;
    expect(await importStudentsCsv(f.ctx, f.admin, csv)).toEqual({ created: 2, errors: [] });
    const [hanako] = await f.db.select().from(students).where(eq(students.name, '花子'));
    expect(hanako!.courseId).toBe(f.course.id);
    const assigned = await f.db.select().from(studentTeachers).where(eq(studentTeachers.studentId, hanako!.id));
    expect(assigned.map((a) => a.teacherId).sort()).toEqual([f.teacherA.teacher.id, f.teacherB.teacher.id].sort());
  });

  test('ST-01 見つからないコース・講師の名前は行番号と理由を返し、何も登録しない', async () => {
    const f = await setup();
    const csv = 'ログインメール,保護者名,生徒名,電話番号,生徒のメール,住所,月額コース,担当講師\na@example.test,,A,,,,ないコース,\nb@example.test,,B,,,,,いない先生';
    const r = await importStudentsCsv(f.ctx, f.admin, csv);
    expect(r.created).toBe(0);
    expect(r.errors).toEqual([
      { line: 2, message: '月額コース「ないコース」が見つかりません' },
      { line: 3, message: '担当講師「いない先生」が見つかりません' },
    ]);
    await expect(importStudentsCsv(f.ctx, f.admin, 'ログインメール,保護者名,生徒名,電話番号,生徒のメール,住所,誕生日\n')).rejects.toThrow('「誕生日」は使えません');
  });
});
