import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Button,
  ConfirmDialog,
  Empty,
  Loadable,
  Select,
  Skeleton,
  TextField,
  WEEKDAY_LABELS,
  Warning,
  addDaysKey,
  dateKey,
  fmtDate,
  fmtDateKey,
  fmtTime,
  fmtTimeRange,
  useAction,
  useLoad,
  useToast,
  weekdayOfKey,
} from '@hanamaru/ui';
import { api, type LessonType, type ReservationRow, type Slot, type StudentRow, type Teacher } from '../api.js';

// 予約カレンダー・代理予約・繰り返し予約（4.1、RS-06、RS-07）

const mondayOf = (key: string) => addDaysKey(key, -((weekdayOfKey(key) + 6) % 7));

export function Calendar() {
  const toast = useToast();
  const [week, setWeek] = useState(() => mondayOf(dateKey(new Date())));
  const [teacherId, setTeacherId] = useState('');
  const [panel, setPanel] = useState<'none' | 'book' | 'series'>('none');
  const to = addDaysKey(week, 6);
  const refs = useLoad(() => Promise.all([api.get<Teacher[]>('/teachers'), api.get<LessonType[]>('/lesson-types'), api.get<StudentRow[]>('/students?status=active')]), []);
  const { state, reload } = useLoad(
    () => api.get<ReservationRow[]>(`/reservations?from=${week}&to=${to}${teacherId ? `&teacherId=${teacherId}` : ''}`),
    [week, teacherId],
  );
  const [cancelTarget, setCancelTarget] = useState<ReservationRow | null>(null);
  const [refund, setRefund] = useState(true);

  const act = useAction(async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn();
      toast(message);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '操作できませんでした', 'error');
    }
  });

  return (
    <div className="stack-lg">
      <div className="spread">
        <h1 style={{ margin: 0 }}>予約</h1>
        <div className="row">
          <Button variant="secondary" onClick={() => setPanel(panel === 'series' ? 'none' : 'series')}>
            繰り返し予約
          </Button>
          <Button onClick={() => setPanel(panel === 'book' ? 'none' : 'book')}>代理予約</Button>
        </div>
      </div>
      <Loadable state={refs.state} reload={refs.reload} skeleton={<Skeleton lines={2} />}>
        {([teachers, types, students]) => (
          <>
            {panel === 'book' && <BookPanel teachers={teachers} types={types} students={students} onDone={() => (setPanel('none'), reload())} />}
            {panel === 'series' && <SeriesPanel teachers={teachers} types={types} students={students} onDone={() => (setPanel('none'), reload())} />}
            <div className="row">
              <Button variant="secondary" onClick={() => setWeek(addDaysKey(week, -7))}>
                ← 前の週
              </Button>
              <strong>
                {fmtDateKey(week)}〜{fmtDateKey(to)}
              </strong>
              <Button variant="secondary" onClick={() => setWeek(addDaysKey(week, 7))}>
                次の週 →
              </Button>
              <select aria-label="講師で絞り込む" className="select" style={{ width: 'auto' }} value={teacherId} onChange={(e) => setTeacherId(e.target.value)}>
                <option value="">すべての講師</option>
                {teachers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
      </Loadable>
      <Loadable state={state} reload={reload} skeleton={<Skeleton lines={10} />}>
        {(list) =>
          list.length === 0 ? (
            <Empty message="この週の予約はありません" action={<Button onClick={() => setPanel('book')}>代理予約する</Button>} />
          ) : (
            <div className="stack">
              {Array.from({ length: 7 }, (_, i) => addDaysKey(week, i)).map((day) => {
                const rs = list.filter((r) => dateKey(r.startsAt) === day);
                if (rs.length === 0) return null;
                return (
                  <section key={day} className="card">
                    <h2>{fmtDateKey(day)}</h2>
                    <ul className="list">
                      {rs.map((r) => (
                        <li key={r.id} className="stack">
                          <div>
                            <strong className="num">{fmtTimeRange(r.startsAt, r.endsAt)}</strong>
                            {r.studentId ? <Link to={`/students/${r.studentId}`}>{r.studentName}</Link> : '体験レッスン'}
                            <span className="small muted">
                              ・{r.teacherName}・{r.lessonTypeName}
                            </span>
                            {r.status === 'pending' && <span className="badge badge-solid" style={{ marginLeft: 8 }}>仮予約</span>}
                            {r.attendance === 'no_show' && <span className="badge" style={{ marginLeft: 8 }}>無断欠席</span>}
                            {r.attendance === 'attended' && <span className="badge" style={{ marginLeft: 8 }}>出席</span>}
                          </div>
                          <div className="row">
                            {r.status === 'pending' && (
                              <>
                                <Button onClick={() => void act.run(() => api.post(`/reservations/${r.id}/decide`, { approve: true }), '承認しました')}>承認</Button>
                                <Button variant="secondary" onClick={() => void act.run(() => api.post(`/reservations/${r.id}/decide`, { approve: false }), '却下しました。回数を戻しました')}>
                                  却下
                                </Button>
                              </>
                            )}
                            {r.status === 'confirmed' && new Date(r.startsAt) < new Date() && (
                              <>
                                <Button variant="secondary" onClick={() => void act.run(() => api.post(`/reservations/${r.id}/attendance`, { attendance: 'attended' }), '出席にしました')}>
                                  出席
                                </Button>
                                <Button variant="secondary" onClick={() => void act.run(() => api.post(`/reservations/${r.id}/attendance`, { attendance: 'no_show' }), '無断欠席にしました（回数は戻りません）')}>
                                  無断欠席
                                </Button>
                              </>
                            )}
                            <Button variant="ghost" onClick={() => (setRefund(true), setCancelTarget(r))}>
                              取り消す
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          )
        }
      </Loadable>
      <ConfirmDialog
        open={!!cancelTarget}
        title="この予約を取り消しますか"
        confirmLabel="取り消す"
        cancelLabel="やめる"
        pending={act.pending}
        onCancel={() => setCancelTarget(null)}
        onConfirm={() => {
          const r = cancelTarget!;
          setCancelTarget(null);
          void act.run(() => api.post(`/reservations/${r.id}/cancel`, { refund }), refund ? '取り消しました。回数を戻しました' : '取り消しました（回数は戻していません）');
        }}
      >
        {cancelTarget && (
          <div className="stack">
            <p>
              <strong>
                {fmtDate(cancelTarget.startsAt)} {fmtTime(cancelTarget.startsAt)}
              </strong>　{cancelTarget.studentName ?? '体験'}
            </p>
            <label className="checkbox">
              <input type="radio" name="refund" checked={refund} onChange={() => setRefund(true)} /> 回数を戻す（教室での取消・締切前の連絡）
            </label>
            <label className="checkbox">
              <input type="radio" name="refund" checked={!refund} onChange={() => setRefund(false)} /> 回数を戻さない（締切後の連絡）
            </label>
            <p className="small muted">生徒にメールでお知らせします。</p>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}

function useStudentTeachers(studentId: string) {
  return useLoad(
    () => (studentId ? api.get<{ teachers: { id: string; name: string }[] }>(`/students/${studentId}`).then((d) => d.teachers) : Promise.resolve([])),
    [studentId],
  );
}

/** 管理者の代理予約。公開期間より先や締切後でも入れられる（RS-07） */
function BookPanel({ types, students, onDone }: { teachers: Teacher[]; types: LessonType[]; students: StudentRow[]; onDone: () => void }) {
  const toast = useToast();
  const [studentId, setStudentId] = useState('');
  const [teacherId, setTeacherId] = useState('');
  const [date, setDate] = useState(dateKey(new Date()));
  const assigned = useStudentTeachers(studentId);
  const slots = useLoad(
    () => (teacherId ? api.get<Slot[]>(`/slots?teacherId=${teacherId}&from=${date}&to=${date}`) : Promise.resolve([] as Slot[])),
    [teacherId, date],
  );
  const open = useMemo(() => (slots.data ?? []).filter((s) => s.booked < s.capacity && !s.forTrial), [slots.data]);
  const book = useAction(async (s: Slot) => {
    try {
      const r = await api.post<{ warning: string | null }>('/reservations', { studentId, teacherId, lessonTypeId: s.lessonTypeId, startsAt: s.startsAt });
      toast(r.warning ? `予約しました（${r.warning}）` : '予約しました', r.warning ? 'error' : 'success');
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : '予約できませんでした', 'error');
    }
  });
  return (
    <section className="card stack">
      <h2>代理予約</h2>
      <div className="grid-2">
        <Select label="生徒" value={studentId} onChange={(e) => (setStudentId(e.target.value), setTeacherId(''))}>
          <option value="">選んでください</option>
          {students.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Select label="担当講師" value={teacherId} onChange={(e) => setTeacherId(e.target.value)} disabled={!studentId}>
          <option value="">選んでください</option>
          {(assigned.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <TextField label="日付" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      {teacherId && (
        <Loadable state={slots.state} reload={slots.reload} skeleton={<Skeleton lines={2} />}>
          {() =>
            open.length === 0 ? (
              <Empty message="この日は空いている枠がありません" />
            ) : (
              <div className="slot-grid">
                {open.map((s) => (
                  <Button key={s.startsAt + s.lessonTypeId} variant="secondary" pending={book.pending} pendingLabel="…" onClick={() => void book.run(s)}>
                    {fmtTime(s.startsAt)} {types.find((t) => t.id === s.lessonTypeId)?.name}
                  </Button>
                ))}
              </div>
            )
          }
        </Loadable>
      )}
    </section>
  );
}

/** 毎週の繰り返し予約（RS-07）。各月の回数から使い、足りない月は警告を出す */
function SeriesPanel({ types, students, onDone }: { teachers: Teacher[]; types: LessonType[]; students: StudentRow[]; onDone: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ studentId: '', teacherId: '', lessonTypeId: types[0]?.id ?? '', weekday: '1', startTime: '16:00', startDate: dateKey(new Date()), endDate: addDaysKey(dateKey(new Date()), 84) });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const assigned = useStudentTeachers(form.studentId);
  const [result, setResult] = useState<{ created: unknown[]; skipped: { date: string; reason: string }[]; warnings: string[] } | null>(null);
  const create = useAction(async () => {
    try {
      const r = await api.post<{ created: unknown[]; skipped: { date: string; reason: string }[]; warnings: string[] }>('/series', { ...form, weekday: Number(form.weekday) });
      setResult(r);
      toast(`${r.created.length}回分を予約しました`);
      if (!r.skipped.length && !r.warnings.length) onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : '作れませんでした', 'error');
    }
  });
  return (
    <section className="card stack">
      <h2>毎週の繰り返し予約</h2>
      <div className="grid-2">
        <Select label="生徒" value={form.studentId} onChange={set('studentId')}>
          <option value="">選んでください</option>
          {students.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Select label="担当講師" value={form.teacherId} onChange={set('teacherId')} disabled={!form.studentId}>
          <option value="">選んでください</option>
          {(assigned.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <Select label="レッスン種別" value={form.lessonTypeId} onChange={set('lessonTypeId')}>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <Select label="曜日" value={form.weekday} onChange={set('weekday')}>
          {WEEKDAY_LABELS.map((w, i) => (
            <option key={i} value={i}>
              {w}曜日
            </option>
          ))}
        </Select>
        <TextField label="開始時刻" type="time" step={900} value={form.startTime} onChange={set('startTime')} />
        <TextField label="最初の日" type="date" value={form.startDate} onChange={set('startDate')} />
        <TextField label="最後の日" type="date" value={form.endDate} onChange={set('endDate')} />
      </div>
      {result && (result.warnings.length > 0 || result.skipped.length > 0) && (
        <Warning title="確認してください">
          <ul style={{ margin: 0, paddingLeft: '1.2em' }}>
            {result.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
            {result.skipped.map((s) => (
              <li key={s.date}>
                {fmtDateKey(s.date)}は予約できませんでした（{s.reason}）
              </li>
            ))}
          </ul>
        </Warning>
      )}
      <Button onClick={() => void create.run()} pending={create.pending} disabled={!form.studentId || !form.teacherId}>
        繰り返し予約を作る
      </Button>
    </section>
  );
}
