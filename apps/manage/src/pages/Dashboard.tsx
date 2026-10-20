import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Empty,
  IconAlert,
  IconCalendar,
  IconCheckCircle,
  IconChevronLeft,
  IconChevronRight,
  IconYen,
  Loadable,
  PageHeader,
  Panel,
  Segmented,
  Stat,
  STUDENT_STATUS_LABEL,
  Skeleton,
  Warning,
  fmtDate,
  fmtDateKey,
  dateKey,
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
  /** オンラインのレッスン（RS-09） */
  online?: boolean;
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
    <div>
      <PageHeader title="ダッシュボード" description={`今日は${fmtDateKey(dateKey(new Date()))}です`} />
      <Loadable
        state={state}
        reload={reload}
        skeleton={
          <div className="stack-lg">
            <div className="stat-grid">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton" style={{ height: 96 }} />)}</div>
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
              {todos.length > 0 ? (
                <Warning title={`対応が必要なこと（${todos.length}件）`}>
                  <ul className="todo-list">
                    {todos.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                </Warning>
              ) : (
                <div className="notice" role="note">
                  <span className="notice-icon" aria-hidden="true">
                    <IconCheckCircle />
                  </span>
                  <div className="notice-body">対応が必要なことはありません</div>
                </div>
              )}

              <section aria-labelledby="db1">
                <div className="section-title">
                  <h2 id="db1">生徒の人数</h2>
                  <Link className="small" to="/students">
                    生徒の一覧へ
                  </Link>
                </div>
                <div className="stat-grid">
                  {Object.entries(STUDENT_STATUS_LABEL).map(([k, label]) => (
                    <Link key={k} className="card card-link stat" to={`/students?status=${k}`}>
                      <Stat label={label} value={d.studentCounts[k] ?? 0} unit="人" />
                    </Link>
                  ))}
                </div>
              </section>

              <div className="dash-grid">
                <Panel
                  title="予約"
                  className="dash-main"
                  flush
                  actions={
                    <>
                      <Segmented label="期間" value={range} options={[['today', '今日'], ['week', '今週']] as const} onChange={setRange} />
                      <Segmented label="まとめ方" value={groupBy} options={[['teacher', '講師別'], ['room', '教室別']] as const} onChange={setGroupBy} />
                    </>
                  }
                >
                  {list.length === 0 ? (
                    <Empty
                      icon={<IconCalendar />}
                      message={range === 'today' ? '今日の予約はありません' : '今週の予約はありません'}
                      action={
                        <Link className="btn btn-secondary" to="/calendar">
                          予約を見る
                        </Link>
                      }
                    />
                  ) : (
                    [...groups].map(([name, rs]) => (
                      <div key={name} className="group">
                        <h3 className="group-title">
                          {name}
                          <span className="badge badge-muted">{rs.length}件</span>
                        </h3>
                        <ul className="list">
                          {rs.map((r) => (
                            <li key={r.id} className="list-row">
                              <span className="time-cell num">
                                {range === 'week' && <span className="small muted">{fmtDate(r.startsAt)}</span>}
                                <strong>{fmtTime(r.startsAt)}</strong>
                              </span>
                              <span className="list-row-main">
                                <span className="list-title">{r.studentName}</span>
                                <span className="list-meta">
                                  {r.lessonTypeName}
                                  {r.online && '・オンライン'}
                                  {groupBy === 'room' ? `・${r.teacherName}` : ''}
                                </span>
                              </span>
                              {r.status === 'pending' && <span className="badge badge-strong">仮予約</span>}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))
                  )}
                </Panel>

                <Panel title="未払い・決済失敗" flush>
                  {d.unpaid.length === 0 ? (
                    <Empty icon={<IconYen />} message="未払いの生徒はいません" />
                  ) : (
                    <ul className="list">
                      {d.unpaid.map((u) => (
                        <li key={u.paymentId} className="list-row">
                          <span className="list-row-main">
                            <Link className="list-title" to={`/students/${u.studentId}`}>
                              {u.studentName}
                            </Link>
                            <span className="list-meta">
                              {fmtMonthShort(u.month)}・{METHOD_LABEL[u.method]}・<span className="num">{fmtYen(u.amount)}</span>
                            </span>
                          </span>
                          <span className="stack-sm" style={{ textAlign: 'right' }}>
                            {u.status === 'failed' ? (
                              <span className="badge badge-strong">
                                <IconAlert size={14} />
                                決済失敗
                              </span>
                            ) : (
                              <span className="badge">未払い</span>
                            )}
                            <span className="small muted nowrap">{u.graceDaysLeft > 0 ? `猶予あと${u.graceDaysLeft}日` : <strong>猶予を過ぎています</strong>}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              </div>

              <Panel
                title={`講師別（${fmtMonth(d.teacherStats.month)}）`}
                flush
                actions={
                  <>
                    <button type="button" className="btn btn-secondary btn-icon" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="前の月">
                      <IconChevronLeft />
                    </button>
                    <button type="button" className="btn btn-secondary btn-icon" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="次の月">
                      <IconChevronRight />
                    </button>
                  </>
                }
              >
                <div className="table-wrap flush">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">講師</th>
                        <th scope="col" className="num">
                          レッスン数
                        </th>
                        <th scope="col" className="num">
                          講師都合キャンセル
                        </th>
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
              </Panel>
            </div>
          );
        }}
      </Loadable>
    </div>
  );
}
