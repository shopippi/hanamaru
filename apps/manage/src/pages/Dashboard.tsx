import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Empty,
  Loadable,
  STUDENT_STATUS_LABEL,
  Skeleton,
  Warning,
  fmtDate,
  fmtMonth,
  fmtMonthShort,
  fmtTime,
  fmtYen,
  METHOD_LABEL,
  monthKey,
  useLoad,
} from '@hanamaru/ui';
import { api } from '../api.js';

// ダッシュボード（3.10）。カードを縦に並べ、スマホでも見やすくする

interface Dash {
  studentCounts: Record<string, number>;
  reservations: {
    today: Res[];
    week: Res[];
    weekStart: string;
  };
  unpaid: { paymentId: string; studentId: string; studentName: string; month: string; method: string; amount: number; status: string; graceDaysLeft: number }[];
  teacherStats: { month: string; teachers: { teacherId: string; name: string; lessons: number; teacherCancels: number }[] };
  todo: {
    pendingApproval: number;
    pendingReservations: number;
    newTrialRequests: number;
    creditShortages: { studentId: string; studentName: string; month: string; shortBy: number }[];
  };
}
interface Res {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  teacherName: string;
  roomName: string | null;
  studentName: string;
  lessonTypeName: string;
}

const shiftMonth = (m: string, n: number) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const idx = y * 12 + mo - 1 + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
};

export function Dashboard() {
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [groupBy, setGroupBy] = useState<'teacher' | 'room'>('teacher');
  const [range, setRange] = useState<'today' | 'week'>('today');
  const { state, reload } = useLoad(() => api.get<Dash>(`/dashboard?month=${month}`), [month]);

  return (
    <div className="stack-lg">
      <h1>ダッシュボード</h1>
      <Loadable
        state={state}
        reload={reload}
        skeleton={
          <div className="stack">
            <div className="grid">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton" style={{ height: 88 }} />)}</div>
            <Skeleton block />
            <Skeleton block />
          </div>
        }
      >
        {(d) => {
          const todos = [
            d.todo.pendingApproval > 0 && <Link key="a" to="/students?pending=1">承認待ちの生徒 {d.todo.pendingApproval}人</Link>,
            d.todo.pendingReservations > 0 && <Link key="r" to="/calendar">仮予約 {d.todo.pendingReservations}件</Link>,
            d.todo.newTrialRequests > 0 && <Link key="t" to="/trials">新しい体験の申込 {d.todo.newTrialRequests}件</Link>,
            ...d.todo.creditShortages.map((s) => (
              <Link key={s.studentId + s.month} to={`/students/${s.studentId}`}>
                {s.studentName}: {fmtMonthShort(s.month)}の回数が{s.shortBy}回足りません
              </Link>
            )),
          ].filter(Boolean);
          const list = range === 'today' ? d.reservations.today : d.reservations.week;
          const groups = new Map<string, Res[]>();
          for (const r of list) {
            const k = groupBy === 'teacher' ? r.teacherName : (r.roomName ?? '教室の指定なし');
            groups.set(k, [...(groups.get(k) ?? []), r]);
          }
          return (
            <div className="stack-lg">
              {todos.length > 0 && (
                <Warning title="対応が必要なこと">
                  <ul style={{ margin: 0, paddingLeft: '1.2em' }}>
                    {todos.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                </Warning>
              )}

              <section aria-labelledby="db1">
                <h2 id="db1">生徒の人数</h2>
                <div className="grid">
                  {Object.entries(STUDENT_STATUS_LABEL).map(([k, label]) => (
                    <Link key={k} className="card card-link" to={`/students?status=${k}`}>
                      <p className="card-title">{label}</p>
                      <p className="big-number num" style={{ margin: 0 }}>
                        {d.studentCounts[k] ?? 0}
                        <small>人</small>
                      </p>
                    </Link>
                  ))}
                </div>
              </section>

              <section aria-labelledby="db2" className="stack">
                <h2 id="db2">予約</h2>
                <div className="row">
                  <div className="row" role="group" aria-label="期間">
                    <button type="button" className="choice" style={{ width: 'auto' }} aria-pressed={range === 'today'} onClick={() => setRange('today')}>
                      今日
                    </button>
                    <button type="button" className="choice" style={{ width: 'auto' }} aria-pressed={range === 'week'} onClick={() => setRange('week')}>
                      今週
                    </button>
                  </div>
                  <div className="row" role="group" aria-label="まとめ方">
                    <button type="button" className="choice" style={{ width: 'auto' }} aria-pressed={groupBy === 'teacher'} onClick={() => setGroupBy('teacher')}>
                      講師別
                    </button>
                    <button type="button" className="choice" style={{ width: 'auto' }} aria-pressed={groupBy === 'room'} onClick={() => setGroupBy('room')}>
                      教室別
                    </button>
                  </div>
                </div>
                {list.length === 0 ? (
                  <Empty message={range === 'today' ? '今日の予約はありません' : '今週の予約はありません'} action={<Link className="btn btn-secondary" to="/calendar">予約を見る</Link>} />
                ) : (
                  [...groups].map(([name, rs]) => (
                    <div key={name} className="card">
                      <h3>
                        {name}（{rs.length}件）
                      </h3>
                      <ul className="list">
                        {rs.map((r) => (
                          <li key={r.id}>
                            {range === 'week' && `${fmtDate(r.startsAt)} `}
                            <strong className="num">{fmtTime(r.startsAt)}</strong>　{r.studentName}
                            <span className="small muted">
                              ・{r.lessonTypeName}
                              {groupBy === 'room' ? `・${r.teacherName}` : ''}
                            </span>
                            {r.status === 'pending' && <span className="badge" style={{ marginLeft: 8 }}>仮予約</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
                )}
              </section>

              <section aria-labelledby="db3" className="stack">
                <h2 id="db3">未払い・決済失敗</h2>
                {d.unpaid.length === 0 ? (
                  <Empty message="未払いの生徒はいません" />
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">生徒</th>
                          <th scope="col">対象月</th>
                          <th scope="col">方法</th>
                          <th scope="col">金額</th>
                          <th scope="col">状態</th>
                          <th scope="col">猶予の残り</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.unpaid.map((u) => (
                          <tr key={u.paymentId}>
                            <td>
                              <Link to={`/students/${u.studentId}`}>{u.studentName}</Link>
                            </td>
                            <td>{fmtMonthShort(u.month)}</td>
                            <td>{METHOD_LABEL[u.method]}</td>
                            <td className="num">{fmtYen(u.amount)}</td>
                            <td>{u.status === 'failed' ? <strong>⚠ 決済失敗</strong> : '未払い'}</td>
                            <td className="num">{u.graceDaysLeft > 0 ? `あと${u.graceDaysLeft}日` : <strong>過ぎています</strong>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section aria-labelledby="db4" className="stack">
                <div className="spread">
                  <h2 id="db4" style={{ margin: 0 }}>
                    講師別（{fmtMonth(d.teacherStats.month)}）
                  </h2>
                  <div className="row">
                    <button type="button" className="btn btn-secondary" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="前の月">
                      ←
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="次の月">
                      →
                    </button>
                  </div>
                </div>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">講師</th>
                        <th scope="col">レッスン数</th>
                        <th scope="col">講師都合キャンセル</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.teacherStats.teachers.map((t) => (
                        <tr key={t.teacherId}>
                          <td>{t.name}</td>
                          <td className="num">{t.lessons}</td>
                          <td className="num">{t.teacherCancels}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          );
        }}
      </Loadable>
    </div>
  );
}
