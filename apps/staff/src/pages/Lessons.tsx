import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Button,
  Empty,
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  Loadable,
  PageHeader,
  Skeleton,
  addDaysKey,
  dateKey,
  fmtDateKey,
  fmtTime,
  fmtTimeRange,
  useLoad,
  weekdayOfKey,
} from '@hanamaru/ui';
import { api, type Lesson } from '../api.js';

// 担当レッスン一覧（4.1）。1週間ずつ表示し、ここからレッスン記録を書く（SR-04）

const mondayOf = (key: string) => addDaysKey(key, -((weekdayOfKey(key) + 6) % 7));

export function Lessons() {
  const [week, setWeek] = useState(() => mondayOf(dateKey(new Date())));
  const to = addDaysKey(week, 6);
  const { state, reload } = useLoad(() => api.get<Lesson[]>(`/lessons?from=${week}&to=${to}`), [week]);

  const thisWeek = mondayOf(dateKey(new Date()));
  return (
    <div>
      <PageHeader title="担当レッスン" description="レッスンが終わったら、ここから記録を書きます。" />
      <div className="stack">
        <div className="week-nav">
          <Button variant="secondary" className="btn-icon" onClick={() => setWeek(addDaysKey(week, -7))} aria-label="前の週">
            <IconChevronLeft />
          </Button>
          <p className="week-nav-label">
            <strong className="num">
              {fmtDateKey(week)}〜{fmtDateKey(to)}
            </strong>
            {week === thisWeek && <span className="badge badge-muted">今週</span>}
          </p>
          <Button variant="secondary" className="btn-icon" onClick={() => setWeek(addDaysKey(week, 7))} aria-label="次の週">
            <IconChevronRight />
          </Button>
        </div>
        <Loadable
          state={state}
          reload={reload}
          skeleton={
            <div className="panel">
              <ul className="list">
                {[0, 1, 2, 3].map((i) => (
                  <li key={i}>
                    <Skeleton lines={2} />
                  </li>
                ))}
              </ul>
            </div>
          }
        >
          {(lessons) => {
            if (lessons.length === 0)
              return (
                <div className="panel">
                  <Empty
                    icon={<IconCalendar />}
                    message="この週の担当レッスンはありません"
                    action={
                      <Link className="btn btn-secondary" to="/availability">
                        空き時間を確認する
                      </Link>
                    }
                  />
                </div>
              );
            const days = new Map<string, Lesson[]>();
            for (const l of lessons) days.set(dateKey(l.startsAt), [...(days.get(dateKey(l.startsAt)) ?? []), l]);
            return (
              <div className="stack">
                {[...days].map(([day, ls]) => (
                  <section key={day} className="panel" aria-label={fmtDateKey(day)}>
                    <h2 className="day-heading">
                      {fmtDateKey(day)}
                      <span className="badge badge-muted">{ls.length}件</span>
                    </h2>
                    <ul className="list">
                      {ls.map((l) => (
                        <li key={l.id} className="list-row">
                          <span className="time-cell num">
                            <strong>{fmtTime(l.startsAt)}</strong>
                            <span className="small muted">{fmtTimeRange(l.startsAt, l.endsAt).split('〜')[1]}まで</span>
                          </span>
                          <span className="list-row-main">
                            <span className="list-title">{l.studentId ? <Link to={`/students/${l.studentId}`}>{l.studentName}</Link> : '体験レッスン'}</span>
                            <span className="list-meta">
                              {l.lessonTypeName}
                              {l.status === 'pending' && <span className="badge badge-strong" style={{ marginLeft: 8 }}>仮予約</span>}
                            </span>
                          </span>
                          {l.studentId && (
                            <Link className={`btn ${l.hasRecord ? 'btn-quiet' : 'btn-secondary'}`} to={`/lessons/${l.id}/record`}>
                              {l.hasRecord ? '記録を直す' : '記録を書く'}
                            </Link>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            );
          }}
        </Loadable>
      </div>
    </div>
  );
}
