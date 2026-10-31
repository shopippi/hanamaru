import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { settings as settingsTable } from '../db/schema.js';
import { addDays, dateOf, HOUR_MS, jst } from '../lib/time.js';

// 管理者が画面から変えられる設定（3.8）。数値をコードに直接書かず、ここの既定値を初期値にする（2章の1）


export const NOTIFICATION_TYPES = [
  'reservation_confirmed',
  'reservation_changed',
  'reservation_cancelled',
  'reservation_reminder',
  'payment_succeeded',
  'payment_failed',
  'payment_link',
  'card_registration',
  'invite',
  'password_reset',
  'trial_request',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const settingsSchema = z.object({
  /** 生徒に予約を公開する期間（RS-03） */
  publishWeeks: z.number().int().min(1).max(26),
  /** 締切（何時間前まで）。予約・変更・キャンセルごと（RS-04） */
  reserveDeadlineHours: z.number().int().min(0),
  changeDeadlineHours: z.number().int().min(0),
  cancelDeadlineHours: z.number().int().min(0),
  /**
   * キャンセルの締切の決め方（RS-04）。hoursBefore は「レッスンの N 時間前まで」（cancelDeadlineHours）、
   * previousDayAt は「レッスンの前日の HH 時まで」（cancelDeadlinePrevDayHour。日本時間）
   */
  cancelDeadlineMode: z.enum(['hoursBefore', 'previousDayAt']),
  cancelDeadlinePrevDayHour: z.number().int().min(0).max(23),
  /** 即確定か、管理者の承認制か（RS-06） */
  approvalRequired: z.boolean(),
  /** 未払いの猶予期間（PY-10）。初期値7日 */
  graceDays: z.number().int().min(0).max(60),
  /** 翌月への繰越（PY-07）。false なら月末で失効 */
  carryoverEnabled: z.boolean(),
  carryoverMax: z.number().int().min(0),
  /** 自己登録（ST-02）と招待コード（ST-03） */
  selfRegistration: z.boolean(),
  inviteCodeRegistration: z.boolean(),
  /** 体験専用の枠を一般に公開する（TR-02） */
  trialPublicSlots: z.boolean(),
  /**
   * ネットで使える支払い方法（PY-04）。カードは必ず使える。コンビニ払い・PayPay は
   * Stripe の審査が通って有効にしてから ON にする（docs/stripe-prelaunch.md）。現金は教室で受け取る
   */
  konbiniEnabled: z.boolean(),
  paypayEnabled: z.boolean(),
  /** 通知の種類ごとの送る/送らない（NT-02） */
  notifications: z.record(z.enum(NOTIFICATION_TYPES), z.boolean()),
  /** ログイン状態を保つ日数（AU-04） */
  sessionDays: z.number().int().min(1).max(365),
  /** ログインの失敗回数の上限と、ロックする分数（AU-05） */
  maxFailedLogins: z.number().int().min(1),
  lockMinutes: z.number().int().min(1),
  /** パスワード再設定リンクの有効時間（AU-03）と、招待リンクの有効日数（ST-01） */
  resetTokenMinutes: z.number().int().min(5).max(24 * 60),
  inviteTokenDays: z.number().int().min(1).max(30),
  /** 前日リマインドを送る時刻（時）（NT-01） */
  reminderHour: z.number().int().min(0).max(23),
  /** レビュー1件の文字数の上限（RV-01） */
  reviewMaxLength: z.number().int().min(50).max(10000),
  /** 講師の写真の大きさの上限（KB）（TC-06）。画面で縮めてから送るので、ふつうは 100KB 前後 */
  teacherPhotoMaxKB: z.number().int().min(50).max(5000),
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingKey = keyof Settings;
export type SettingsPatch = Partial<Omit<Settings, 'notifications'>> & { notifications?: Partial<Settings['notifications']> };

/** 画面から受け取る設定の変更。通知の種類は一部だけでもよい */
export const settingsPatchSchema = settingsSchema
  .omit({ notifications: true })
  .partial()
  .extend({ notifications: z.partialRecord(z.enum(NOTIFICATION_TYPES), z.boolean()).optional() });

export const DEFAULT_SETTINGS: Settings = {
  publishWeeks: 4,
  reserveDeadlineHours: 24,
  changeDeadlineHours: 24,
  cancelDeadlineHours: 24,
  cancelDeadlineMode: 'previousDayAt',
  cancelDeadlinePrevDayHour: 20,
  approvalRequired: false,
  graceDays: 7,
  // 余った回数は翌月末まで使える（教室の決まり: キャンセル分などは翌月まで振替できる）。繰り越した分は再び繰り越さない
  carryoverEnabled: true,
  carryoverMax: 99,
  selfRegistration: false,
  inviteCodeRegistration: false,
  trialPublicSlots: false,
  konbiniEnabled: false,
  paypayEnabled: false,
  notifications: Object.fromEntries(NOTIFICATION_TYPES.map((t) => [t, true])) as Settings['notifications'],
  sessionDays: 60,
  maxFailedLogins: 5,
  lockMinutes: 15,
  resetTokenMinutes: 60,
  inviteTokenDays: 7,
  reminderHour: 9,
  reviewMaxLength: 1000,
  teacherPhotoMaxKB: 800,
};

export async function getSettings(db: Db): Promise<Settings> {
  const rows = await db.select().from(settingsTable);
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (r.key in DEFAULT_SETTINGS) merged[r.key] = r.value;
  }
  if (merged.notifications) {
    merged.notifications = { ...DEFAULT_SETTINGS.notifications, ...(merged.notifications as object) };
  }
  return settingsSchema.parse(merged);
}

/** 設定を部分的に更新する。検証に通らない値は例外 */
export async function updateSettings(db: Db, patch: SettingsPatch, actorAccountId: string | null): Promise<Settings> {
  const current = await getSettings(db);
  const merged = { ...current, ...patch };
  // 通知の種類は、指定したものだけを変える
  if (patch.notifications) merged.notifications = { ...current.notifications, ...patch.notifications };
  const next = settingsSchema.parse(merged);
  for (const key of Object.keys(patch) as SettingKey[]) {
    const value = next[key];
    await db
      .insert(settingsTable)
      .values({ key, value, updatedBy: actorAccountId })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedBy: actorAccountId, updatedAt: new Date() } });
  }
  return next;
}

export async function getSetting<K extends SettingKey>(db: Db, key: K): Promise<Settings[K]> {
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, key));
  if (!row) return DEFAULT_SETTINGS[key];
  return settingsSchema.shape[key].parse(row.value) as Settings[K];
}

/** いま選べる支払い方法（設定で止めているものは除く）。現金は教室で受け取るので、ネットの支払いには使わない */
export function enabledBillingMethods(settings: Settings): ('card' | 'konbini' | 'paypay' | 'cash')[] {
  return ['card', ...(settings.konbiniEnabled ? (['konbini'] as const) : []), ...(settings.paypayEnabled ? (['paypay'] as const) : []), 'cash'];
}

/**
 * キャンセルの締切（RS-04）。これより後のキャンセルは回数が戻らない。
 * previousDayAt は、レッスンの日（日本時間）の前の日の HH:00（日本時間）
 */
export function cancelDeadlineOf(settings: Settings, startsAt: Date): Date {
  if (settings.cancelDeadlineMode === 'previousDayAt') {
    const hour = String(settings.cancelDeadlinePrevDayHour).padStart(2, '0');
    return jst(addDays(dateOf(startsAt), -1), `${hour}:00`);
  }
  return new Date(startsAt.getTime() - settings.cancelDeadlineHours * HOUR_MS);
}

/** 画面やメールに出すキャンセルの締切の言い方（「レッスンの前日20時まで」など） */
export function cancelDeadlineLabel(settings: Settings): string {
  return settings.cancelDeadlineMode === 'previousDayAt'
    ? `レッスンの前日${settings.cancelDeadlinePrevDayHour}時まで`
    : `レッスンの${settings.cancelDeadlineHours}時間前まで`;
}
