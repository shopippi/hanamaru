import { eq, inArray, sql } from 'drizzle-orm';
import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { teacherPhotos, teachers } from '../db/schema.js';
import { assertAdmin, assignedTeacherIds, studentForActor, teacherOfActor } from './access.js';
import { audit } from './audit.js';
import type { Actor, Ctx } from './context.js';
import { forbidden, invalid, notFound } from './errors.js';
import { getSettings } from './settings.js';

// 講師のプロフィール（TC-05、TC-06、TC-07）。データベースに持ち、管理画面と講師本人が編集する。
// 講師を増やしても、開発者の作業なしに画面へ出せる

export const profileInput = z.object({
  instruments: z
    .array(z.string().trim().min(1).max(30, '楽器の名前は30文字までにしてください'))
    .max(10, '担当の楽器は10個までにしてください'),
  career: z.string().trim().max(2000, '経歴は2000文字までにしてください'),
  message: z.string().trim().max(1000, 'ひとことは1000文字までにしてください'),
});
export type ProfileInput = z.infer<typeof profileInput>;

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const photoInput = z.object({
  contentType: z.enum(PHOTO_TYPES, { message: '写真は JPEG・PNG・WebP のどれかにしてください' }),
  dataBase64: z.string().min(1, '写真を選んでください'),
});

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const r = schema.safeParse(raw);
  if (!r.success) throw invalid(r.error.issues[0]?.message ?? '入力に誤りがあります', r.error.issues);
  return r.data;
}

/** 画像の先頭の数バイトで、名乗った形式と中身が合っているかを確かめる */
function looksLike(type: (typeof PHOTO_TYPES)[number], b: Buffer): boolean {
  if (type === 'image/jpeg') return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === 'image/png') return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP';
}

export interface ProfileView {
  teacherId: string;
  name: string;
  instruments: string[];
  career: string;
  message: string;
  /** 写真の URL（各画面の /api から見た場所）。写真がなければ null */
  photo: string | null;
  /** 写真の大きさ（バイト）。写真がなければ null。編集する画面（管理者・講師本人）にだけ返す */
  photoSize?: number | null;
  /** おすすめの大きさ（設定値）を超えている。編集画面に「画質を下げる」を出す */
  photoLarge?: boolean;
  /** おすすめの大きさ（KB、設定値）。「画質を下げる」はこの大きさに収まるまで下げる */
  photoRecommendedKB?: number;
}

type Teacher = typeof teachers.$inferSelect;

interface PhotoMeta {
  updatedAt: Date;
  size: number;
}

async function photoVersions(db: Db, ids: string[]): Promise<Map<string, PhotoMeta>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ teacherId: teacherPhotos.teacherId, updatedAt: teacherPhotos.updatedAt, size: sql<number>`octet_length(${teacherPhotos.data})` })
    .from(teacherPhotos)
    .where(inArray(teacherPhotos.teacherId, ids));
  return new Map(rows.map((r) => [r.teacherId, { updatedAt: r.updatedAt, size: Number(r.size) }]));
}

/** 写真の URL。更新日時を付けて、写真を差し替えたら画面のキャッシュも新しくなるようにする */
const withVersion = (path: string, meta: PhotoMeta | undefined) => (meta ? `${path}?v=${meta.updatedAt.getTime()}` : null);

function view(t: Teacher, path: string, meta: PhotoMeta | undefined, recommendedKB: number): ProfileView {
  return {
    teacherId: t.id,
    name: t.name,
    instruments: t.instruments,
    career: t.career,
    message: t.message,
    photo: withVersion(path, meta),
    photoSize: meta?.size ?? null,
    photoLarge: !!meta && meta.size > recommendedKB * 1024,
    photoRecommendedKB: recommendedKB,
  };
}

/** 生徒が見られるのは担当講師のプロフィールだけ（TC-05） */
export async function teacherProfilesForStudent(ctx: Ctx, actor: Actor, studentId: string): Promise<ProfileView[]> {
  const s = await studentForActor(ctx.db, actor, studentId);
  const ids = await assignedTeacherIds(ctx.db, s.id);
  if (ids.length === 0) return [];
  const rows = (await ctx.db.select().from(teachers).where(inArray(teachers.id, ids))).filter((t) => t.active);
  const versions = await photoVersions(ctx.db, rows.map((t) => t.id));
  const { teacherPhotoRecommendedKB } = await getSettings(ctx.db);
  // 担当にした順に並べる
  return ids
    .map((id) => rows.find((t) => t.id === id))
    .filter((t): t is Teacher => !!t)
    .map((t) => {
      // 生徒の画面には写真の大きさは要らない
      const { photoSize: _size, photoLarge: _large, photoRecommendedKB: _kb, ...v } = view(t, `/api/students/${s.id}/teachers/${t.id}/photo`, versions.get(t.id), teacherPhotoRecommendedKB);
      return v;
    });
}

async function loadTeacher(db: Db, teacherId: string): Promise<Teacher> {
  const [t] = await db.select().from(teachers).where(eq(teachers.id, teacherId));
  if (!t) throw notFound('講師が見つかりません');
  return t;
}

async function myTeacher(ctx: Ctx, actor: Actor): Promise<Teacher> {
  const t = await teacherOfActor(ctx.db, actor);
  if (!t) throw forbidden();
  return t;
}

// --- 管理画面（すべての講師） --------------------------------------------------------

export async function profileForAdmin(ctx: Ctx, actor: Actor, teacherId: string): Promise<ProfileView> {
  assertAdmin(actor);
  const t = await loadTeacher(ctx.db, teacherId);
  const v = await photoVersions(ctx.db, [t.id]);
  const { teacherPhotoRecommendedKB } = await getSettings(ctx.db);
  return view(t, `/api/teachers/${t.id}/photo`, v.get(t.id), teacherPhotoRecommendedKB);
}

export async function updateProfileAsAdmin(ctx: Ctx, actor: Actor, teacherId: string, raw: unknown): Promise<ProfileView> {
  assertAdmin(actor);
  const input = parse(profileInput, raw);
  await loadTeacher(ctx.db, teacherId);
  await ctx.db.update(teachers).set(input).where(eq(teachers.id, teacherId));
  await audit(ctx.db, actor, 'teacher.profile', 'teacher', teacherId, { instruments: input.instruments });
  return profileForAdmin(ctx, actor, teacherId);
}

export async function setPhotoAsAdmin(ctx: Ctx, actor: Actor, teacherId: string, raw: unknown): Promise<ProfileView> {
  assertAdmin(actor);
  await loadTeacher(ctx.db, teacherId);
  await savePhoto(ctx, teacherId, raw);
  await audit(ctx.db, actor, 'teacher.photo', 'teacher', teacherId);
  return profileForAdmin(ctx, actor, teacherId);
}

export async function deletePhotoAsAdmin(ctx: Ctx, actor: Actor, teacherId: string): Promise<void> {
  assertAdmin(actor);
  await ctx.db.delete(teacherPhotos).where(eq(teacherPhotos.teacherId, teacherId));
  await audit(ctx.db, actor, 'teacher.photo_delete', 'teacher', teacherId);
}

// --- 講師本人（TC-07） ------------------------------------------------------------------

export async function myProfile(ctx: Ctx, actor: Actor): Promise<ProfileView> {
  const t = await myTeacher(ctx, actor);
  const v = await photoVersions(ctx.db, [t.id]);
  const { teacherPhotoRecommendedKB } = await getSettings(ctx.db);
  return view(t, '/api/profile/photo', v.get(t.id), teacherPhotoRecommendedKB);
}

export async function updateMyProfile(ctx: Ctx, actor: Actor, raw: unknown): Promise<ProfileView> {
  const t = await myTeacher(ctx, actor);
  const input = parse(profileInput, raw);
  await ctx.db.update(teachers).set(input).where(eq(teachers.id, t.id));
  return myProfile(ctx, actor);
}

export async function setMyPhoto(ctx: Ctx, actor: Actor, raw: unknown): Promise<ProfileView> {
  const t = await myTeacher(ctx, actor);
  await savePhoto(ctx, t.id, raw);
  return myProfile(ctx, actor);
}

export async function deleteMyPhoto(ctx: Ctx, actor: Actor): Promise<void> {
  const t = await myTeacher(ctx, actor);
  await ctx.db.delete(teacherPhotos).where(eq(teacherPhotos.teacherId, t.id));
}

async function savePhoto(ctx: Ctx, teacherId: string, raw: unknown): Promise<void> {
  const input = parse(photoInput, raw);
  const data = Buffer.from(input.dataBase64, 'base64');
  // おすすめの大きさを超えていても受け付ける（あとで画面から画質を下げられる）。上限はサーバーを守るためだけ
  const { teacherPhotoHardMaxMB } = await getSettings(ctx.db);
  if (data.length > teacherPhotoHardMaxMB * 1024 * 1024) {
    throw invalid(`写真が大きすぎます（${teacherPhotoHardMaxMB}MBまで）。別の写真を選ぶか、スマホで小さくしてから選んでください`);
  }
  if (!looksLike(input.contentType, data)) throw invalid('写真のファイルを読めませんでした。別の写真を選んでください');
  const now = ctx.now();
  await ctx.db
    .insert(teacherPhotos)
    .values({ teacherId, contentType: input.contentType, data, updatedAt: now })
    .onConflictDoUpdate({ target: teacherPhotos.teacherId, set: { contentType: input.contentType, data, updatedAt: now } });
}

// --- 写真を返す --------------------------------------------------------------------------

export interface Photo {
  contentType: string;
  data: Buffer;
  updatedAt: Date;
}

async function loadPhoto(db: Db, teacherId: string): Promise<Photo> {
  const [p] = await db.select().from(teacherPhotos).where(eq(teacherPhotos.teacherId, teacherId));
  if (!p) throw notFound('写真がありません');
  return p;
}

/** 生徒は担当講師の写真だけを見られる。担当でなければ「見つからない」（5.2） */
export async function photoForStudent(ctx: Ctx, actor: Actor, studentId: string, teacherId: string): Promise<Photo> {
  const s = await studentForActor(ctx.db, actor, studentId);
  if (!(await assignedTeacherIds(ctx.db, s.id)).includes(teacherId)) throw notFound('写真がありません');
  return loadPhoto(ctx.db, teacherId);
}

export async function photoForAdmin(ctx: Ctx, actor: Actor, teacherId: string): Promise<Photo> {
  assertAdmin(actor);
  return loadPhoto(ctx.db, teacherId);
}

export async function myPhoto(ctx: Ctx, actor: Actor): Promise<Photo> {
  const t = await myTeacher(ctx, actor);
  return loadPhoto(ctx.db, t.id);
}

// --- 以前のデータファイルからの取り込み -------------------------------------------------

const legacyProfile = z.object({
  slug: z.string(),
  name: z.string(),
  photo: z.string().nullable(),
  instruments: z.array(z.string()),
  career: z.string(),
  message: z.string(),
});

/**
 * 以前のプロフィールのデータファイル（JSON）を、講師の profileSlug で照らして取り込む。
 * プロフィールがまだ空の講師だけに入れるので、何度実行しても同じ結果になる。
 * photoFile は JSON の photo（例 "/teachers/matsuda.jpg"）から写真のファイルの場所を返す。
 */
export async function importTeacherProfiles(
  db: Db,
  jsonFile: string,
  photoFile: (photo: string) => string | null,
  now: Date,
): Promise<{ profiles: number; photos: number }> {
  const list = z.array(legacyProfile).parse(JSON.parse(readFileSync(jsonFile, 'utf8')));
  let profiles = 0;
  let photos = 0;
  for (const p of list) {
    const [t] = await db.select().from(teachers).where(eq(teachers.profileSlug, p.slug));
    if (!t) continue;
    if (t.instruments.length === 0 && !t.career && !t.message) {
      await db.update(teachers).set({ instruments: p.instruments, career: p.career, message: p.message }).where(eq(teachers.id, t.id));
      profiles++;
    }
    const file = p.photo ? photoFile(p.photo) : null;
    if (file && existsSync(file)) {
      const [has] = await db.select({ id: teacherPhotos.teacherId }).from(teacherPhotos).where(eq(teacherPhotos.teacherId, t.id));
      if (!has) {
        const contentType = file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
        await db.insert(teacherPhotos).values({ teacherId: t.id, contentType, data: readFileSync(file), updatedAt: now });
        photos++;
      }
    }
  }
  return { profiles, photos };
}
