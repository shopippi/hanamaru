import { and, eq, gte, isNull, lt } from 'drizzle-orm';
import { lessonTypes, reservations, teachers } from '../db/schema.js';
import { addDays, addMonths, dateOf, jst, jstParts, monthOf } from '../lib/time.js';
import { loadStudent, recipientOfStudent } from './access.js';
import { applyPriceChanges, expireUnpaid, prepareMonth, reconcilePayments } from './billing.js';
import type { Ctx } from './context.js';
import { closeMonth } from './credits.js';
import { messages } from './messages.js';
import { applyScheduledStatuses } from './people.js';
import { getSettings } from './settings.js';

// 定期処理。どれも何度実行しても結果が同じになるように作り、数分おきに全部を流す。
// （月の切り替わりの瞬間にサーバーが止まっていても、次に動いたときに追いつく）

/** 前日リマインド（NT-01）。設定の時刻を過ぎたら、翌日のレッスンに1回だけ送る */
export async function sendReminders(ctx: Ctx): Promise<number> {
  const now = ctx.now();
  const settings = await getSettings(ctx.db);
  if (jstParts(now).hour < settings.reminderHour) return 0;
  const tomorrow = addDays(dateOf(now), 1);
  const due = await ctx.db
    .select({ r: reservations, teacherName: teachers.name, lessonTypeName: lessonTypes.name })
    .from(reservations)
    .innerJoin(teachers, eq(teachers.id, reservations.teacherId))
    .innerJoin(lessonTypes, eq(lessonTypes.id, reservations.lessonTypeId))
    .where(
      and(
        eq(reservations.status, 'confirmed'),
        isNull(reservations.reminderSentAt),
        gte(reservations.startsAt, jst(tomorrow)),
        lt(reservations.startsAt, jst(addDays(tomorrow, 1))),
      ),
    );
  let sent = 0;
  for (const { r, teacherName } of due) {
    if (!r.studentId) continue;
    // 先に印を付けてから送る（送信が重なっても二重に送らない）
    const marked = await ctx.db
      .update(reservations)
      .set({ reminderSentAt: now })
      .where(and(eq(reservations.id, r.id), isNull(reservations.reminderSentAt)))
      .returning({ id: reservations.id });
    if (marked.length === 0) continue;
    const s = await loadStudent(ctx.db, r.studentId);
    await ctx.notifier.send(
      'reservation_reminder',
      await recipientOfStudent(ctx.db, s),
      messages.reservationReminder({ studentName: s.name, teacherName, startsAt: r.startsAt }),
    );
    sent++;
  }
  return sent;
}

export interface JobReport {
  name: string;
  result?: unknown;
  error?: string;
}

/** すべての定期処理を順に実行する。1つが失敗しても残りは続ける */
export async function runJobs(ctx: Ctx): Promise<JobReport[]> {
  const month = monthOf(ctx.now());
  const jobs: [string, () => Promise<unknown>][] = [
    // 退会・休会の反映（ST-05）を先に行い、月額の請求の対象から外す
    ['applyScheduledStatuses', () => applyScheduledStatuses(ctx)],
    // 前月の余った回数の失効と繰越（PY-07）
    ['closeMonth', () => closeMonth(ctx, addMonths(month, -1))],
    // 料金改定の反映（PY-14）
    ['applyPriceChanges', () => applyPriceChanges(ctx)],
    // 今月の月額の請求と、コンビニ・PayPay の支払いリンク（PY-09、PY-16）
    ['prepareMonth', () => prepareMonth(ctx, month)],
    // 未払いで猶予期間を過ぎた月の予約の取消（3.4、PY-10）
    ['expireUnpaid', () => expireUnpaid(ctx)],
    // 届かなかった Stripe の通知の照合（OP-02）
    ['reconcilePayments', () => reconcilePayments(ctx)],
    // 前日リマインド（NT-01）
    ['sendReminders', () => sendReminders(ctx)],
  ];
  const reports: JobReport[] = [];
  for (const [name, run] of jobs) {
    try {
      reports.push({ name, result: await run() });
    } catch (e) {
      console.error(`job ${name} failed`, e);
      reports.push({ name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return reports;
}
