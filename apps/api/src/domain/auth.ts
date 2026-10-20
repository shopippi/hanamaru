import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { accounts, authTokens, sessions, students } from '../db/schema.js';
import {
  hashPassword,
  newToken,
  newTotpSecret,
  sha256,
  totpStep,
  totpUri,
  verifyPassword,
} from '../lib/crypto.js';
import { DAY_MS } from '../lib/time.js';
import type { Ctx, Role } from './context.js';
import { DomainError, invalid } from './errors.js';
import { getSettings } from './settings.js';

// ログイン（3.1）

export type Account = typeof accounts.$inferSelect;
export type Session = typeof sessions.$inferSelect;

/** メールとパスワードのどちらが違うかを特定させない共通のメッセージ（AU-02） */
export const LOGIN_FAILED = 'メールアドレスまたはパスワードが正しくありません';
const LOCKED = 'ログインに続けて失敗したため、一時的にログインできません。しばらくしてからお試しください';

const unauthorized = (message: string) => new DomainError('unauthorized', message);

export const PASSWORD_MIN = 8;

export function validatePassword(password: string): void {
  if (password.length < PASSWORD_MIN) throw invalid(`パスワードは${PASSWORD_MIN}文字以上にしてください`);
  if (password.length > 200) throw invalid('パスワードが長すぎます');
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** 生徒アカウントの子どもが全員退会していればログインさせない（ST-05） */
async function allStudentsWithdrawn(db: Db, accountId: string): Promise<boolean> {
  const rows = await db.select({ status: students.status }).from(students).where(eq(students.accountId, accountId));
  return rows.length > 0 && rows.every((r) => r.status === 'withdrawn');
}

export interface LoginResult {
  token: string;
  account: Account;
  /** 管理者の二段階認証（AU-06）。setup は初回の設定が必要 */
  mfa: 'none' | 'verify' | 'setup';
  expiresAt: Date;
}

/**
 * ポータル（生徒・講師・管理）ごとのログイン。ロールが違うアカウントは同じ失敗として扱う（AU-01）。
 * 一定回数失敗すると一時的にロックする（AU-05）。
 */
export async function login(ctx: Ctx, portal: Role, email: string, password: string): Promise<LoginResult> {
  const now = ctx.now();
  const settings = await getSettings(ctx.db);
  const [account] = await ctx.db.select().from(accounts).where(eq(accounts.email, normalizeEmail(email)));
  if (!account || account.disabled || !account.passwordHash) {
    // 存在しないアカウントでも同じ時間がかかるようにハッシュを計算する
    await verifyPassword(password, DUMMY_HASH);
    throw unauthorized(LOGIN_FAILED);
  }
  if (account.role !== portal) {
    // ほかのポータルのアカウントは、失敗として数えない。公開の生徒の画面から管理者をロックさせないため（AU-01、AU-05）
    await verifyPassword(password, DUMMY_HASH);
    throw unauthorized(LOGIN_FAILED);
  }
  if (account.lockedUntil && account.lockedUntil > now) throw unauthorized(LOCKED);
  if (!(await verifyPassword(password, account.passwordHash))) {
    throw unauthorized((await countFailure(ctx, account.id, 'password')) ? LOCKED : LOGIN_FAILED);
  }
  if (account.role === 'student' && (await allStudentsWithdrawn(ctx.db, account.id))) {
    throw unauthorized('退会済みのためログインできません。教室にお問い合わせください');
  }
  await ctx.db.update(accounts).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(accounts.id, account.id));

  const mfa: LoginResult['mfa'] = account.role !== 'admin' ? 'none' : account.totpEnabled ? 'verify' : 'setup';
  const token = newToken();
  // 二段階目が済むまでの仮のログインは短くする
  const expiresAt = new Date(now.getTime() + (mfa === 'none' ? settings.sessionDays * DAY_MS : 10 * 60_000));
  await ctx.db.insert(sessions).values({ id: sha256(token), accountId: account.id, expiresAt, mfaPending: mfa !== 'none' });
  return { token, account, mfa, expiresAt };
}

/**
 * 失敗を1回数え、上限に達したら一時的にロックする（AU-05）。ロックしたら true。
 * 同時に失敗しても数え漏れがないよう、データベースの上で足す
 */
async function countFailure(ctx: Ctx, accountId: string, kind: 'password' | 'totp'): Promise<boolean> {
  const settings = await getSettings(ctx.db);
  const column = kind === 'password' ? accounts.failedLoginCount : accounts.failedTotpCount;
  const [row] = await ctx.db
    .update(accounts)
    .set(kind === 'password' ? { failedLoginCount: sql`${column} + 1` } : { failedTotpCount: sql`${column} + 1` })
    .where(eq(accounts.id, accountId))
    .returning({ failed: column });
  if (!row || row.failed < settings.maxFailedLogins) return false;
  await ctx.db
    .update(accounts)
    .set({ failedLoginCount: 0, failedTotpCount: 0, lockedUntil: new Date(ctx.now().getTime() + settings.lockMinutes * 60_000) })
    .where(eq(accounts.id, accountId));
  return true;
}

const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export interface Authenticated {
  account: Account;
  session: Session;
}

/** Cookie のトークンからログイン中のアカウントを得る。ロールがポータルと違えば null（AU-01、URL-05） */
export async function authenticate(ctx: Ctx, portal: Role, token: string | undefined): Promise<Authenticated | null> {
  if (!token) return null;
  const now = ctx.now();
  const [row] = await ctx.db
    .select()
    .from(sessions)
    .innerJoin(accounts, eq(accounts.id, sessions.accountId))
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, now)));
  if (!row || row.accounts.disabled || row.accounts.role !== portal) return null;
  if (row.accounts.role === 'student' && (await allStudentsWithdrawn(ctx.db, row.accounts.id))) return null;
  return { account: row.accounts, session: row.sessions };
}

export async function logout(ctx: Ctx, token: string): Promise<void> {
  await ctx.db.delete(sessions).where(eq(sessions.id, sha256(token)));
}

/** 二段階目を済ませたら、通常の長さのログインにする */
async function completeMfa(ctx: Ctx, session: Session): Promise<Date> {
  const settings = await getSettings(ctx.db);
  const expiresAt = new Date(ctx.now().getTime() + settings.sessionDays * DAY_MS);
  await ctx.db.update(sessions).set({ mfaPending: false, expiresAt }).where(eq(sessions.id, session.id));
  return expiresAt;
}

/** 認証アプリの登録を始める（初回） */
export async function startMfaSetup(ctx: Ctx, auth: Authenticated): Promise<{ secret: string; uri: string }> {
  if (auth.account.totpEnabled) throw invalid('二段階認証はすでに設定されています');
  const secret = newTotpSecret();
  await ctx.db.update(accounts).set({ totpSecret: secret }).where(eq(accounts.id, auth.account.id));
  return { secret, uri: totpUri(secret, auth.account.email) };
}

/**
 * 認証アプリに表示された6桁で、登録または2段階目の確認をする（AU-06）。
 * 失敗はパスワードと同じ上限でロックし、ロックしたら確認待ちのログインも切る（AU-05）。
 * 一度使ったコードは使えない
 */
export async function verifyMfa(ctx: Ctx, auth: Authenticated, code: string): Promise<Date> {
  const now = ctx.now();
  const [account] = await ctx.db.select().from(accounts).where(eq(accounts.id, auth.account.id));
  if (!account?.totpSecret) throw invalid('先に認証アプリを登録してください');
  if (account.lockedUntil && account.lockedUntil > now) throw unauthorized(LOCKED);
  const step = totpStep(account.totpSecret, code, now);
  if (step === null || (account.totpLastStep !== null && step <= account.totpLastStep)) {
    if (await countFailure(ctx, account.id, 'totp')) {
      await ctx.db.delete(sessions).where(and(eq(sessions.accountId, account.id), eq(sessions.mfaPending, true)));
      throw unauthorized(LOCKED);
    }
    throw unauthorized('確認コードが正しくありません');
  }
  // 同時に同じコードが送られても、使えるのは1回だけ
  const used = await ctx.db
    .update(accounts)
    .set({ totpLastStep: step, failedTotpCount: 0, totpEnabled: true })
    .where(and(eq(accounts.id, account.id), sql`(${accounts.totpLastStep} is null or ${accounts.totpLastStep} < ${step})`))
    .returning({ id: accounts.id });
  if (used.length === 0) throw unauthorized('確認コードが正しくありません');
  return completeMfa(ctx, auth.session);
}

// --- 招待・パスワード再設定 ------------------------------------------------------

const PORTAL_URL_KEY = { student: 'student', teacher: 'staff', admin: 'manage' } as const;

/** 招待リンク（ST-01）。リンクからパスワードを設定するとログインできる */
export async function issueInvite(ctx: Ctx, account: Account): Promise<string> {
  const settings = await getSettings(ctx.db);
  const token = newToken();
  await ctx.db.insert(authTokens).values({
    tokenHash: sha256(token),
    accountId: account.id,
    purpose: 'invite',
    expiresAt: new Date(ctx.now().getTime() + settings.inviteTokenDays * DAY_MS),
  });
  const url = `${ctx.urls[PORTAL_URL_KEY[account.role]]}/invite?token=${token}`;
  await ctx.notifier.send(
    'invite',
    { email: account.email },
    {
      subject: '【はなまる音楽教室】ご登録のご案内',
      body:
        `${account.displayName} 様\n\n` +
        `はなまる音楽教室の予約システムにご招待しました。\n次のリンクからパスワードを設定すると、ログインできます。\n\n${url}\n\n` +
        `このリンクの有効期限は${settings.inviteTokenDays}日間です。\n\n--\nはなまる音楽教室`,
    },
  );
  return token;
}

/**
 * パスワード再設定のリンクを送る（AU-03）。
 * アカウントの有無は返さない（どのメールでも同じ応答）。
 */
export async function requestPasswordReset(ctx: Ctx, portal: Role, email: string): Promise<void> {
  const settings = await getSettings(ctx.db);
  const [account] = await ctx.db.select().from(accounts).where(eq(accounts.email, normalizeEmail(email)));
  if (!account || account.disabled || account.role !== portal) return;
  const token = newToken();
  await ctx.db.insert(authTokens).values({
    tokenHash: sha256(token),
    accountId: account.id,
    purpose: 'reset',
    expiresAt: new Date(ctx.now().getTime() + settings.resetTokenMinutes * 60_000),
  });
  const url = `${ctx.urls[PORTAL_URL_KEY[account.role]]}/reset-password?token=${token}`;
  await ctx.notifier.send(
    'password_reset',
    { email: account.email },
    {
      subject: '【はなまる音楽教室】パスワードの再設定',
      body:
        `パスワードの再設定を受け付けました。\n次のリンクから新しいパスワードを設定してください。\n\n${url}\n\n` +
        `このリンクの有効期限は${settings.resetTokenMinutes}分です。お心当たりがない場合は、このメールを破棄してください。\n\n--\nはなまる音楽教室`,
    },
  );
}

/**
 * 招待・再設定のリンクでパスワードを設定する。リンクは期限切れ・使用済みなら無効（AU-03）。
 * 設定すると、それまでのログインはすべて切る。
 */
export async function setPasswordWithToken(ctx: Ctx, token: string, password: string): Promise<Account> {
  validatePassword(password);
  const now = ctx.now();
  const [row] = await ctx.db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.tokenHash, sha256(token)), isNull(authTokens.usedAt), gt(authTokens.expiresAt, now)));
  if (!row) throw invalid('このリンクは無効か、有効期限が切れています。もう一度お手続きください');
  const used = await ctx.db
    .update(authTokens)
    .set({ usedAt: now })
    .where(and(eq(authTokens.id, row.id), isNull(authTokens.usedAt)))
    .returning({ id: authTokens.id });
  if (used.length === 0) throw invalid('このリンクは無効か、有効期限が切れています。もう一度お手続きください');
  const passwordHash = await hashPassword(password);
  const [account] = await ctx.db
    .update(accounts)
    .set({ passwordHash, failedLoginCount: 0, lockedUntil: null })
    .where(eq(accounts.id, row.accountId))
    .returning();
  await ctx.db.delete(sessions).where(eq(sessions.accountId, row.accountId));
  return account!;
}

/** パスワードの変更。ほかの端末のログインと、使っていない再設定リンクは無効にする */
export async function changePassword(ctx: Ctx, auth: Authenticated, current: string, next: string): Promise<void> {
  validatePassword(next);
  if (!auth.account.passwordHash || !(await verifyPassword(current, auth.account.passwordHash))) {
    throw invalid('現在のパスワードが正しくありません');
  }
  await ctx.db.update(accounts).set({ passwordHash: await hashPassword(next) }).where(eq(accounts.id, auth.account.id));
  await ctx.db.delete(sessions).where(and(eq(sessions.accountId, auth.account.id), ne(sessions.id, auth.session.id)));
  await ctx.db
    .update(authTokens)
    .set({ usedAt: ctx.now() })
    .where(and(eq(authTokens.accountId, auth.account.id), isNull(authTokens.usedAt)));
}
