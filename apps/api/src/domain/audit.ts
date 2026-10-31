import { desc, eq, and, inArray } from 'drizzle-orm';
import { accounts, auditLogs, students, teachers } from '../db/schema.js';
import type { Db } from '../db/client.js';
import { assertAdmin } from './access.js';
import { actorId, type Actor, type Ctx } from './context.js';

/** 管理者の操作記録（OP-03）。誰が・いつ・何をしたか */
export async function audit(
  db: Db,
  actor: Actor,
  action: string,
  targetType: string,
  targetId: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(auditLogs).values({ actorAccountId: actorId(actor), action, targetType, targetId, details });
}

/**
 * 操作の日本語の名前（OP-03）。audit() に新しい操作を足したら、ここにも足す
 * （test/audit.test.ts が、名前のない操作を見つけると失敗する）
 */
export const AUDIT_LABELS: Record<string, string> = {
  'student.create': '生徒の登録',
  'student.register': '生徒の自己登録',
  'student.update': '生徒情報の変更',
  'student.status': '状態の変更',
  'student.approve': '登録の承認',
  'student.teachers': '担当講師の変更',
  'student.note.admin': '管理用備考の変更',
  'student.note.teacher': '講師用備考の変更',
  'student.card_request': 'カード登録のお願いを送った',
  'student.terms_agreed': '契約の内容と利用規約への同意',
  'credits.adjust': '回数の手動調整',
  'payment.cash': '現金の入金記録',
  'settings.update': '設定の変更',
  'reservation.create': '代理予約',
  'reservation.cancel': '予約の取り消し',
  'reservation.approve': '仮予約の承認',
  'reservation.reject': '仮予約の却下',
  'reservation.attendance': '出欠の記録',
  'reservation.series.create': '繰り返し予約',
  'availability.change': '空き時間の変更',
  'school_hours.set': '受付日の変更',
  'closure.create': '休講',
  'closure.delete': '休講の取り消し',
  'course.create': 'コースの登録',
  'course.update': 'コースの変更',
  'course.price': '料金の改定',
  'course.price.apply': '料金の改定の反映',
  'package.create': '入会セットの登録',
  'package.update': '入会セットの変更',
  'lesson_type.create': 'レッスン種別の登録',
  'lesson_type.update': 'レッスン種別の変更',
  'room.create': '教室（部屋）の登録',
  'room.update': '教室（部屋）の変更',
  'charge.create': '単発の請求',
  'teacher.create': '講師の登録',
  'teacher.activate': '講師の再開',
  'teacher.deactivate': '講師の停止',
  'teacher.profile': '講師のプロフィールの変更',
  'teacher.photo': '講師の写真の変更',
  'teacher.photo_delete': '講師の写真の削除',
  'invite_code.create': '招待コードの作成',
  'invite_code.deactivate': '招待コードの停止',
  'trial.status': '体験の申込の状態の変更',
  'trial.book': '体験レッスンの予約',
  'notification.resend': '通知の再送',
  'notification.dismiss': '通知を送らないことにした',
};

const STATUS: Record<string, string> = { trial: '体験', enrolling: '入会手続き中', active: '在籍中', suspended: '休会', withdrawn: '退会' };
const METHOD: Record<string, string> = { card: 'カード', konbini: 'コンビニ', paypay: 'PayPay', cash: '現金' };
const ATTENDANCE: Record<string, string> = { scheduled: '予定', attended: '出席', no_show: '無断欠席' };
const TRIAL_STATUS: Record<string, string> = { new: '新規', contacted: '連絡済み', booked: '日時確定', done: '受講済み', cancelled: '取りやめ' };

const yen = (n: unknown) => (typeof n === 'number' ? `${n.toLocaleString('ja-JP')}円` : '');
const monthLabel = (m: unknown) => (typeof m === 'string' && /^\d{4}-\d{2}$/.test(m) ? `${Number(m.slice(0, 4))}年${Number(m.slice(5))}月` : '');
const dateLabel = (d: unknown) => {
  if (typeof d !== 'string') return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return '';
  // 時刻つき（ISO）なら日本時間の日付にする
  const j = d.length > 10 ? new Date(new Date(d).getTime() + 9 * 3600_000) : null;
  return j ? `${j.getUTCMonth() + 1}月${j.getUTCDate()}日 ${String(j.getUTCHours()).padStart(2, '0')}:${String(j.getUTCMinutes()).padStart(2, '0')}` : `${Number(m[2])}月${Number(m[3])}日`;
};
const cancelled = (d: Record<string, unknown>) =>
  Array.isArray(d.cancelled) && d.cancelled.length ? `予約${d.cancelled.length}件を取り消し` : '';

/** 変えた項目の名前（生徒情報・設定など） */
const FIELD: Record<string, string> = {
  name: '名前',
  guardianName: '保護者の名前',
  phone: '電話番号',
  email: 'メール',
  address: '住所',
  courseId: 'コース',
  billingMethod: '支払い方法',
  lineUserId: 'LINE',
  instruments: '担当の楽器',
};

/** 操作の内容を、管理者が読める短い文にする。ID や内部の名前は出さない */
export function summarize(action: string, d: Record<string, unknown>): string {
  const parts: string[] = [];
  const add = (s: string) => s && parts.push(s);
  switch (action) {
    case 'credits.adjust':
      add(monthLabel(d.month));
      add(typeof d.delta === 'number' ? `${d.delta > 0 ? '+' : ''}${d.delta}回` : '');
      add(typeof d.note === 'string' ? `理由: ${d.note}` : '');
      break;
    case 'student.status':
      add(`${STATUS[String(d.from)] ?? ''} → ${STATUS[String(d.to)] ?? ''}`.trim());
      add(d.reason === 'enrollment_paid' ? '入会の支払いを確認' : '');
      add(typeof d.effectiveAt === 'string' && d.effectiveAt !== 'now' ? `${dateLabel(d.effectiveAt).split(' ')[0]}から` : '');
      add(cancelled(d));
      break;
    case 'payment.cash':
      add(monthLabel(d.month) ? `${monthLabel(d.month)}分` : d.kind === 'enrollment' ? '入会' : d.chargeItemId ? '単発の請求' : '');
      add(yen(d.amount));
      break;
    case 'student.update':
    case 'teacher.profile':
    case 'course.update':
    case 'package.update':
    case 'lesson_type.update':
    case 'room.update': {
      const fields = Object.keys(d).map((k) => FIELD[k]).filter(Boolean);
      add(fields.length ? `変更: ${[...new Set(fields)].join('・')}` : '');
      add(typeof d.billingMethod === 'string' ? `支払い方法: ${METHOD[d.billingMethod] ?? ''}` : '');
      break;
    }
    case 'student.create':
    case 'teacher.create':
    case 'course.create':
    case 'package.create':
    case 'lesson_type.create':
    case 'room.create':
      add(typeof d.name === 'string' ? d.name : '');
      add(typeof d.amount === 'number' ? yen(d.amount) : '');
      add(typeof d.lessonsPerMonth === 'number' ? `月${d.lessonsPerMonth}回` : '');
      break;
    case 'course.price':
      add(yen(d.amount));
      add(monthLabel(d.effectiveMonth) ? `${monthLabel(d.effectiveMonth)}から` : '');
      break;
    case 'course.price.apply':
      add(typeof d.students === 'number' ? `${d.students}人に反映` : '');
      break;
    case 'student.terms_agreed':
      add(typeof d.method === 'string' ? `支払い方法: ${METHOD[d.method] ?? ''}` : '');
      break;
    case 'student.register':
      add(d.viaInviteCode ? '招待コードで登録' : '承認待ちで登録');
      break;
    case 'student.teachers':
      add(Array.isArray(d.teacherIds) ? `担当講師 ${d.teacherIds.length}人` : '');
      break;
    case 'reservation.create':
      add(dateLabel(d.startsAt));
      break;
    case 'reservation.cancel':
      add(d.refund === true ? '回数を戻した' : d.refund === false ? '回数は戻さない' : '');
      break;
    case 'reservation.attendance':
      add(ATTENDANCE[String(d.attendance)] ?? '');
      break;
    case 'reservation.series.create':
      add(typeof d.created === 'number' ? `${d.created}回分` : '');
      break;
    case 'school_hours.set':
      add(Array.isArray(d.dates) ? `${d.dates.length}日分（${d.dates.slice(0, 3).map(dateLabel).join('、')}${d.dates.length > 3 ? ' ほか' : ''}）` : '');
      add(Array.isArray(d.windows) ? (d.windows.length ? d.windows.map((w: { startTime?: string; endTime?: string }) => `${w.startTime}〜${w.endTime}`).join('、') : '休み') : '');
      add(cancelled(d));
      break;
    case 'availability.change':
      add(cancelled(d));
      break;
    case 'closure.create':
      add(dateLabel(d.date));
      add(typeof d.reason === 'string' ? d.reason : '');
      add(cancelled(d));
      break;
    case 'charge.create':
      add(typeof d.title === 'string' ? d.title : '');
      add(yen(d.amount));
      break;
    case 'settings.update': {
      const n = Object.keys(d).length;
      add(n ? `${n}項目` : '');
      break;
    }
    case 'trial.status':
      add(TRIAL_STATUS[String(d.status)] ?? '');
      break;
    case 'notification.resend':
      add(d.ok === true ? '送れました' : d.ok === false ? '送れませんでした' : '');
      break;
  }
  return parts.join('・');
}

/** 操作記録の一覧（OP-03）。最新500件。操作した人と対象の名前を付け、内容を日本語にする */
export async function auditLogsForAdmin(ctx: Ctx, actor: Actor, filter: { targetType?: string; targetId?: string }) {
  assertAdmin(actor);
  const conds = [];
  if (filter.targetType) conds.push(eq(auditLogs.targetType, filter.targetType));
  if (filter.targetId) conds.push(eq(auditLogs.targetId, filter.targetId));
  const rows = await ctx.db
    .select({ log: auditLogs, actorName: accounts.displayName })
    .from(auditLogs)
    .leftJoin(accounts, eq(accounts.id, auditLogs.actorAccountId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(auditLogs.createdAt))
    .limit(500);
  // 対象の名前は、生徒・講師のものだけをまとめて引く（1件ずつ問い合わせない）
  const idsOf = (type: string) => [...new Set(rows.filter((r) => r.log.targetType === type && r.log.targetId).map((r) => r.log.targetId!))];
  const studentIds = idsOf('student');
  const teacherIds = idsOf('teacher');
  const names = new Map<string, string>();
  if (studentIds.length) {
    for (const s of await ctx.db.select({ id: students.id, name: students.name }).from(students).where(inArray(students.id, studentIds))) names.set(s.id, s.name);
  }
  if (teacherIds.length) {
    for (const t of await ctx.db.select({ id: teachers.id, name: teachers.name }).from(teachers).where(inArray(teachers.id, teacherIds))) names.set(t.id, t.name);
  }
  return rows.map(({ log, actorName }) => {
    const details = (log.details ?? {}) as Record<string, unknown>;
    return {
      id: log.id,
      createdAt: log.createdAt,
      action: log.action,
      label: AUDIT_LABELS[log.action] ?? 'その他の操作',
      actorName: log.actorAccountId ? (actorName ?? '（削除されたアカウント）') : '自動処理',
      byAdmin: !!log.actorAccountId,
      targetName: log.targetId ? (names.get(log.targetId) ?? null) : null,
      summary: summarize(log.action, details),
    };
  });
}
