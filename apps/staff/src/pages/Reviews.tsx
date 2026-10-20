import {
  Button,
  Empty,
  IconCheck,
  IconInbox,
  Loadable,
  PageHeader,
  Skeleton,
  fmtDateTime,
  useAction,
  useLoad,
  useToast,
} from '@hanamaru/ui';
import { api } from '../api.js';
import { REVIEWS_CHANGED } from '../layout.js';

// 生徒から届いたレビュー（RV-04、RV-05）。誰からかを確かめ、未確認のものには赤い印を付ける

interface TeacherReview {
  id: string;
  authorName: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  edited: boolean;
  checked: boolean;
}

export function Reviews() {
  const toast = useToast();
  const { state, reload } = useLoad(() => api.get<{ unread: number; reviews: TeacherReview[] }>('/reviews'), []);
  const changed = () => {
    reload();
    window.dispatchEvent(new Event(REVIEWS_CHANGED));
  };
  const check = useAction(async (id: string) => {
    try {
      await api.post(`/reviews/${id}/check`);
      changed();
    } catch (e) {
      toast(e instanceof Error ? e.message : '確認済みにできませんでした', 'error');
    }
  });
  const checkAll = useAction(async () => {
    try {
      await api.post('/reviews/check-all');
      toast('すべて確認済みにしました');
      changed();
    } catch (e) {
      toast(e instanceof Error ? e.message : '確認済みにできませんでした', 'error');
    }
  });

  return (
    <div>
      <Loadable
        state={state}
        reload={reload}
        skeleton={
          <div className="stack">
            <Skeleton lines={2} />
            <Skeleton block />
          </div>
        }
      >
        {(d) => (
          <>
            <PageHeader
              title="レビュー"
              description={d.unread > 0 ? `未確認のレビューが ${d.unread}件 あります。` : '生徒から届いたレビューです。'}
              actions={
                d.unread > 0 && (
                  <Button variant="secondary" onClick={() => void checkAll.run()} pending={checkAll.pending}>
                    <IconCheck size={18} />
                    すべて確認済みにする
                  </Button>
                )
              }
            />
            {d.reviews.length === 0 ? (
              <div className="panel">
                <Empty icon={<IconInbox />} message="まだレビューはありません" text="生徒がレビューを書くと、ここに届きます。" />
              </div>
            ) : (
              <ul className="review-list">
                {d.reviews.map((r) => (
                  <li key={r.id} className={r.checked ? 'review-item' : 'review-item unread'}>
                    <div className="panel-body stack-sm">
                      <p className="review-meta">
                        {!r.checked && (
                          <>
                            <span className="unread-dot" aria-hidden="true" />
                            <span className="visually-hidden">未確認</span>
                          </>
                        )}
                        <strong className="secondary">{r.authorName}</strong>
                        <span className="num">{fmtDateTime(r.createdAt)}</span>
                        {r.edited && <span className="badge badge-muted">編集済み</span>}
                      </p>
                      <p style={{ whiteSpace: 'pre-wrap' }}>{r.body}</p>
                    </div>
                    {!r.checked && (
                      <div className="review-actions">
                        <Button variant="quiet" onClick={() => void check.run(r.id)} disabled={check.pending}>
                          <IconCheck size={18} />
                          確認した
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Loadable>
    </div>
  );
}
