import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ConfirmDialog,
  Empty,
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
    <ul className="list">
      {[0, 1, 2].map((i) => (
        <li key={i}>
          <Skeleton lines={2} />
        </li>
      ))}
    </ul>
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
                  message="予約はまだありません"
                  action={
                    <Link className="btn btn-primary" to="/book">
                      予約する
                    </Link>
                  }
                />
              ) : (
                <ul className="list">
                  {upcoming.map((r) => (
                    <li key={r.id} className="stack">
                      <div>
                        <strong style={{ fontSize: 18 }}>
                          {fmtDate(r.startsAt)} {fmtTimeRange(r.startsAt, r.endsAt)}
                        </strong>
                        {r.status === 'pending' && <span className="badge" style={{ marginLeft: 8 }}>仮予約</span>}
                        <br />
                        {r.teacherName}・{r.lessonTypeName}
                      </div>
                      <div className="row">
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
                          className="btn btn-secondary"
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
              )}
              {past.length > 0 && (
                <details>
                  <summary style={{ minHeight: 44, display: 'flex', alignItems: 'center', cursor: 'pointer' }}>これまでの予約（{past.length}件）</summary>
                  <ul className="list">
                    {past.map((r) => (
                      <li key={r.id}>
                        {fmtDateTime(r.startsAt)}　{r.teacherName}
                        <span className="small muted">
                          {' '}
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
            <p>
              <strong>{fmtDateTime(preview.startsAt)}</strong>
            </p>
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
