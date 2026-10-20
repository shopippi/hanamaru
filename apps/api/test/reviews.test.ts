import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { reviews, students, studentTeachers } from '../src/db/schema.js';
import {
  createReview,
  deleteReview,
  markAllReviewsChecked,
  markReviewChecked,
  myReviews,
  reviewsForTeacher,
  updateReview,
} from '../src/domain/reviews.js';
import { updateSettings } from '../src/domain/settings.js';
import { setup } from './fixtures.js';
import { setupHttp } from './http.js';

// 講師へのレビュー（RV-01〜RV-05）

describe('RV-01 / RV-02 生徒はレビューを何件でも書き、自分のレビューを見られる', () => {
  test('RV-01 担当講師にレビューを書ける。件数の上限はない', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('はな太郎');
    for (let i = 1; i <= 3; i++) {
      await createReview(f.ctx, actor, student.id, { teacherId: f.teacherA.teacher.id, body: `${i}回目のレッスンも楽しかったです` });
      f.clock.now = new Date(f.clock.now.getTime() + 60_000);
    }
    const list = await myReviews(f.ctx, actor, student.id);
    expect(list.map((r) => r.body)).toEqual(['3回目のレッスンも楽しかったです', '2回目のレッスンも楽しかったです', '1回目のレッスンも楽しかったです']);
    expect(list[0]).toMatchObject({ teacherName: '講師A', edited: false });
  });

  test('RV-01 担当でない講師には書けず、空や長すぎる文は断る（上限は設定値）', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('はな太郎');
    await expect(createReview(f.ctx, actor, student.id, { teacherId: f.teacherB.teacher.id, body: 'よかった' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(createReview(f.ctx, actor, student.id, { teacherId: f.teacherA.teacher.id, body: '   ' })).rejects.toThrow('レビューを入力してください');
    await updateSettings(f.db, { reviewMaxLength: 50 }, null);
    await expect(createReview(f.ctx, actor, student.id, { teacherId: f.teacherA.teacher.id, body: 'あ'.repeat(51) })).rejects.toThrow('50文字以内');
    await createReview(f.ctx, actor, student.id, { teacherId: f.teacherA.teacher.id, body: 'あ'.repeat(50) });
  });

  test('RV-02 ほかの生徒のレビューは見えず、直すことも消すこともできない（見つからない扱い: 5.2）', async () => {
    const f = await setup();
    const hana = await f.mkStudent('はな太郎');
    const maru = await f.mkStudent('まる子');
    const r = await createReview(f.ctx, hana.actor, hana.student.id, { teacherId: f.teacherA.teacher.id, body: 'はな太郎のレビュー' });
    expect(await myReviews(f.ctx, maru.actor, maru.student.id)).toEqual([]);
    await expect(myReviews(f.ctx, maru.actor, hana.student.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(updateReview(f.ctx, maru.actor, maru.student.id, r.id, { body: '書き換え' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(deleteReview(f.ctx, maru.actor, maru.student.id, r.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await myReviews(f.ctx, hana.actor, hana.student.id))[0]!.body).toBe('はな太郎のレビュー');
  });

  test('RV-02 講師・管理者のアカウントからは、生徒としてレビューを書けない', async () => {
    const f = await setup();
    const { student } = await f.mkStudent('はな太郎');
    await expect(createReview(f.ctx, f.admin, student.id, { teacherId: f.teacherA.teacher.id, body: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createReview(f.ctx, f.teacherA.actor, student.id, { teacherId: f.teacherA.teacher.id, body: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('RV-03 自分のレビューを直す・消す', () => {
  test('RV-03 書き直すと「編集済み」になり、講師には未確認として出し直す', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('はな太郎');
    const r = await createReview(f.ctx, actor, student.id, { teacherId: f.teacherA.teacher.id, body: '最初の感想' });
    await markReviewChecked(f.ctx, f.teacherA.actor, r.id);
    expect((await reviewsForTeacher(f.ctx, f.teacherA.actor)).unread).toBe(0);
    f.clock.now = new Date(f.clock.now.getTime() + 60_000);
    const u = await updateReview(f.ctx, actor, student.id, r.id, { body: '書き直した感想' });
    expect(u).toMatchObject({ body: '書き直した感想', edited: true });
    const t = await reviewsForTeacher(f.ctx, f.teacherA.actor);
    expect(t.unread).toBe(1);
    expect(t.reviews[0]).toMatchObject({ body: '書き直した感想', edited: true, checked: false });
  });

  test('RV-03 消したレビューは、生徒にも講師にも出ない', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('はな太郎');
    const r = await createReview(f.ctx, actor, student.id, { teacherId: f.teacherA.teacher.id, body: '消す感想' });
    await deleteReview(f.ctx, actor, student.id, r.id);
    expect(await myReviews(f.ctx, actor, student.id)).toEqual([]);
    expect((await reviewsForTeacher(f.ctx, f.teacherA.actor)).reviews).toEqual([]);
  });
});

describe('RV-04 / RV-05 講師はレビューを見て、確認した印を付ける', () => {
  test('RV-04 講師は自分へのレビューだけを、誰からかと一緒に新しい順で見る。未確認の数が分かる', async () => {
    const f = await setup();
    const hana = await f.mkStudent('はな太郎', { teachers: [f.teacherA.teacher.id, f.teacherB.teacher.id] });
    await createReview(f.ctx, hana.actor, hana.student.id, { teacherId: f.teacherA.teacher.id, body: 'A先生へ' });
    f.clock.now = new Date(f.clock.now.getTime() + 60_000);
    await createReview(f.ctx, hana.actor, hana.student.id, { teacherId: f.teacherB.teacher.id, body: 'B先生へ' });
    const a = await reviewsForTeacher(f.ctx, f.teacherA.actor);
    expect(a).toMatchObject({ unread: 1, reviews: [{ authorName: 'はな太郎', body: 'A先生へ', checked: false }] });
    expect((await reviewsForTeacher(f.ctx, f.teacherB.actor)).reviews.map((r) => r.body)).toEqual(['B先生へ']);
    await expect(reviewsForTeacher(f.ctx, hana.actor)).rejects.toMatchObject({ code: 'forbidden' });
  });

  test('RV-05 1件ずつ、またはまとめて確認済みにできる。ほかの講師へのレビューには付けられない', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('はな太郎', { teachers: [f.teacherA.teacher.id, f.teacherB.teacher.id] });
    const r1 = await createReview(f.ctx, actor, student.id, { teacherId: f.teacherA.teacher.id, body: '1' });
    await createReview(f.ctx, actor, student.id, { teacherId: f.teacherA.teacher.id, body: '2' });
    const rb = await createReview(f.ctx, actor, student.id, { teacherId: f.teacherB.teacher.id, body: 'B' });
    await expect(markReviewChecked(f.ctx, f.teacherA.actor, rb.id)).rejects.toMatchObject({ code: 'not_found' });
    await markReviewChecked(f.ctx, f.teacherA.actor, r1.id);
    await markReviewChecked(f.ctx, f.teacherA.actor, r1.id);
    expect((await reviewsForTeacher(f.ctx, f.teacherA.actor)).unread).toBe(1);
    expect(await markAllReviewsChecked(f.ctx, f.teacherA.actor)).toBe(1);
    expect((await reviewsForTeacher(f.ctx, f.teacherA.actor)).unread).toBe(0);
    expect((await reviewsForTeacher(f.ctx, f.teacherB.actor)).unread).toBe(1);
  });
});

describe('RV-01 レビューは講師の名前をキーに残る', () => {
  test('RV-01 生徒のデータを消しても、レビューは書いた時点の名前で講師に残る', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('はな太郎');
    await createReview(f.ctx, actor, student.id, { teacherId: f.teacherA.teacher.id, body: 'ありがとうございました' });
    await f.db.delete(studentTeachers).where(eq(studentTeachers.studentId, student.id));
    await f.db.delete(students).where(eq(students.id, student.id));
    const [row] = await f.db.select().from(reviews);
    expect(row).toMatchObject({ studentId: null, authorName: 'はな太郎', teacherName: '講師A' });
    expect((await reviewsForTeacher(f.ctx, f.teacherA.actor)).reviews[0]).toMatchObject({ authorName: 'はな太郎', body: 'ありがとうございました' });
  });

  test('RV-04 講師との紐付けが外れても（講師を登録し直したなど）、同じ名前の講師に表示される', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('はな太郎');
    await createReview(f.ctx, actor, student.id, { teacherId: f.teacherA.teacher.id, body: '名前で残る' });
    await f.db.update(reviews).set({ teacherId: null });
    expect((await reviewsForTeacher(f.ctx, f.teacherA.actor)).reviews.map((r) => r.body)).toEqual(['名前で残る']);
  });
});

describe('RV-02 HTTP: JSON だけを受け付け、他人のレビューの番号は見つからない', () => {
  test('RV-02 生徒の画面の API で書いて・直して・消せる', async () => {
    const f = await setupHttp();
    const { student, account } = await f.mkStudent('はな太郎');
    await f.setPassword(account.id);
    const b = f.browser('student');
    await b.login(account.email);
    const created = await b.post(`/students/${student.id}/reviews`, { teacherId: f.teacherA.teacher.id, body: 'よかった' });
    expect(created.status).toBe(201);
    expect((await b.patch(`/students/${student.id}/reviews/${created.data.id}`, { body: 'とてもよかった' })).status).toBe(200);
    const page = (await b.get(`/students/${student.id}/reviews`)).data;
    expect(page.maxLength).toBe(1000);
    expect(page.reviews[0].body).toBe('とてもよかった');
    expect((await b.del(`/students/${student.id}/reviews/${created.data.id}`)).status).toBe(200);
    expect((await b.del(`/students/${student.id}/reviews/00000000-0000-0000-0000-000000000000`)).status).toBe(404);
  });
});
