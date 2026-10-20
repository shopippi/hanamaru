import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Button,
  Empty,
  IconBook,
  IconChevronRight,
  IconMail,
  IconPhone,
  IconUsers,
  Loadable,
  PageHeader,
  Panel,
  Skeleton,
  TextArea,
  fmtDateTime,
  useAction,
  useLoad,
  useToast,
} from '@hanamaru/ui';
import { api, type StudentDetail } from '../api.js';

// 担当生徒（SR-06: 名前・電話・メール・講師用備考・レッスン記録だけ）

export function Students() {
  const { state, reload } = useLoad(() => api.get<{ id: string; name: string; status: string }[]>('/students'), []);
  return (
    <div>
      <PageHeader title="担当生徒" description="連絡先・講師用備考・これまでのレッスン記録を確認できます。" />
      <Loadable state={state} reload={reload} skeleton={<Skeleton lines={5} />}>
        {(list) =>
          list.length === 0 ? (
            <div className="panel">
              <Empty icon={<IconUsers />} message="担当している生徒はいません" text="担当は教室が設定します。" />
            </div>
          ) : (
            <div className="panel">
              <ul className="list">
                {list.map((s) => (
                  <li key={s.id}>
                    <Link className="list-row" to={`/students/${s.id}`}>
                      <span className="avatar" aria-hidden="true">
                        {(s.name.trim().split(/\s+/).pop() ?? s.name).slice(0, 1)}
                      </span>
                      <span className="list-row-main list-title">{s.name}</span>
                      {s.status === 'suspended' && <span className="badge">休会中</span>}
                      <IconChevronRight className="muted" />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )
        }
      </Loadable>
    </div>
  );
}

export function StudentPage() {
  const { id } = useParams();
  const { state, reload } = useLoad(() => api.get<StudentDetail>(`/students/${id}`), [id]);
  return (
    <Loadable state={state} reload={reload} skeleton={<Skeleton lines={8} />}>
      {(s) => <Detail s={s} />}
    </Loadable>
  );
}

function Detail({ s }: { s: StudentDetail }) {
  const toast = useToast();
  const [note, setNote] = useState(s.teacherNote);
  const save = useAction(async () => {
    try {
      await api.put(`/students/${s.id}/teacher-note`, { text: note });
      toast('講師用備考を保存しました');
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存できませんでした', 'error');
    }
  });
  return (
    <div>
      <PageHeader
        title={s.name}
        back={{ to: '/students', label: '担当生徒', as: ({ to, className, children }) => <Link to={to} className={className}>{children}</Link> }}
      />
      <div className="stack-lg">
        <Panel title="連絡先" flush>
          <dl className="summary flush">
            <div>
              <dt>
                <IconPhone size={16} /> 電話
              </dt>
              <dd>{s.phone ? <a href={`tel:${s.phone}`}>{s.phone}</a> : '—'}</dd>
            </div>
            <div>
              <dt>
                <IconMail size={16} /> メール
              </dt>
              <dd>{s.email ? <a href={`mailto:${s.email}`}>{s.email}</a> : '—'}</dd>
            </div>
          </dl>
        </Panel>
        <Panel
          footer={
            <Button variant="secondary" onClick={() => void save.run()} pending={save.pending} disabled={note === s.teacherNote}>
              備考を保存する
            </Button>
          }
        >
          <TextArea label="講師用備考" hint="教室と、この生徒の担当講師全員が読み書きできます" value={note} onChange={(e) => setNote(e.target.value)} />
        </Panel>
        <Panel title="レッスン記録" flush>
          {s.lessonRecords.length === 0 ? (
            <Empty icon={<IconBook />} message="まだ記録はありません" text="担当レッスン一覧から書けます。" />
          ) : (
            <ol className="list timeline">
              {[...s.lessonRecords].reverse().map((r) => (
                <li key={r.id}>
                  <p className="spread">
                    <strong className="num">{fmtDateTime(r.startsAt)}</strong>
                    <span className="small muted">{r.teacherName}</span>
                  </p>
                  <p style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{r.content}</p>
                  {r.progress && <p className="small secondary">進み具合: {r.progress}</p>}
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>
    </div>
  );
}
