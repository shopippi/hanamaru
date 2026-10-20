import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, Empty, Loadable, Skeleton, TextArea, fmtDateTime, useAction, useLoad, useToast } from '@hanamaru/ui';
import { api, type StudentDetail } from '../api.js';

// 担当生徒（SR-06: 名前・電話・メール・講師用備考・レッスン記録だけ）

export function Students() {
  const { state, reload } = useLoad(() => api.get<{ id: string; name: string; status: string }[]>('/students'), []);
  return (
    <div className="stack">
      <h1>担当生徒</h1>
      <Loadable state={state} reload={reload} skeleton={<Skeleton lines={5} />}>
        {(list) =>
          list.length === 0 ? (
            <Empty message="担当している生徒はいません。担当は教室が設定します。" />
          ) : (
            <ul className="list">
              {list.map((s) => (
                <li key={s.id}>
                  <Link to={`/students/${s.id}`} style={{ display: 'flex', minHeight: 44, alignItems: 'center' }}>
                    {s.name}
                    {s.status === 'suspended' && <span className="badge" style={{ marginLeft: 8 }}>休会中</span>}
                  </Link>
                </li>
              ))}
            </ul>
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
    <div className="stack-lg">
      <h1>{s.name}</h1>
      <dl className="card stack" style={{ margin: 0 }}>
        <div>
          <dt className="muted small">電話</dt>
          <dd style={{ margin: 0 }}>{s.phone ? <a href={`tel:${s.phone}`}>{s.phone}</a> : '—'}</dd>
        </div>
        <div>
          <dt className="muted small">メール</dt>
          <dd style={{ margin: 0 }}>{s.email ? <a href={`mailto:${s.email}`}>{s.email}</a> : '—'}</dd>
        </div>
      </dl>
      <section className="stack">
        <TextArea label="講師用備考" hint="教室と、この生徒の担当講師全員が読み書きできます" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button variant="secondary" onClick={() => void save.run()} pending={save.pending} disabled={note === s.teacherNote}>
          備考を保存する
        </Button>
      </section>
      <section>
        <h2>レッスン記録</h2>
        {s.lessonRecords.length === 0 ? (
          <Empty message="まだ記録はありません。担当レッスン一覧から書けます。" />
        ) : (
          <ul className="list">
            {[...s.lessonRecords].reverse().map((r) => (
              <li key={r.id}>
                <strong>{fmtDateTime(r.startsAt)}</strong> <span className="small muted">{r.teacherName}</span>
                <p style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{r.content}</p>
                {r.progress && <p className="small" style={{ margin: 0 }}>進み具合: {r.progress}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
