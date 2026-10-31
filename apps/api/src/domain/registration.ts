import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { accounts, inviteCodes, students, teachers } from '../db/schema.js';
import { hashPassword, newToken } from '../lib/crypto.js';
import { DAY_MS } from '../lib/time.js';
import { assertAdmin, assignedTeacherIds, studentForActor } from './access.js';
import { audit } from './audit.js';
import { normalizeEmail, validatePassword } from './auth.js';
import type { Actor, Ctx } from './context.js';
import { conflict, invalid, notFound } from './errors.js';
import { getSettings } from './settings.js';

// 自己登録と招待コード（ST-02、ST-03）。講師プロフィール（TC-05〜07）は teacher-profiles.ts

export const registrationInput = z.object({
  email: z.string().trim().email('メールアドレスの形式が正しくありません').transform(normalizeEmail),
  password: z.string(),
  guardianName: z.string().trim().max(100).nullish(),
  studentName: z.string().trim().min(1, '生徒の名前を入力してください').max(100),
  phone: z.string().trim().min(1, '電話番号を入力してください').max(30),
  inviteCode: z.string().trim().max(50).nullish(),
});

/** 登録画面を出すか（ST-02: OFFのときは登録画面を表示しない） */
export async function registrationOptions(ctx: Ctx) {
  const s = await getSettings(ctx.db);
  return {
    enabled: s.selfRegistration || s.inviteCodeRegistration,
    inviteCodeRequired: !s.selfRegistration && s.inviteCodeRegistration,
  };
}

/**
 * 自己登録。登録直後は承認待ち（approved=false）で予約できない。
 * 招待コードを使う場合は、有効なコードでなければ拒否する（ST-03）。
 */
export async function register(ctx: Ctx, raw: unknown) {
  const parsed = registrationInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? '入力に誤りがあります', parsed.error.issues);
  const input = parsed.data;
  const settings = await getSettings(ctx.db);
  const useCode = !!input.inviteCode;
  if (useCode ? !settings.inviteCodeRegistration : !settings.selfRegistration) {
    if (settings.inviteCodeRegistration && !useCode) throw invalid('招待コードを入力してください');
    throw notFound('登録の受付はしていません');
  }
  validatePassword(input.password);
  const passwordHash = await hashPassword(input.password);
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    if (useCode) {
      const used = await tx
        .update(inviteCodes)
        .set({ usedCount: sql`${inviteCodes.usedCount} + 1` })
        .where(
          and(
            eq(inviteCodes.code, input.inviteCode!.toUpperCase()),
            eq(inviteCodes.active, true),
            sql`(${inviteCodes.expiresAt} is null or ${inviteCodes.expiresAt} > ${now})`,
            sql`(${inviteCodes.maxUses} is null or ${inviteCodes.usedCount} < ${inviteCodes.maxUses})`,
          ),
        )
        .returning({ id: inviteCodes.id });
      if (used.length === 0) throw invalid('招待コードが正しくないか、有効期限が切れています');
    }
    const [exists] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, input.email));
    if (exists) throw conflict('このメールアドレスは登録済みです。ログインするか、パスワードを再設定してください');
    const [account] = await tx
      .insert(accounts)
      .values({ email: input.email, role: 'student', displayName: input.guardianName || input.studentName, passwordHash })
      .returning();
    const [student] = await tx
      .insert(students)
      .values({
        accountId: account!.id,
        name: input.studentName,
        guardianName: input.guardianName ?? null,
        phone: input.phone,
        status: 'enrolling',
        approved: false,
      })
      .returning();
    await audit(tx, { kind: 'system' }, 'student.register', 'student', student!.id, { viaInviteCode: useCode });
    return { accountId: account!.id, studentId: student!.id };
  });
}

/** 招待コードを作る（ST-03）。紛らわしい文字（0/O、1/I）は使わない */
export async function createInviteCode(ctx: Ctx, actor: Actor, opts: { validDays?: number; maxUses?: number | null }) {
  assertAdmin(actor);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = Buffer.from(newToken(16), 'base64url');
  const code = Array.from(bytes.subarray(0, 8), (b) => alphabet[b % alphabet.length]).join('');
  const [row] = await ctx.db
    .insert(inviteCodes)
    .values({
      code,
      expiresAt: opts.validDays ? new Date(ctx.now().getTime() + opts.validDays * DAY_MS) : null,
      maxUses: opts.maxUses ?? null,
      createdBy: actor.kind === 'account' ? actor.accountId : null,
    })
    .returning();
  await audit(ctx.db, actor, 'invite_code.create', 'invite_code', row!.id, { code, ...opts });
  return row!;
}

export async function deactivateInviteCode(ctx: Ctx, actor: Actor, id: string) {
  assertAdmin(actor);
  await ctx.db.update(inviteCodes).set({ active: false }).where(eq(inviteCodes.id, id));
  await audit(ctx.db, actor, 'invite_code.deactivate', 'invite_code', id);
}

export async function listInviteCodes(ctx: Ctx, actor: Actor) {
  assertAdmin(actor);
  return ctx.db.select().from(inviteCodes).orderBy(inviteCodes.createdAt);
}
