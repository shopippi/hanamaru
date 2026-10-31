import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { reviews, teachers } from '../db/schema.js';
import { assignedTeacherIds, studentForActor, teacherOfActor, type Student } from './access.js';
import type { Actor, Ctx } from './context.js';
import { forbidden, invalid, notFound } from './errors.js';
import { getSettings } from './settings.js';

// 講師へのレビュー（RV-01〜RV-05）。
// - 生徒は担当講師にレビューを何件でも書け、自分のレビューだけを見る・直す・消すことができる
// - 講師の名前をキーに残すので、生徒を消してもレビューは残る（書いた時点の生徒の名前を持つ）
// - 講師は自分へのレビューを見て「確認した」を付ける。書き直されたレビューは未確認に戻る

type Review = typeof reviews.$inferSelect;

/** レビューを書けるのは生徒のアカウントだけ。他人の生徒は「見つからない」（5.2） */
async function reviewer(ctx: Ctx, actor: Actor, studentId: string): Promise<Student> {
  if (actor.kind !== 'account' || actor.role !== 'student') throw forbidden();
  return studentForActor(ctx.db, actor, studentId);
}

async function parseBody(ctx: Ctx, raw: unknown): Promise<string> {
  const max = (await getSettings(ctx.db)).reviewMaxLength;
  const r = z.object({ body: z.string() }).safeParse(raw);
  const text = r.success ? r.data.body.trim() : '';
  if (!text) throw invalid('レビューを入力してください', [{ path: ['body'], message: 'レビューを入力してください' }]);
  if (text.length > max) throw invalid(`レビューは${max}文字以内で入力してください`, [{ path: ['body'], message: `${max}文字以内で入力してください` }]);
  return text;
}

const forStudent = (r: Review) => ({
  id: r.id,
  teacherId: r.teacherId,
  teacherName: r.teacherName,
  body: r.body,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  edited: r.updatedAt.getTime() > r.createdAt.getTime(),
});

/** 担当講師へのレビューを書く（RV-01）。件数の上限はない */
export async function createReview(ctx: Ctx, actor: Actor, studentId: string, raw: unknown) {
  const s = await reviewer(ctx, actor, studentId);
  const teacherId = z.object({ teacherId: z.string().uuid() }).safeParse(raw);
  if (!teacherId.success) throw notFound('講師が見つかりません');
  const assigned = await assignedTeacherIds(ctx.db, s.id);
  const [t] = assigned.includes(teacherId.data.teacherId)
    ? await ctx.db.select().from(teachers).where(eq(teachers.id, teacherId.data.teacherId))
    : [];
  if (!t || !t.active) throw notFound('講師が見つかりません');
  const text = await parseBody(ctx, raw);
  const now = ctx.now();
  const [r] = await ctx.db
    .insert(reviews)
    .values({ teacherName: t.name, teacherId: t.id, studentId: s.id, authorName: s.name, body: text, createdAt: now, updatedAt: now })
    .returning();
  return forStudent(r!);
}

/** 自分が書いたレビュー（RV-02）。新しい順 */
export async function myReviews(ctx: Ctx, actor: Actor, studentId: string) {
  const s = await reviewer(ctx, actor, studentId);
  const rows = await ctx.db.select().from(reviews).where(eq(reviews.studentId, s.id)).orderBy(desc(reviews.createdAt));
  return rows.map(forStudent);
}

/** 生徒の画面用: 自分のレビューと、1件の文字数の上限 */
export async function myReviewsPage(ctx: Ctx, actor: Actor, studentId: string) {
  const list = await myReviews(ctx, actor, studentId);
  return { maxLength: (await getSettings(ctx.db)).reviewMaxLength, reviews: list };
}

async function ownReview(ctx: Ctx, s: Student, reviewId: string): Promise<Review> {
  if (!z.string().uuid().safeParse(reviewId).success) throw notFound('レビューが見つかりません');
  const [r] = await ctx.db
    .select()
    .from(reviews)
    .where(and(eq(reviews.id, reviewId), eq(reviews.studentId, s.id)));
  if (!r) throw notFound('レビューが見つかりません');
  return r;
}

/** 自分のレビューを書き直す（RV-03）。講師には未確認として出し直す */
export async function updateReview(ctx: Ctx, actor: Actor, studentId: string, reviewId: string, raw: unknown) {
  const s = await reviewer(ctx, actor, studentId);
  const r = await ownReview(ctx, s, reviewId);
  const text = await parseBody(ctx, raw);
  const [u] = await ctx.db
    .update(reviews)
    .set({ body: text, updatedAt: ctx.now(), checkedAt: null })
    .where(eq(reviews.id, r.id))
    .returning();
  return forStudent(u!);
}

/** 自分のレビューを消す（RV-03） */
export async function deleteReview(ctx: Ctx, actor: Actor, studentId: string, reviewId: string): Promise<void> {
  const s = await reviewer(ctx, actor, studentId);
  const r = await ownReview(ctx, s, reviewId);
  await ctx.db.delete(reviews).where(eq(reviews.id, r.id));
}

/** その講師へのレビュー。講師を作り直しても名前で見つかる */
const ofTeacher = (t: { id: string; name: string }) =>
  or(eq(reviews.teacherId, t.id), and(isNull(reviews.teacherId), eq(reviews.teacherName, t.name)));

async function selfTeacher(ctx: Ctx, actor: Actor) {
  const t = await teacherOfActor(ctx.db, actor);
  if (!t) throw forbidden();
  return t;
}

/** 講師が自分へのレビューを見る（RV-04）。新しい順。誰からかと、未確認かどうかが分かる */
export async function reviewsForTeacher(ctx: Ctx, actor: Actor) {
  const t = await selfTeacher(ctx, actor);
  const rows = await ctx.db.select().from(reviews).where(ofTeacher(t)).orderBy(desc(reviews.createdAt));
  return {
    unread: rows.filter((r) => !r.checkedAt).length,
    reviews: rows.map((r) => ({
      id: r.id,
      authorName: r.authorName,
      body: r.body,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      edited: r.updatedAt.getTime() > r.createdAt.getTime(),
      checked: !!r.checkedAt,
    })),
  };
}

/** 確認した印を付ける（RV-05）。ほかの講師へのレビューは「見つからない」 */
export async function markReviewChecked(ctx: Ctx, actor: Actor, reviewId: string): Promise<void> {
  const t = await selfTeacher(ctx, actor);
  if (!z.string().uuid().safeParse(reviewId).success) throw notFound('レビューが見つかりません');
  const [r] = await ctx.db
    .select()
    .from(reviews)
    .where(and(eq(reviews.id, reviewId), ofTeacher(t)));
  if (!r) throw notFound('レビューが見つかりません');
  if (!r.checkedAt) await ctx.db.update(reviews).set({ checkedAt: ctx.now() }).where(eq(reviews.id, r.id));
}

/** 未確認のレビューをすべて確認済みにする（RV-05） */
export async function markAllReviewsChecked(ctx: Ctx, actor: Actor): Promise<number> {
  const t = await selfTeacher(ctx, actor);
  const done = await ctx.db
    .update(reviews)
    .set({ checkedAt: ctx.now() })
    .where(and(ofTeacher(t), isNull(reviews.checkedAt)))
    .returning({ id: reviews.id });
  return done.length;
}
