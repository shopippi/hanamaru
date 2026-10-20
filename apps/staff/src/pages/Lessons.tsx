import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Empty, Loadable, Skeleton, addDaysKey, dateKey, fmtDate, fmtDateKey, fmtTimeRange, useLoad, weekdayOfKey } from '@hanamaru/ui';
import { api, type Lesson } from '../api.js';

// 担当レッスン一覧（4.1）。1週間ずつ表示し、ここからレッスン記録を書く（SR-04）

const mondayOf = (key: string) => addDaysKey(key, -((weekdayOfKey(key) + 6) % 7));

export function Lessons() {
  const [week, setWeek] = useState(() => mondayOf(dateKey(new Date())));
  const to = addDaysKey(week, 6);
  const { state, reload } = useLoad(() => api.get<Lesson[]>(`/lessons?from=${week}&to=${to}`), [week]);

  return (
    <div className="stack">
      <h1>担当レッスン</h1>
      <div className="spread">
        <Button variant="secondary" onClick={() => setWeek(addDaysKey(week, -7))} aria-label="前の週">
          ← 前の週
        </Button>
        <strong className="small">
          {fmtDateKey(week)}〜{fmtDateKey(to)}
        </strong>
        <Button variant="secondary" onClick={() => setWeek(addDaysKey(week, 7))} aria-label="次の週">
          次の週 →
        </Button>
      </div>
      <Loadable
        state={state}
        reload={reload}
        skeleton={
          <ul className="list">
            {[0, 1, 2, 3].map((i) => (
              <li key={i}>
                <Skeleton lines={2} />
              </li>
            ))}
          </ul>
        }
      >
        {(lessons) =>
          lessons.length === 0 ? (
            <Empty message="この週の担当レッスンはありません" action={<Link className="btn btn-secondary" to="/availability">空き時間を確認する</Link>} />
          ) : (
            <ul className="list">
              {lessons.map((l) => (
                <li key={l.id} className="spread">
                  <div>
                    <strong>
                      {fmtDate(l.startsAt)} {fmtTimeRange(l.startsAt, l.endsAt)}
                    </strong>
                    {l.status === 'pending' && <span className="badge" style={{ marginLeft: 8 }}>仮予約</span>}
                    <br />
                    {l.studentId ? <Link to={`/students/${l.studentId}`}>{l.studentName}</Link> : '体験レッスン'}
                    <span className="muted small">・{l.lessonTypeName}</span>
                  </div>
                  {l.studentId && (
                    <Link className={`btn ${l.hasRecord ? 'btn-secondary' : 'btn-primary'}`} to={`/lessons/${l.id}/record`}>
                      {l.hasRecord ? '記録を直す' : '記録を書く'}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      </Loadable>
    </div>
  );
}
