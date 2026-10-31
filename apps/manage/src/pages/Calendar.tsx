import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Button,
  ConfirmDialog,
  DateTile,
  Empty,
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconPlus,
  IconRefresh,
  Loadable,
  PageHeader,
  Panel,
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
  const { state, reload } = useLoad(() => api.get<ReservationRow[]>(`/reservations?from=${week}&to=${to}${teacherId ? `&teacherId=${teacherId}` : ''}`), [week, teacherId]);
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
    <div>
      <PageHeader
        title="予約"
        description="週ごとの予約の確認・承認・出欠の記録と、代理予約を行います。"
        actions={
          <>
            <Button variant="secondary" onClick={() => setPanel(panel === 'series' ? 'none' : 'series')} aria-expanded={panel === 'series'}>
              <IconRefresh size={18} />
              繰り返し予約
            </Button>
            <Button onClick={() => setPanel(panel === 'book' ? 'none' : 'book')} aria-expanded={panel === 'book'}>
              <IconPlus size={18} />
              代理予約
            </Button>
          </>
        }
      />
      <div className="stack-lg">
        <Loadable state={refs.state} reload={refs.reload} skeleton={<Skeleton lines={2} />}>
          {([teachers, types, students]) => (
            <>
              {panel === 'book' && <BookPanel teachers={teachers} types={types} students={students} onDone={() => (setPanel('none'), reload())} />}
              {panel === 'series' && <SeriesPanel teachers={teachers} types={types} students={students} onDone={() => (setPanel('none'), reload())} />}
              <div className="spread">
                <div className="row">
                  <Button variant="secondary" onClick={() => setWeek(addDaysKey(week, -7))}>
                    <IconChevronLeft size={18} />
                    前の週
                  </Button>
                  <strong className="nowrap">
                    {fmtDateKey(week)}〜{fmtDateKey(to)}
                  </strong>
                  <Button variant="secondary" onClick={() => setWeek(addDaysKey(week, 7))}>
                    次の週
                    <IconChevronRight size={18} />
                  </Button>
                </div>
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
              <div className="panel">
                <Empty icon={<IconCalendar />} message="この週の予約はありません" action={<Button onClick={() => setPanel('book')}>代理予約する</Button>} />
              </div>
            ) : (
              <div className="stack">
                {Array.from({ length: 7 }, (_, i) => addDaysKey(week, i)).map((day) => {
                  const rs = list.filter((r) => dateKey(r.startsAt) === day);
                  if (rs.length === 0) return null;
                  return (
                    <section key={day} className="panel">
                      <div className="panel-header">
                        <div className="row">
                          <DateTile at={`${day}T12:00:00+09:00`} />
                          <h2>{fmtDateKey(day)}</h2>
                        </div>
                        <span className="badge badge-muted">{rs.length}件</span>
                      </div>
                      <ul className="list">
                        {rs.map((r) => (
                          <li key={r.id} className="list-row" style={{ flexWrap: 'wrap' }}>
                            <span className="time-cell num">
                              <strong>{fmtTimeRange(r.startsAt, r.endsAt)}</strong>
                            </span>
                            <span className="list-row-main">
                              <span className="list-title">{r.studentId ? <Link to={`/students/${r.studentId}`}>{r.studentName}</Link> : '体験レッスン'}</span>
                              <span className="list-meta">
                                {r.teacherName}・{r.lessonTypeName}
                                {r.online && <span className="badge" style={{ marginLeft: 8 }}>オンライン</span>}
                              </span>
                            </span>
                            <span className="row-tight">
                              {r.status === 'pending' && <span className="badge badge-solid">仮予約</span>}
                              {r.attendance === 'no_show' && <span className="badge badge-strong">無断欠席</span>}
                              {r.attendance === 'attended' && <span className="badge badge-dot">出席</span>}
                            </span>
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
                                  <Button
                                    variant="secondary"
                                    onClick={() => void act.run(() => api.post(`/reservations/${r.id}/attendance`, { attendance: 'no_show' }), '無断欠席にしました（回数は戻りません）')}
                                  >
                                    無断欠席
                                  </Button>
                                </>
                              )}
                              <Button variant="quiet" onClick={() => (setRefund(true), setCancelTarget(r))}>
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
      </div>
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
            <dl className="summary">
              <div>
                <dt>日時</dt>
                <dd>
                  {fmtDate(cancelTarget.startsAt)} {fmtTime(cancelTarget.startsAt)}
                </dd>
              </div>
              <div>
                <dt>生徒</dt>
                <dd>{cancelTarget.studentName ?? '体験'}</dd>
              </div>
            </dl>
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
    () =>
      studentId
        ? api
            .get<{
              teachers: { id: string; name: string }[];
            }>(`/students/${studentId}`)
            .then((d) => d.teachers)
        : Promise.resolve([]),
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
  const slots = useLoad(() => (teacherId ? api.get<Slot[]>(`/slots?teacherId=${teacherId}&from=${date}&to=${date}`) : Promise.resolve([] as Slot[])), [teacherId, date]);
  const open = useMemo(() => (slots.data ?? []).filter((s) => s.booked < s.capacity && !s.forTrial), [slots.data]);
  const book = useAction(async (s: Slot) => {
    try {
      const r = await api.post<{ warning: string | null }>('/reservations', {
        studentId,
        teacherId,
        lessonTypeId: s.lessonTypeId,
        startsAt: s.startsAt,
      });
      toast(r.warning ? `予約しました（${r.warning}）` : '予約しました', r.warning ? 'error' : 'success');
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : '予約できませんでした', 'error');
    }
  });
  return (
    <Panel title="代理予約">
      <div className="stack">
        <p className="small muted">公開期間より先や締切後の日時でも予約できます。</p>
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
                <Empty icon={<IconCalendar />} message="この日は空いている枠がありません" />
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
      </div>
    </Panel>
  );
}

/** 毎週の繰り返し予約（RS-07）。各月の回数から使い、足りない月は警告を出す */
function SeriesPanel({ types, students, onDone }: { teachers: Teacher[]; types: LessonType[]; students: StudentRow[]; onDone: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({
    studentId: '',
    teacherId: '',
    lessonTypeId: types[0]?.id ?? '',
    weekday: '1',
    startTime: '16:00',
    startDate: dateKey(new Date()),
    endDate: addDaysKey(dateKey(new Date()), 84),
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const assigned = useStudentTeachers(form.studentId);
  const [result, setResult] = useState<{
    created: unknown[];
    skipped: { date: string; reason: string }[];
    warnings: string[];
  } | null>(null);
  const create = useAction(async () => {
    try {
      const r = await api.post<{
        created: unknown[];
        skipped: { date: string; reason: string }[];
        warnings: string[];
      }>('/series', { ...form, weekday: Number(form.weekday) });
      setResult(r);
      toast(`${r.created.length}回分を予約しました`);
      if (!r.skipped.length && !r.warnings.length) onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : '作れませんでした', 'error');
    }
  });
  return (
    <Panel
      title="毎週の繰り返し予約"
      footer={
        <Button onClick={() => void create.run()} pending={create.pending} disabled={!form.studentId || !form.teacherId}>
          繰り返し予約を作る
        </Button>
      }
    >
      <div className="stack">
        <p className="small muted">各月の回数から使います。回数が足りない月は警告を出します。</p>
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
            <ul className="todo-list">
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
      </div>
    </Panel>
  );
}
