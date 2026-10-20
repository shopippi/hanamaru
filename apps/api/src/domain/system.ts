import { readFile, stat } from 'node:fs/promises';
import { and, count, desc, eq, inArray, isNotNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS_DIR, type Db } from '../db/client.js';
import { authTokens, jobRuns, notifications, sessions, stripeEvents } from '../db/schema.js';
import { formatJa, HOUR_MS } from '../lib/time.js';
import { adminRecipients, assertAdmin } from './access.js';
import { audit } from './audit.js';
import type { Actor, Ctx } from './context.js';
import { conflict, notFound, ruleViolation } from './errors.js';
import { isRedacted } from './notify.js';
import { getSettings } from './settings.js';

// 開発者の手を借りずに運用を続けるための仕組み（OP-05〜OP-08）。
// 定期処理と Stripe の通知の受け取りの成否を記録し、失敗が続いたら管理者にメールで知らせる。
// 送れなかった通知は自動で送り直し、古い記録は片付ける。管理画面の「システムの状態」で一覧できる。

/** 定期処理の名前と、画面に出す呼び名 */
export const JOB_LABELS: Record<string, string> = {
  applyScheduledStatuses: '退会・休会の反映',
  closeMonth: '回数の失効と繰り越し',
  applyPriceChanges: '料金改定の反映',
  prepareMonth: '月謝の請求',
  expireUnpaid: '未払いの予約の取り消し',
  reconcilePayments: '決済の照合',
  sendReminders: '前日のリマインド',
  retryNotifications: '通知の送り直し',
  cleanup: '古い記録の片付け',
  stripeWebhook: 'Stripe の通知の受け取り',
};

const label = (name: string) => JOB_LABELS[name] ?? name;

async function alertAdmins(ctx: Ctx, subject: string, body: string): Promise<void> {
  // 知らせのメールが送れなくても、元の処理には影響させない
  try {
    for (const to of await adminRecipients(ctx.db)) {
      await ctx.notifier.send('system_alert', to, { subject, body });
    }
  } catch (e) {
    console.error('system alert failed', e);
  }
}

/**
 * 処理を1つ実行し、成否を job_runs に残す（OP-05）。
 * 失敗したら管理者に知らせる（同じ処理は設定の間隔に1回まで）。失敗のあとに成功したら「復旧しました」と知らせる。
 * 失敗は呼び出し元にそのまま投げる
 */
export async function trackedRun<T>(ctx: Ctx, name: string, run: () => Promise<T>): Promise<T> {
  const startedAt = ctx.now();
  await ctx.db
    .insert(jobRuns)
    .values({ name, lastStartedAt: startedAt })
    .onConflictDoUpdate({ target: jobRuns.name, set: { lastStartedAt: startedAt } });
  let result: T;
  try {
    result = await run();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const now = ctx.now();
    const [row] = await ctx.db
      .update(jobRuns)
      .set({ lastFailedAt: now, lastError: message.slice(0, 2000), consecutiveFailures: sql`${jobRuns.consecutiveFailures} + 1` })
      .where(eq(jobRuns.name, name))
      .returning();
    const { systemAlertIntervalHours } = await getSettings(ctx.db);
    if (row && (!row.lastAlertAt || now.getTime() - row.lastAlertAt.getTime() >= systemAlertIntervalHours * HOUR_MS)) {
      await ctx.db.update(jobRuns).set({ lastAlertAt: now }).where(eq(jobRuns.name, name));
      await alertAdmins(
        ctx,
        `【要確認】「${label(name)}」が失敗しました`,
        `システムの処理「${label(name)}」が失敗しました（${formatJa(now)}、${row.consecutiveFailures}回続けて）。\n\n` +
          `理由: ${message}\n\n` +
          `自動で何度もやり直します。直らない場合は、管理画面の「システムの状態」を開き、開発者に連絡してください。\n` +
          `${ctx.urls.manage}/system\n\n` +
          `同じ処理の失敗のお知らせは、${systemAlertIntervalHours}時間に1回までにしています。`,
      );
    }
    throw e;
  }
  const now = ctx.now();
  const [before] = await ctx.db.select().from(jobRuns).where(eq(jobRuns.name, name));
  await ctx.db
    .update(jobRuns)
    .set({ lastSucceededAt: now, consecutiveFailures: 0, lastAlertAt: null })
    .where(eq(jobRuns.name, name));
  if (before && before.consecutiveFailures > 0 && before.lastAlertAt) {
    await alertAdmins(
      ctx,
      `【復旧しました】「${label(name)}」が直りました`,
      `失敗していたシステムの処理「${label(name)}」が、${formatJa(now)}に成功しました。対応は要りません。`,
    );
  }
  return result;
}

// --- 通知の送り直し（OP-06） -----------------------------------------------------------

/** 送れなかった通知のうち、送り直す時刻を過ぎたものを送り直す。送れた件数を返す */
export async function retryNotifications(ctx: Ctx): Promise<number> {
  const due = await ctx.db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.status, 'failed'), isNotNull(notifications.nextRetryAt), lte(notifications.nextRetryAt, ctx.now())))
    .orderBy(notifications.nextRetryAt)
    .limit(100);
  let sent = 0;
  for (const { id } of due) if (await ctx.notifier.retry(id)) sent++;
  return sent;
}

async function loadFailedNotification(ctx: Ctx, id: string) {
  const [n] = await ctx.db.select().from(notifications).where(eq(notifications.id, id));
  if (!n) throw notFound('通知が見つかりません');
  if (n.status !== 'failed') throw conflict('この通知は、送れなかった通知ではありません');
  return n;
}

/** 管理者が、送れなかった通知をすぐに送り直す */
export async function resendNotification(ctx: Ctx, actor: Actor, id: string): Promise<void> {
  assertAdmin(actor);
  const n = await loadFailedNotification(ctx, id);
  if (isRedacted(n.body)) {
    throw ruleViolation(
      '招待・パスワード再設定のメールは、リンクを記録していないため送り直せません。生徒・講師の画面から招待をやり直すか、パスワード再設定をもう一度申し込んでもらってください',
    );
  }
  const ok = await ctx.notifier.retry(id);
  await audit(ctx.db, actor, 'notification.resend', 'notification', id, { ok });
  if (!ok) throw ruleViolation('送り直しましたが、まだ届けられません。時間をおいてもう一度お試しください');
}

/** 管理者が、送れなかった通知を「送らない」にして一覧から外す */
export async function dismissNotification(ctx: Ctx, actor: Actor, id: string): Promise<void> {
  assertAdmin(actor);
  await loadFailedNotification(ctx, id);
  await ctx.db.update(notifications).set({ status: 'skipped', nextRetryAt: null }).where(eq(notifications.id, id));
  await audit(ctx.db, actor, 'notification.dismiss', 'notification', id);
}

// --- 古い記録の片付け（OP-07） ----------------------------------------------------------

export const PURGED_BODY = '（保存期間を過ぎたため、本文は消しました）';

/** 何度実行しても結果は同じ。消した件数を返す */
export async function cleanup(ctx: Ctx) {
  const now = ctx.now();
  const s = await getSettings(ctx.db);
  const day = 24 * HOUR_MS;
  const expiredSessions = await ctx.db.delete(sessions).where(lt(sessions.expiresAt, now)).returning({ id: sessions.id });
  // 招待・再設定のリンクは、期限切れか使ってから1日たったら消す
  const oldTokens = await ctx.db
    .delete(authTokens)
    .where(or(lt(authTokens.expiresAt, new Date(now.getTime() - day)), lt(authTokens.usedAt, new Date(now.getTime() - day))))
    .returning({ id: authTokens.id });
  const oldEvents = await ctx.db
    .delete(stripeEvents)
    .where(lt(stripeEvents.receivedAt, new Date(now.getTime() - s.stripeEventRetentionDays * day)))
    .returning({ id: stripeEvents.id });
  // 通知は誰に何の種類を送ったかだけを残し、本文（氏名や予約の日時を含む）を消す
  const purged = await ctx.db
    .update(notifications)
    .set({ body: PURGED_BODY })
    .where(and(lt(notifications.createdAt, new Date(now.getTime() - s.notificationBodyRetentionDays * day)), ne(notifications.body, PURGED_BODY)))
    .returning({ id: notifications.id });
  return { sessions: expiredSessions.length, authTokens: oldTokens.length, stripeEvents: oldEvents.length, notificationBodies: purged.length };
}

// --- システムの状態（OP-08） ------------------------------------------------------------

type State = 'ok' | 'attention' | 'unset';

function migrationsTotal(): number {
  try {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as { entries: unknown[] };
    return journal.entries.length;
  } catch {
    return 0;
  }
}

async function migrationsApplied(db: Db): Promise<number | null> {
  try {
    const r = await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    const rows = (r as unknown as { rows: { n: number }[] }).rows;
    return Number(rows[0]?.n ?? 0);
  } catch {
    return null;
  }
}

/** バックアップが最後に成功した時刻。ファイルの中身（ISO の日時）か、なければ更新時刻 */
async function lastBackup(file: string | undefined): Promise<Date | null | undefined> {
  if (!file) return undefined;
  try {
    const text = (await readFile(file, 'utf8')).trim();
    const at = new Date(text);
    if (!Number.isNaN(at.getTime())) return at;
    return (await stat(file)).mtime;
  } catch {
    return null;
  }
}

/** 定期処理は数分おきに動く。1時間動いていなければ止まっている */
const JOB_STALE_MS = HOUR_MS;
/** バックアップは1日1回。36時間成功していなければ要確認 */
const BACKUP_STALE_MS = 36 * HOUR_MS;

export async function systemStatus(ctx: Ctx, actor: Actor) {
  assertAdmin(actor);
  const now = ctx.now();
  const scheduled = !!ctx.system?.jobsScheduled;
  const runs = await ctx.db.select().from(jobRuns);
  const byName = new Map(runs.map((r) => [r.name, r]));

  const jobs = Object.keys(JOB_LABELS)
    .filter((n) => n !== 'stripeWebhook')
    .map((name) => {
      const r = byName.get(name);
      const stale = scheduled && (!r?.lastStartedAt || now.getTime() - r.lastStartedAt.getTime() > JOB_STALE_MS);
      const state: State = (r?.consecutiveFailures ?? 0) > 0 || stale ? 'attention' : 'ok';
      return {
        name,
        label: label(name),
        lastStartedAt: r?.lastStartedAt ?? null,
        lastSucceededAt: r?.lastSucceededAt ?? null,
        lastFailedAt: r?.lastFailedAt ?? null,
        lastError: (r?.consecutiveFailures ?? 0) > 0 ? (r?.lastError ?? null) : null,
        consecutiveFailures: r?.consecutiveFailures ?? 0,
        stale,
        state,
      };
    });

  const w = byName.get('stripeWebhook');
  const stripeWebhook = {
    lastReceivedAt: w?.lastSucceededAt ?? null,
    lastFailedAt: w?.lastFailedAt ?? null,
    lastError: (w?.consecutiveFailures ?? 0) > 0 ? (w?.lastError ?? null) : null,
    consecutiveFailures: w?.consecutiveFailures ?? 0,
    state: ((w?.consecutiveFailures ?? 0) > 0 ? 'attention' : 'ok') as State,
  };

  const failedRows = await ctx.db
    .select({
      id: notifications.id,
      type: notifications.type,
      recipient: notifications.recipient,
      subject: notifications.subject,
      body: notifications.body,
      attempts: notifications.attempts,
      nextRetryAt: notifications.nextRetryAt,
      error: notifications.error,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(eq(notifications.status, 'failed'))
    .orderBy(desc(notifications.createdAt))
    .limit(50);
  const [counts] = await ctx.db
    .select({
      failed: count(sql`case when ${notifications.status} = 'failed' then 1 end`),
      gaveUp: count(sql`case when ${notifications.status} = 'failed' and ${notifications.nextRetryAt} is null then 1 end`),
    })
    .from(notifications)
    .where(inArray(notifications.status, ['failed']));
  const gaveUp = Number(counts?.gaveUp ?? 0);
  const notificationsInfo = {
    failedCount: Number(counts?.failed ?? 0),
    gaveUpCount: gaveUp,
    state: (gaveUp > 0 ? 'attention' : 'ok') as State,
    failed: failedRows.map(({ body, ...n }) => ({ ...n, canResend: !isRedacted(body) })),
  };

  const backupAt = await lastBackup(ctx.system?.backupStatusFile);
  const backup = {
    lastSucceededAt: backupAt ?? null,
    state: (backupAt === undefined ? 'unset' : !backupAt || now.getTime() - backupAt.getTime() > BACKUP_STALE_MS ? 'attention' : 'ok') as State,
  };

  const applied = await migrationsApplied(ctx.db);
  const total = migrationsTotal();
  const database = {
    ok: true,
    migrationsApplied: applied,
    migrationsTotal: total,
    state: (applied !== null && total > 0 && applied < total ? 'attention' : 'ok') as State,
  };

  const attention: string[] = [];
  for (const j of jobs) if (j.state === 'attention') attention.push(j.stale ? `「${j.label}」が動いていません` : `「${j.label}」が失敗しています`);
  if (stripeWebhook.state === 'attention') attention.push('Stripe の通知の処理が失敗しています');
  if (gaveUp > 0) attention.push(`届けられなかった通知が${gaveUp}件あります`);
  if (backup.state === 'attention') attention.push(backupAt ? 'バックアップが36時間以上成功していません' : 'バックアップの成功の記録がありません');
  if (database.state === 'attention') attention.push('データベースの更新が終わっていません');

  return {
    version: ctx.system?.version ?? null,
    builtAt: ctx.system?.builtAt ?? null,
    checkedAt: now,
    database,
    jobs,
    stripeWebhook,
    notifications: notificationsInfo,
    backup,
    attention,
  };
}

/** ダッシュボードの「対応が必要なこと」に出す。要確認がなければ 0 */
export async function systemAttentionCount(ctx: Ctx, actor: Actor): Promise<number> {
  return (await systemStatus(ctx, actor)).attention.length;
}

/** ヘルスチェック（OP-08）。データベースに問い合わせられなければ false */
export async function healthy(db: Db): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

