import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { lessonTypes, rooms } from '../db/schema.js';
import { assertAdmin } from './access.js';
import { audit } from './audit.js';
import type { Actor, Ctx } from './context.js';
import { invalid, notFound } from './errors.js';

// 教室（部屋）とレッスン種別（3.8 の「体制」「レッスン」）

export const lessonTypeInput = z
  .object({
    name: z.string().trim().min(1, '名前を入力してください').max(50),
    kind: z.enum(['private', 'group']),
    durationMinutes: z.number().int().min(15).max(240),
    capacity: z.number().int().min(1).max(50).default(1),
    active: z.boolean().default(true),
  })
  .transform((t) => ({ ...t, capacity: t.kind === 'private' ? 1 : t.capacity }));

export const roomInput = z.object({
  name: z.string().trim().min(1, '名前を入力してください').max(50),
  active: z.boolean().default(true),
});

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw invalid(r.error.issues[0]?.message ?? '入力に誤りがあります', r.error.issues);
  return r.data;
}

export function listLessonTypes(ctx: Ctx) {
  return ctx.db.select().from(lessonTypes).orderBy(asc(lessonTypes.durationMinutes), asc(lessonTypes.name));
}

export async function saveLessonType(ctx: Ctx, actor: Actor, id: string | null, raw: unknown) {
  assertAdmin(actor);
  const input = parse(lessonTypeInput, raw);
  const [row] = id
    ? await ctx.db.update(lessonTypes).set(input).where(eq(lessonTypes.id, id)).returning()
    : await ctx.db.insert(lessonTypes).values(input).returning();
  if (!row) throw notFound();
  await audit(ctx.db, actor, id ? 'lesson_type.update' : 'lesson_type.create', 'lesson_type', row.id, input);
  return row;
}

export function listRooms(ctx: Ctx) {
  return ctx.db.select().from(rooms).orderBy(asc(rooms.name));
}

export async function saveRoom(ctx: Ctx, actor: Actor, id: string | null, raw: unknown) {
  assertAdmin(actor);
  const input = parse(roomInput, raw);
  const [row] = id
    ? await ctx.db.update(rooms).set(input).where(eq(rooms.id, id)).returning()
    : await ctx.db.insert(rooms).values(input).returning();
  if (!row) throw notFound();
  await audit(ctx.db, actor, id ? 'room.update' : 'room.create', 'room', row.id, input);
  return row;
}
