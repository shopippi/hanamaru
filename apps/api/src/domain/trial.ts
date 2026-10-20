import { asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { lessonTypes, reservations, rooms, teachers, trialRequests } from '../db/schema.js';
import { DAY_MS, dateOf, formatJa, HOUR_MS, monthOf } from '../lib/time.js';
import { adminRecipients, assertAdmin } from './access.js';
import { audit } from './audit.js';
import { listSlots, type Slot } from './availability.js';
import { actorId, SYSTEM, type Actor, type Ctx } from './context.js';
import { conflict, invalid, notFound, ruleViolation } from './errors.js';
import type { Message } from './notify.js';
import { getSettings } from './settings.js';

// 体験レッスン（3.7）
// TR-01: フォームで申込を受け、管理者が枠を押さえて連絡する
// TR-02: 体験専用の枠を一般に公開する（設定でON/OFF）。通常の枠は生徒にしか見せない

const SIGNATURE = '\n\n--\nはなまる音楽教室';

export const trialInput = z.object({
  name: z.string().trim().min(1, 'お名前を入力してください').max(100),
  guardianName: z.string().trim().max(100).nullish(),
  email: z.string().trim().email('メールアドレスの形式が正しくありません').max(200),
  phone: z.string().trim().max(30).nullish(),
  instrument: z.string().trim().max(50).nullish(),
  preferredTimes: z.string().trim().max(1000).default(''),
  message: z.string().trim().max(2000).default(''),
});

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw invalid(r.error.issues[0]?.message ?? '入力に誤りがあります', r.error.issues);
  return r.data;
}

async function notifyAdmins(ctx: Ctx, message: Message) {
  for (const to of await adminRecipients(ctx.db)) await ctx.notifier.send('trial_request', to, message);
}

/** 体験の申込を受け付け、管理者に知らせる（TR-01） */
export async function submitTrialRequest(ctx: Ctx, raw: unknown) {
  const input = parse(trialInput, raw);
  const [row] = await ctx.db
    .insert(trialRequests)
    .values({ ...input, guardianName: input.guardianName ?? null, phone: input.phone ?? null, instrument: input.instrument ?? null, createdAt: ctx.now() })
    .returning();
  await notifyAdmins(ctx, {
    subject: '【体験レッスン】新しい申込がありました',
    body:
      `お名前: ${input.name}\n保護者: ${input.guardianName ?? '-'}\nメール: ${input.email}\n電話: ${input.phone ?? '-'}\n` +
      `楽器: ${input.instrument ?? '-'}\n希望日時: ${input.preferredTimes || '-'}\n\n${input.message}\n\n管理画面から枠を押さえてご連絡ください。`,
  });
  await ctx.notifier.send(
    'trial_request',
    { email: input.email },
    {
      subject: '【はなまる音楽教室】体験レッスンのお申込を受け付けました',
      body: `${input.name} 様\n\n体験レッスンのお申込ありがとうございます。日時を調整のうえ、教室からご連絡します。` + SIGNATURE,
    },
  );
  return { id: row!.id };
}

export async function listTrialRequests(ctx: Ctx, actor: Actor) {
  assertAdmin(actor);
  return ctx.db.select().from(trialRequests).orderBy(desc(trialRequests.createdAt));
}

export async function setTrialStatus(ctx: Ctx, actor: Actor, id: string, status: 'new' | 'scheduled' | 'done' | 'cancelled') {
  assertAdmin(actor);
  const [row] = await ctx.db.update(trialRequests).set({ status }).where(eq(trialRequests.id, id)).returning();
  if (!row) throw notFound();
  await audit(ctx.db, actor, 'trial.status', 'trial_request', id, { status });
}

async function insertTrialReservation(db: Db, requestId: string, slot: Slot, actor: Actor) {
  const [r] = await db
    .insert(reservations)
    .values({
      trialRequestId: requestId,
      teacherId: slot.teacherId,
      lessonTypeId: slot.lessonTypeId,
      roomId: slot.roomId,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      lessonMonth: monthOf(slot.startsAt),
      status: 'confirmed',
      createdBy: actorId(actor),
    })
    .returning();
  await db.update(trialRequests).set({ status: 'scheduled' }).where(eq(trialRequests.id, requestId));
  return r!;
}

async function findSlot(db: Db, input: { teacherId: string; lessonTypeId: string; startsAt: Date }, forTrial?: boolean) {
  const date = dateOf(input.startsAt);
  const slots = await listSlots(db, { teacherIds: [input.teacherId], from: date, to: date, ...(forTrial === undefined ? {} : { forTrial }) });
  return (
    slots.find(
      (s) => s.lessonTypeId === input.lessonTypeId && s.startsAt.getTime() === input.startsAt.getTime() && s.booked < s.capacity,
    ) ?? null
  );
}

async function confirmationMail(db: Db, slot: { teacherId: string; startsAt: Date }, name: string): Promise<Message> {
  const [t] = await db.select({ name: teachers.name }).from(teachers).where(eq(teachers.id, slot.teacherId));
  return {
    subject: '【はなまる音楽教室】体験レッスンのご予約が確定しました',
    body: `${name} 様\n\n体験レッスンのご予約が確定しました。\n\n日時: ${formatJa(slot.startsAt)}\n講師: ${t?.name ?? ''}\n\n当日お待ちしています。` + SIGNATURE,
  };
}

/** 管理者が申込に対して枠を押さえる（TR-01 の代理予約）。体験では回数を使わない */
export async function bookTrialAsAdmin(
  ctx: Ctx,
  actor: Actor,
  requestId: string,
  input: { teacherId: string; lessonTypeId: string; startsAt: Date },
) {
  assertAdmin(actor);
  const [req] = await ctx.db.select().from(trialRequests).where(eq(trialRequests.id, requestId));
  if (!req) throw notFound('申込が見つかりません');
  if (req.status === 'cancelled') throw conflict('取り消された申込です');
  const r = await ctx.db.transaction(async (tx) => {
    const slot = await findSlot(tx, input);
    if (!slot) throw ruleViolation('この枠は予約できません（空き時間外か、埋まっています）');
    await tx.select({ id: teachers.id }).from(teachers).where(eq(teachers.id, slot.teacherId)).for('update');
    if (slot.roomId) await tx.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, slot.roomId)).for('update');
    const again = await findSlot(tx, input);
    if (!again) throw ruleViolation('この枠は先に予約されました');
    const created = await insertTrialReservation(tx, req.id, again, actor);
    await audit(tx, actor, 'trial.book', 'trial_request', req.id, { reservationId: created.id });
    return created;
  });
  await ctx.notifier.send('reservation_confirmed', { email: req.email }, await confirmationMail(ctx.db, r, req.name));
  return r;
}

// --- 体験専用の枠の一般公開（TR-02） ---------------------------------------------------

async function assertPublicTrialOn(ctx: Ctx) {
  const s = await getSettings(ctx.db);
  if (!s.trialPublicSlots) throw notFound('体験レッスンの予約は受け付けていません');
  return s;
}

/** 誰でも見られる体験専用の枠。通常の枠は出さない */
export async function publicTrialSlots(ctx: Ctx) {
  const settings = await assertPublicTrialOn(ctx);
  const now = ctx.now();
  const earliest = new Date(now.getTime() + settings.reserveDeadlineHours * HOUR_MS);
  const latest = new Date(now.getTime() + settings.publishWeeks * 7 * DAY_MS);
  const active = await ctx.db.select().from(teachers).where(eq(teachers.active, true)).orderBy(asc(teachers.name));
  const types = new Map((await ctx.db.select().from(lessonTypes)).map((t) => [t.id, t.name]));
  const slots = await listSlots(ctx.db, { teacherIds: active.map((t) => t.id), from: dateOf(now), to: dateOf(latest), forTrial: true });
  const names = new Map(active.map((t) => [t.id, t.name]));
  return slots
    .filter((s) => s.booked < s.capacity && s.startsAt >= earliest && s.startsAt <= latest)
    .map((s) => ({
      teacherId: s.teacherId,
      teacherName: names.get(s.teacherId) ?? '',
      lessonTypeId: s.lessonTypeId,
      lessonTypeName: types.get(s.lessonTypeId) ?? '',
      startsAt: s.startsAt,
      endsAt: s.endsAt,
    }));
}

/** 体験専用の枠を一般の人が予約する（TR-02）。申込と予約を同時に作る */
export async function bookPublicTrial(
  ctx: Ctx,
  raw: unknown,
  slotInput: { teacherId: string; lessonTypeId: string; startsAt: Date },
) {
  const settings = await assertPublicTrialOn(ctx);
  const input = parse(trialInput, raw);
  const now = ctx.now();
  if (slotInput.startsAt.getTime() - now.getTime() < settings.reserveDeadlineHours * HOUR_MS) {
    throw ruleViolation('予約の締切を過ぎています');
  }
  if (slotInput.startsAt.getTime() > now.getTime() + settings.publishWeeks * 7 * DAY_MS) {
    throw ruleViolation('まだ予約を受け付けていない日です');
  }
  const r = await ctx.db.transaction(async (tx) => {
    const slot = await findSlot(tx, slotInput, true);
    if (!slot) throw ruleViolation('この枠は予約できません。ほかの時間を選んでください');
    await tx.select({ id: teachers.id }).from(teachers).where(eq(teachers.id, slot.teacherId)).for('update');
    // 同じ部屋を使う別の講師の予約とも順番に処理する
    if (slot.roomId) await tx.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, slot.roomId)).for('update');
    const again = await findSlot(tx, slotInput, true);
    if (!again) throw ruleViolation('この枠は先に予約されました。ほかの時間を選んでください');
    const [req] = await tx
      .insert(trialRequests)
      .values({ ...input, guardianName: input.guardianName ?? null, phone: input.phone ?? null, instrument: input.instrument ?? null, createdAt: now })
      .returning();
    const created = await insertTrialReservation(tx, req!.id, again, SYSTEM);
    return { reservation: created, request: req! };
  });
  await ctx.notifier.send('reservation_confirmed', { email: input.email }, await confirmationMail(ctx.db, r.reservation, input.name));
  await notifyAdmins(ctx, {
    subject: '【体験レッスン】体験枠に予約が入りました',
    body: `お名前: ${input.name}\nメール: ${input.email}\n電話: ${input.phone ?? '-'}\n日時: ${formatJa(r.reservation.startsAt)}\n\n${input.message}`,
  });
  return { reservationId: r.reservation.id };
}
