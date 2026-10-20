import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ConfirmDialog,
  DateTile,
  Empty,
  IconCalendar,
  Loadable,
  Skeleton,
  Warning,
  fmtDate,
  fmtDateTime,
  fmtTimeRange,
  useAction,
  useLoad,
  useOnline,
  useToast,
} from '@hanamaru/ui';
import { api, type Reservation } from '../api.js';
import { useStudent } from '../student-context.js';

// 予約一覧・キャンセル（4.1）。キャンセルは確認画面を挟み、締切後は回数が戻らないことをはっきり書く（UI-15）

interface Preview {
  reservationId: string;
  startsAt: string;
  deadline: string;
  refund: boolean;
}

const CANCEL_LABEL: Record<string, string> = {
  student: 'キャンセル済み',
  student_late: 'キャンセル済み（締切後）',
  teacher: '講師の都合で中止',
  school: '休講',
  admin: '教室で取消',
  rejected: '予約できませんでした',
  unpaid: 'お支払い未確認のため取消',
  rescheduled: '日時を変更',
};

function ListSkeleton() {
  return (
    <div className="stack">
      {[0, 1].map((i) => (
        <div key={i} className="card">
          <Skeleton lines={2} />
          <div className="skeleton" style={{ height: 44, marginTop: 12 }} />
        </div>
      ))}
    </div>
  );
}

export function Reservations() {
  const { current } = useStudent();
  const toast = useToast();
  const online = useOnline();
  const { state, reload } = useLoad(() => api.get<Reservation[]>(`/students/${current.id}/reservations`), [current.id]);
  const [preview, setPreview] = useState<Preview | null>(null);

  const openCancel = useAction(async (id: string) => {
    try {
      setPreview(await api.get<Preview>(`/reservations/${id}/cancel-preview`));
    } catch (e) {
      toast(e instanceof Error ? e.message : '開けませんでした', 'error');
    }
  });
  const cancel = useAction(async (id: string) => {
    try {
      const r = await api.post<{ refunded: boolean }>(`/reservations/${id}/cancel`);
      toast(r.refunded ? 'キャンセルしました。回数を1回お戻ししました' : 'キャンセルしました');
      setPreview(null);
      reload();
    } catch (e) {
      setPreview(null);
      toast(e instanceof Error ? e.message : 'キャンセルできませんでした', 'error');
    }
  });

  const now = Date.now();
  return (
    <div className="stack">
      <h1>予約一覧</h1>
      <Loadable state={state} reload={reload} skeleton={<ListSkeleton />}>
        {(list) => {
          const upcoming = list.filter((r) => r.status !== 'cancelled' && new Date(r.endsAt).getTime() >= now);
          const past = list.filter((r) => !upcoming.includes(r)).reverse();
          return (
            <div className="stack-lg">
              {upcoming.length === 0 ? (
                <Empty
                  icon={<IconCalendar />}
                  message="予約はまだありません"
                  text="空いている日時から、レッスンを予約できます。"
                  action={
                    <Link className="btn btn-primary" to="/book">
                      予約する
                    </Link>
                  }
                />
              ) : (
                <section className="stack" aria-labelledby="upcoming-title">
                  <h2 className="section-label" id="upcoming-title">
                    これからの予約<span className="num">（{upcoming.length}件）</span>
                  </h2>
                  <ul className="stack reservation-list">
                    {upcoming.map((r) => (
                      <li key={r.id} className="card reservation">
                        <div className="list-row">
                          <DateTile at={r.startsAt} />
                          <div className="list-row-main">
                            <p className="reservation-time num">
                              {fmtDate(r.startsAt)} {fmtTimeRange(r.startsAt, r.endsAt)}
                            </p>
                            <p className="list-meta">
                              {r.teacherName}・{r.lessonTypeName}
                            </p>
                          </div>
                          {r.status === 'pending' && <span className="badge badge-strong">仮予約</span>}
                        </div>
                        <div className="reservation-actions">
                          <Link
                            className="btn btn-secondary"
                            to={`/book?change=${r.id}`}
                            aria-disabled={!online || undefined}
                            onClick={(e) => !online && e.preventDefault()}
                          >
                            日時を変更
                          </Link>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={!online || openCancel.pending}
                            onClick={() => void openCancel.run(r.id)}
                            aria-label={`${fmtDate(r.startsAt)}の予約をキャンセル`}
                          >
                            キャンセル
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {past.length > 0 && (
                <details className="panel history">
                  <summary>これまでの予約（{past.length}件）</summary>
                  <ul className="list">
                    {past.map((r) => (
                      <li key={r.id} className="list-row">
                        <span className="list-row-main">
                          <span className="num">{fmtDateTime(r.startsAt)}</span>
                          <span className="list-meta">{r.teacherName}</span>
                        </span>
                        <span className={r.status === 'cancelled' ? 'badge badge-muted' : 'badge'}>
                          {r.status === 'cancelled' ? CANCEL_LABEL[r.cancelKind ?? ''] ?? '取消' : r.attendance === 'no_show' ? '欠席' : '受講'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          );
        }}
      </Loadable>
      <ConfirmDialog
        open={!!preview}
        title="この予約をキャンセルしますか"
        confirmLabel="キャンセルする"
        cancelLabel="キャンセルしない"
        pending={cancel.pending}
        confirmDisabled={!online}
        onCancel={() => setPreview(null)}
        onConfirm={() => preview && void cancel.run(preview.reservationId)}
      >
        {preview && (
          <div className="stack">
            <dl className="summary">
              <div>
                <dt>日時</dt>
                <dd className="num">{fmtDateTime(preview.startsAt)}</dd>
              </div>
              <div>
                <dt>締切</dt>
                <dd className="num">{fmtDateTime(preview.deadline)}</dd>
              </div>
            </dl>
            {preview.refund ? (
              <p>締切（{fmtDateTime(preview.deadline)}）より前なので、使った回数を1回お戻しします。</p>
            ) : (
              <Warning title="締切を過ぎているため、回数は戻りません">
                キャンセルの締切は{fmtDateTime(preview.deadline)}でした。キャンセルしても、予約で使った回数はお戻しできません。
              </Warning>
            )}
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
