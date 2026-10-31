import { useState } from 'react';
import {
  Button,
  Empty,
  IconCheckCircle,
  IconInbox,
  IconRefresh,
  Loadable,
  PageHeader,
  Panel,
  Skeleton,
  Warning,
  fmtDateTime,
  fmtTime,
  useAction,
  useLoad,
  useToast,
} from '@hanamaru/ui';
import { api } from '../api.js';

// システムの状態（OP-05〜OP-08）。開発者に頼まなくても、止まっている処理や届かなかった通知に気づけるようにする

type State = 'ok' | 'attention' | 'unset';

interface SystemStatus {
  version: string | null;
  builtAt: string | null;
  checkedAt: string;
  database: { ok: boolean; migrationsApplied: number | null; migrationsTotal: number; state: State };
  jobs: {
    name: string;
    label: string;
    lastStartedAt: string | null;
    lastSucceededAt: string | null;
    lastFailedAt: string | null;
    lastError: string | null;
    consecutiveFailures: number;
    stale: boolean;
    state: State;
  }[];
  stripeWebhook: { lastReceivedAt: string | null; lastFailedAt: string | null; lastError: string | null; consecutiveFailures: number; state: State };
  notifications: {
    failedCount: number;
    gaveUpCount: number;
    state: State;
    failed: {
      id: string;
      type: string;
      recipient: string;
      subject: string;
      attempts: number;
      nextRetryAt: string | null;
      error: string | null;
      createdAt: string;
      canResend: boolean;
    }[];
  };
  backup: { lastSucceededAt: string | null; state: State };
  attention: string[];
}

function StateBadge({ state }: { state: State }) {
  if (state === 'attention') return <span className="badge badge-solid">要確認</span>;
  if (state === 'unset') return <span className="badge badge-muted">未設定</span>;
  return <span className="badge badge-dot">正常</span>;
}

const at = (d: string | null) => (d ? fmtDateTime(d) : '—');

export function SystemPage() {
  const toast = useToast();
  const { state, reload } = useLoad(() => api.get<SystemStatus>('/system'), []);
  const [busyId, setBusyId] = useState<string | null>(null);
  const act = useAction(async (id: string, kind: 'resend' | 'dismiss') => {
    setBusyId(id);
    try {
      await api.post(`/system/notifications/${id}/${kind}`, {});
      toast(kind === 'resend' ? '通知を送り直しました' : 'この通知は送らないことにしました');
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '処理できませんでした', 'error');
    } finally {
      setBusyId(null);
    }
  });

  return (
    <div>
      <PageHeader
        title="システムの状態"
        description="定期処理、Stripe の通知、メール、バックアップが動いているかを確かめられます。要確認があると、管理者にメールでもお知らせします。"
        actions={
          <Button variant="secondary" onClick={reload}>
            <IconRefresh size={18} />
            最新にする
          </Button>
        }
      />
      <Loadable state={state} reload={reload} skeleton={<Skeleton lines={12} />}>
        {(s) => (
          <div className="stack-lg">
            {s.attention.length > 0 ? (
              <Warning title={`要確認（${s.attention.length}件）`}>
                <ul className="todo-list">
                  {s.attention.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </Warning>
            ) : (
              <div className="notice" role="note">
                <span className="notice-icon" aria-hidden="true">
                  <IconCheckCircle />
                </span>
                <div className="notice-body">すべて正常に動いています（{fmtDateTime(s.checkedAt)} 時点）</div>
              </div>
            )}

            <Panel title="定期処理" flush>
              <ul className="list">
                {s.jobs.map((j) => (
                  <li key={j.name} className="list-row">
                    <span className="list-row-main">
                      <span className="list-title">{j.label}</span>
                      <span className="list-meta">
                        {j.consecutiveFailures > 0
                          ? `${j.consecutiveFailures}回続けて失敗: ${j.lastError ?? ''}`
                          : j.stale
                            ? '1時間以上動いていません'
                            : j.lastSucceededAt
                              ? `最後に成功 ${fmtDateTime(j.lastSucceededAt)}`
                              : 'まだ動いていません'}
                      </span>
                    </span>
                    <StateBadge state={j.state} />
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel title="Stripe の通知" actions={<StateBadge state={s.stripeWebhook.state} />}>
              <dl className="summary">
                <div>
                  <dt>最後の受信</dt>
                  <dd className="num">{at(s.stripeWebhook.lastReceivedAt)}</dd>
                </div>
                {s.stripeWebhook.consecutiveFailures > 0 && (
                  <div>
                    <dt>失敗</dt>
                    <dd>
                      {s.stripeWebhook.consecutiveFailures}回続けて失敗（{at(s.stripeWebhook.lastFailedAt)}）: {s.stripeWebhook.lastError}
                      <p className="small secondary">Stripe は失敗した通知を自動で送り直します。続く場合は開発者に連絡してください。</p>
                    </dd>
                  </div>
                )}
              </dl>
            </Panel>

            <Panel
              title="届けられなかった通知"
              actions={
                // 自動で送り直す途中のものがあるだけなら「再送待ち」と出す（正常とは書かない）
                s.notifications.state === 'ok' && s.notifications.failed.length > 0 ? (
                  <span className="badge">再送待ち</span>
                ) : (
                  <StateBadge state={s.notifications.state} />
                )
              } flush={s.notifications.failed.length > 0}>
              {s.notifications.failed.length === 0 ? (
                <Empty icon={<IconInbox />} message="届けられなかった通知はありません" />
              ) : (
                <ul className="list">
                  {s.notifications.failed.map((n) => (
                    <li key={n.id} className="list-row" style={{ flexWrap: 'wrap' }}>
                      <span className="list-row-main" style={{ minWidth: '16em' }}>
                        <span className="list-title">{n.subject}</span>
                        <span className="list-meta">
                          {n.recipient}・{fmtDateTime(n.createdAt)}
                        </span>
                        <span className="small">
                          {n.nextRetryAt ? `${fmtTime(n.nextRetryAt)}ごろ自動で送り直します` : `${n.attempts}回送れませんでした`}
                          {n.error && `（${n.error}）`}
                        </span>
                        {!n.canResend && <span className="small">リンクを含むため送り直せません。招待・再設定をやり直してください。</span>}
                      </span>
                      <span className="row">
                        {n.canResend && (
                          <Button variant="secondary" onClick={() => void act.run(n.id, 'resend')} pending={busyId === n.id} pendingLabel="送っています…" disabled={act.pending && busyId !== n.id}>
                            再送
                          </Button>
                        )}
                        <Button variant="quiet" onClick={() => void act.run(n.id, 'dismiss')} disabled={act.pending}>
                          送らない
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <div className="grid-2">
              <Panel title="バックアップ" actions={<StateBadge state={s.backup.state} />}>
                <dl className="summary">
                  <div>
                    <dt>最後に成功</dt>
                    <dd className="num">{s.backup.state === 'unset' ? 'この環境では記録していません' : at(s.backup.lastSucceededAt)}</dd>
                  </div>
                </dl>
              </Panel>
              <Panel title="データベース・版" actions={<StateBadge state={s.database.state} />}>
                <dl className="summary">
                  <div>
                    <dt>版</dt>
                    <dd>{s.version ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>作成日時</dt>
                    <dd className="num">{s.builtAt ? fmtDateTime(s.builtAt) : '—'}</dd>
                  </div>
                  <div>
                    <dt>更新の適用</dt>
                    <dd className="num">
                      {s.database.migrationsApplied ?? '—'} / {s.database.migrationsTotal} 件
                    </dd>
                  </div>
                </dl>
              </Panel>
            </div>
          </div>
        )}
      </Loadable>
    </div>
  );
}
