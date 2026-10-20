import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { authTokens, jobRuns, notifications, sessions, stripeEvents } from '../src/db/schema.js';
import type { Db } from '../src/db/client.js';
import { runJobs } from '../src/domain/jobs.js';
import { updateSettings } from '../src/domain/settings.js';
import { cleanup, dismissNotification, PURGED_BODY, resendNotification, retryNotifications, systemStatus, trackedRun } from '../src/domain/system.js';
import { dashboard } from '../src/domain/dashboard.js';
import { createBaseApp } from '../src/http/app.js';
import { setup } from './fixtures.js';

// 開発者の手を借りずに運用を続けるための仕組み（OP-05〜OP-09）

const MINUTE = 60_000;
const later = (f: { clock: { now: Date } }, minutes: number) => {
  f.clock.now = new Date(f.clock.now.getTime() + minutes * MINUTE);
};
const alerts = (f: Awaited<ReturnType<typeof setup>>, word: string) => f.mail.sent.filter((m) => m.subject.includes(word));

describe('OP-05 定期処理の成否の記録と、管理者へのお知らせ', () => {
  test('OP-05 失敗したら管理者にメールで知らせ、同じ処理は1日に1回まで。直ったら「復旧しました」と知らせる', async () => {
    const f = await setup();
    const boom = () => Promise.reject(new Error('Stripe に接続できません'));
    await expect(trackedRun(f.ctx, 'reconcilePayments', boom)).rejects.toThrow('接続できません');
    const first = alerts(f, '要確認');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ to: 'matsuda@example.test' });
    expect(first[0]!.subject).toContain('決済の照合');
    expect(first[0]!.text).toContain('Stripe に接続できません');
    expect(first[0]!.text).toContain('https://manage.example.test/system');

    // 1時間後にまた失敗しても、もう一度は知らせない
    later(f, 60);
    await expect(trackedRun(f.ctx, 'reconcilePayments', boom)).rejects.toThrow();
    expect(alerts(f, '要確認')).toHaveLength(1);
    const [row] = await f.db.select().from(jobRuns).where(eq(jobRuns.name, 'reconcilePayments'));
    expect(row).toMatchObject({ consecutiveFailures: 2, lastError: 'Stripe に接続できません' });

    // 24時間たっても失敗していれば、もう一度知らせる（間隔は設定値）
    later(f, 24 * 60);
    await expect(trackedRun(f.ctx, 'reconcilePayments', boom)).rejects.toThrow();
    expect(alerts(f, '要確認')).toHaveLength(2);

    // 直ったら知らせ、記録を戻す
    expect(await trackedRun(f.ctx, 'reconcilePayments', async () => 3)).toBe(3);
    expect(alerts(f, '復旧しました')).toHaveLength(1);
    const [after] = await f.db.select().from(jobRuns).where(eq(jobRuns.name, 'reconcilePayments'));
    expect(after).toMatchObject({ consecutiveFailures: 0, lastAlertAt: null });
    // 成功が続いても、もう知らせない
    await trackedRun(f.ctx, 'reconcilePayments', async () => 0);
    expect(alerts(f, '復旧しました')).toHaveLength(1);
  });

  test('OP-05 定期処理は全部の成否を記録する。お知らせのメールは設定で止められない', async () => {
    const f = await setup();
    await updateSettings(f.db, { notifications: { system_alert: false } }, null);
    await runJobs(f.ctx);
    const names = (await f.db.select().from(jobRuns)).map((r) => r.name).sort();
    expect(names).toEqual(
      ['applyPriceChanges', 'applyScheduledStatuses', 'cleanup', 'closeMonth', 'expireUnpaid', 'prepareMonth', 'reconcilePayments', 'retryNotifications', 'sendReminders'].sort(),
    );
    await expect(trackedRun(f.ctx, 'cleanup', () => Promise.reject(new Error('x')))).rejects.toThrow();
    expect(alerts(f, '要確認')).toHaveLength(1);
  });
});

describe('OP-06 送れなかった通知の送り直し', () => {
  const send = (f: Awaited<ReturnType<typeof setup>>) =>
    f.ctx.notifier.send('reservation_confirmed', { email: 'hanataro@example.test' }, { subject: '【予約確定】', body: '10月22日 15:00' });

  test('OP-06 5分・30分・120分後に送り直し、それでも届かなければあきらめる。届いたら送信済みになる', async () => {
    const f = await setup();
    f.mail.failing = true;
    await send(f);
    const row = async () => (await f.db.select().from(notifications).where(eq(notifications.recipient, 'hanataro@example.test')))[0]!;
    expect(await row()).toMatchObject({ status: 'failed', attempts: 1 });
    expect((await row()).nextRetryAt).toEqual(new Date(f.clock.now.getTime() + 5 * MINUTE));

    // 時刻になるまでは送り直さない
    later(f, 4);
    expect(await retryNotifications(f.ctx)).toBe(0);
    expect((await row()).attempts).toBe(1);

    later(f, 1);
    await retryNotifications(f.ctx);
    expect(await row()).toMatchObject({ status: 'failed', attempts: 2 });
    later(f, 30);
    await retryNotifications(f.ctx);
    later(f, 120);
    await retryNotifications(f.ctx);
    expect(await row()).toMatchObject({ status: 'failed', attempts: 4, nextRetryAt: null });
    // あきらめた通知は「システムの状態」で要確認になる
    const st = await systemStatus(f.ctx, f.admin);
    expect(st.notifications).toMatchObject({ failedCount: 1, gaveUpCount: 1, state: 'attention' });
    expect(st.attention).toContain('届けられなかった通知が1件あります');

    // 管理者がすぐに送り直せる
    f.mail.failing = false;
    await resendNotification(f.ctx, f.admin, (await row()).id);
    expect(await row()).toMatchObject({ status: 'sent', attempts: 5, nextRetryAt: null, error: null });
    expect(f.mail.sent.filter((m) => m.to === 'hanataro@example.test')).toHaveLength(1);
  });

  test('OP-06 途中で届けば、それ以上は送らない', async () => {
    const f = await setup();
    f.mail.failing = true;
    await send(f);
    f.mail.failing = false;
    later(f, 5);
    expect(await retryNotifications(f.ctx)).toBe(1);
    later(f, 200);
    expect(await retryNotifications(f.ctx)).toBe(0);
    expect(f.mail.sent.filter((m) => m.to === 'hanataro@example.test')).toHaveLength(1);
  });

  test('OP-06 招待・再設定のメールはリンクを記録しないので、自動でも手動でも送り直さない', async () => {
    const f = await setup();
    f.mail.failing = true;
    await f.ctx.notifier.send('invite', { email: 'new@example.test' }, { subject: '招待', body: 'https://student.example.test/invite?token=abc123' });
    const [n] = await f.db.select().from(notifications).where(eq(notifications.recipient, 'new@example.test'));
    expect(n).toMatchObject({ status: 'failed', nextRetryAt: null });
    expect(n!.body).not.toContain('abc123');
    f.mail.failing = false;
    await expect(resendNotification(f.ctx, f.admin, n!.id)).rejects.toThrow('招待をやり直す');
    expect((await systemStatus(f.ctx, f.admin)).notifications.failed[0]).toMatchObject({ id: n!.id, canResend: false });
    // 「送らない」にすると一覧から外れる
    await dismissNotification(f.ctx, f.admin, n!.id);
    expect((await systemStatus(f.ctx, f.admin)).notifications.failedCount).toBe(0);
  });

  test('OP-06 送り直し・送らないは管理者だけ', async () => {
    const f = await setup();
    f.mail.failing = true;
    await send(f);
    const [n] = await f.db.select().from(notifications);
    await expect(resendNotification(f.ctx, f.teacherA.actor, n!.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(dismissNotification(f.ctx, f.teacherA.actor, n!.id)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('OP-07 古い記録の片付け', () => {
  test('OP-07 期限切れのログイン・使い終わったリンク・古い Stripe の受信記録を消し、古い通知は本文だけ消す。何度実行しても同じ', async () => {
    const f = await setup();
    const day = 24 * 60;
    const now = f.clock.now;
    const ago = (days: number) => new Date(now.getTime() - days * day * MINUTE);
    const acc = f.adminAccount;
    await f.db.insert(sessions).values([
      { id: 'expired', accountId: acc.id, expiresAt: ago(1) },
      { id: 'alive', accountId: acc.id, expiresAt: new Date(now.getTime() + day * MINUTE) },
    ]);
    await f.db.insert(authTokens).values([
      { tokenHash: 'used-old', accountId: acc.id, purpose: 'reset', expiresAt: new Date(now.getTime() + day * MINUTE), usedAt: ago(2) },
      { tokenHash: 'expired-old', accountId: acc.id, purpose: 'invite', expiresAt: ago(2) },
      { tokenHash: 'fresh', accountId: acc.id, purpose: 'invite', expiresAt: new Date(now.getTime() + day * MINUTE) },
    ]);
    await f.db.insert(stripeEvents).values([
      { id: 'evt_old', type: 'invoice.paid', receivedAt: ago(181) },
      { id: 'evt_new', type: 'invoice.paid', receivedAt: ago(10) },
    ]);
    await f.db.insert(notifications).values([
      { channel: 'email', type: 'reservation_confirmed', recipient: 'a@example.test', subject: '古い', body: '山田 はな太郎 様 10月22日', status: 'sent', createdAt: ago(91) },
      { channel: 'email', type: 'reservation_confirmed', recipient: 'b@example.test', subject: '新しい', body: '本文', status: 'sent', createdAt: ago(1) },
    ]);

    expect(await cleanup(f.ctx)).toEqual({ sessions: 1, authTokens: 2, stripeEvents: 1, notificationBodies: 1 });
    expect(await cleanup(f.ctx)).toEqual({ sessions: 0, authTokens: 0, stripeEvents: 0, notificationBodies: 0 });
    expect((await f.db.select().from(sessions)).map((s) => s.id)).toEqual(['alive']);
    expect((await f.db.select().from(authTokens)).map((t) => t.tokenHash)).toEqual(['fresh']);
    expect((await f.db.select().from(stripeEvents)).map((e) => e.id)).toEqual(['evt_new']);
    const old = (await f.db.select().from(notifications).where(eq(notifications.recipient, 'a@example.test')))[0]!;
    // 誰に何の種類を送ったかは残る
    expect(old).toMatchObject({ subject: '古い', type: 'reservation_confirmed', body: PURGED_BODY });
  });
});

describe('OP-08 システムの状態', () => {
  test('OP-08 管理者は、定期処理・Stripe の通知・通知の送信・バックアップの状態を一覧できる。講師と生徒は見られない', async () => {
    const f = await setup();
    const dir = mkdtempSync(join(tmpdir(), 'hm-backup-'));
    const file = join(dir, 'last-success');
    writeFileSync(file, new Date(f.clock.now.getTime() - 2 * 60 * MINUTE).toISOString());
    f.ctx.system = { version: 'abc1234', builtAt: '2026-10-20', backupStatusFile: file, jobsScheduled: true };

    // 定期処理が一度も動いていなければ「動いていません」
    let st = await systemStatus(f.ctx, f.admin);
    expect(st.version).toBe('abc1234');
    expect(st.attention).toContain('「月謝の請求」が動いていません');
    expect(st.backup.state).toBe('ok');
    expect(st.database.migrationsApplied).toBe(st.database.migrationsTotal);

    await runJobs(f.ctx);
    st = await systemStatus(f.ctx, f.admin);
    expect(st.attention).toEqual([]);
    expect(st.jobs.find((j) => j.name === 'prepareMonth')).toMatchObject({ label: '月謝の請求', state: 'ok' });
    expect((await dashboard(f.ctx, f.admin)).todo.systemAttention).toBe(0);

    // 失敗とバックアップの遅れは要確認になり、ダッシュボードにも出る
    await expect(trackedRun(f.ctx, 'stripeWebhook', () => Promise.reject(new Error('署名は正しいが処理に失敗')))).rejects.toThrow();
    writeFileSync(file, new Date(f.clock.now.getTime() - 40 * 60 * MINUTE).toISOString());
    st = await systemStatus(f.ctx, f.admin);
    expect(st.stripeWebhook).toMatchObject({ state: 'attention', lastError: '署名は正しいが処理に失敗' });
    expect(st.attention).toEqual(['Stripe の通知の処理が失敗しています', 'バックアップが36時間以上成功していません']);
    expect((await dashboard(f.ctx, f.admin)).todo.systemAttention).toBe(2);

    await expect(systemStatus(f.ctx, f.teacherA.actor)).rejects.toMatchObject({ code: 'forbidden' });
    const { actor } = await f.mkStudent('はな太郎');
    await expect(systemStatus(f.ctx, actor)).rejects.toMatchObject({ code: 'forbidden' });
  });

  test('OP-08 バックアップの記録の場所を設定していなければ「未設定」で、要確認にはしない', async () => {
    const f = await setup();
    const st = await systemStatus(f.ctx, f.admin);
    expect(st.backup).toEqual({ lastSucceededAt: null, state: 'unset' });
    expect(st.version).toBeNull();
    // 開発環境・テストでは定期処理を自動で動かしていないので、「動いていません」にしない
    expect(st.attention).toEqual([]);
  });

  test('OP-08 ヘルスチェックはデータベースに問い合わせ、できなければ 503', async () => {
    const f = await setup();
    expect((await createBaseApp(f.db).request('/api/health')).status).toBe(200);
    const broken = { execute: () => Promise.reject(new Error('connection refused')) } as unknown as Db;
    const res = await createBaseApp(broken).request('/api/health');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'database' });
  });
});

describe('OP-09 想定外のエラーと送信の大きさ', () => {
  test('OP-09 想定外のエラーは、画面に出せるエラー番号を付けて返す', async () => {
    const app = createBaseApp();
    app.get('/api/boom', () => {
      throw new Error('unexpected');
    });
    const res = await app.request('/api/boom');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; errorId: string };
    expect(body.errorId).toMatch(/^[0-9a-f]{8}$/);
    expect(body.error).toContain(`エラー番号: ${body.errorId}`);
  });

  test('OP-09 大きすぎる送信は断る。講師の写真だけは大きめでも受け付ける', async () => {
    const app = createBaseApp();
    app.post('/api/echo', (c) => c.json({ ok: true }));
    app.put('/api/teachers/1/photo', (c) => c.json({ ok: true }));
    const big = JSON.stringify({ data: 'a'.repeat(2 * 1024 * 1024) });
    const headers = { 'content-type': 'application/json' };
    expect((await app.request('/api/echo', { method: 'POST', body: big, headers })).status).toBe(413);
    expect((await app.request('/api/teachers/1/photo', { method: 'PUT', body: big, headers })).status).toBe(200);
  });
});
