import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ConfirmDialog,
  Empty,
  IconCalendar,
  Loadable,
  Skeleton,
  Warning,
  addDaysKey,
  dateKey,
  dateParts,
  fmtDate,
  fmtDateKey,
  fmtTime,
  fmtTimeRange,
  useAction,
  useLoad,
  useOnline,
  useToast,
} from '@hanamaru/ui';
import { api, type Home, type LessonType, type Slot, type TeacherProfile } from '../api.js';
import { useStudent } from '../student-context.js';

// 予約（4.1）: 担当講師の切り替え（TC-02）、空き枠、予約の確認。1画面に1つの操作（MB-02）

const RANGE_DAYS = 28;

function BookSkeleton() {
  return (
    <div className="stack">
      <div className="date-strip" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="skeleton" style={{ flex: 'none', width: 60, height: 78 }} />
        ))}
      </div>
      <div className="slot-grid">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="skeleton" style={{ height: 52 }} />
        ))}
      </div>
    </div>
  );
}

export function Book() {
  const { current } = useStudent();
  const [params] = useSearchParams();
  const changeId = params.get('change');
  const navigate = useNavigate();
  const toast = useToast();
  // 予約はオンラインのときだけ受け付ける（PW-04）
  const online = useOnline();

  const base = useLoad(
    () =>
      Promise.all([
        api.get<TeacherProfile[]>(`/students/${current.id}/teachers`),
        api.get<LessonType[]>('/lesson-types'),
        api.get<Home>(`/students/${current.id}/home`),
      ]),
    [current.id],
  );
  const [teacherId, setTeacherId] = useState<string | null>(null);
  const teachers = base.data?.[0] ?? [];
  const activeTeacher = teacherId ?? teachers[0]?.teacherId ?? null;

  const today = dateKey(new Date());
  const slotsLoad = useLoad(
    () =>
      activeTeacher
        ? api.get<Slot[]>(`/students/${current.id}/slots?teacherId=${activeTeacher}&from=${today}&to=${addDaysKey(today, RANGE_DAYS)}`)
        : Promise.resolve([]),
    [current.id, activeTeacher],
  );

  const [day, setDay] = useState<string | null>(null);
  const [picked, setPicked] = useState<Slot | null>(null);

  const byDay = useMemo(() => {
    const m = new Map<string, Slot[]>();
    for (const s of slotsLoad.data ?? []) {
      const k = dateKey(s.startsAt);
      m.set(k, [...(m.get(k) ?? []), s]);
    }
    return m;
  }, [slotsLoad.data]);
  const days = [...byDay.keys()];
  const activeDay = day && byDay.has(day) ? day : (days[0] ?? null);

  const book = useAction(async (slot: Slot) => {
    try {
      // サーバーで確定してから「予約しました」と出す（UI-14）
      const res = changeId
        ? await api.post<{ status: string }>(`/reservations/${changeId}/change`, slot)
        : await api.post<{ status: string }>(`/students/${current.id}/reservations`, slot);
      toast(changeId ? '日時を変更しました' : res.status === 'pending' ? '仮予約しました。教室の確認後に確定します' : '予約しました');
      navigate('/reservations');
    } catch (e) {
      setPicked(null);
      toast(e instanceof Error ? e.message : '予約できませんでした', 'error');
      slotsLoad.reload();
    }
  });

  return (
    <div className="stack">
      <h1>{changeId ? '日時を変更する' : '予約する'}</h1>
      <Loadable state={base.state} reload={base.reload} skeleton={<BookSkeleton />}>
        {([profiles, types, home]) => {
          const typeName = (id: string) => types.find((t) => t.id === id)?.name ?? '';
          if (home.blocker) return <Warning title={home.blocker} />;
          if (profiles.length === 0) return <Empty message="担当の講師がまだ決まっていません。教室にお問い合わせください。" />;
          return (
            <div className="stack">
              {profiles.length > 1 && (
                <div className="child-switcher" role="group" aria-label="講師を選ぶ">
                  {profiles.map((p) => (
                    <button
                      key={p.teacherId}
                      type="button"
                      className="child-chip"
                      aria-pressed={p.teacherId === activeTeacher}
                      onClick={() => {
                        setTeacherId(p.teacherId);
                        setDay(null);
                      }}
                    >
                      <span className="avatar" aria-hidden="true">
                        {(p.name.trim().split(/\s+/).pop() ?? p.name).slice(0, 1)}
                      </span>
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
              <Loadable state={slotsLoad.state} reload={slotsLoad.reload} skeleton={<BookSkeleton />}>
                {() =>
                  days.length === 0 ? (
                    <Empty
                      icon={<IconCalendar />}
                      message="予約できる枠がありません"
                      text="日を改めてご確認いただくか、教室にお問い合わせください。"
                    />
                  ) : (
                    <div className="stack-lg">
                      <div>
                        <p className="field-label" id="day-label">
                          日にち
                        </p>
                        <div className="date-strip" role="group" aria-labelledby="day-label">
                          {days.map((d) => {
                            const p = dateParts(`${d}T12:00:00+09:00`);
                            const n = byDay.get(d)!.length;
                            return (
                              <button
                                key={d}
                                type="button"
                                className="date-chip"
                                aria-pressed={d === activeDay}
                                aria-label={`${fmtDateKey(d)}（空き${n}枠）`}
                                onClick={() => setDay(d)}
                              >
                                <span className="date-chip-weekday">
                                  {p.month}/{p.weekday}
                                </span>
                                <span className="date-chip-day">{p.day}</span>
                                <span className="date-chip-count">{n}枠</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                        <legend className="field-label">{activeDay && fmtDateKey(activeDay)}の空き時間</legend>
                        <div className="slot-grid">
                          {(byDay.get(activeDay!) ?? []).map((s) => (
                            <button
                              key={s.startsAt + s.lessonTypeId}
                              type="button"
                              className="choice"
                              aria-label={`${fmtDate(s.startsAt)} ${fmtTimeRange(s.startsAt, s.endsAt)} ${typeName(s.lessonTypeId)}`}
                              disabled={!online}
                              onClick={() => setPicked(s)}
                            >
                              {fmtTime(s.startsAt)}
                            </button>
                          ))}
                        </div>
                      </fieldset>
                      <p className="small muted">予約すると、レッスン日の月の回数を1回使います。</p>
                    </div>
                  )
                }
              </Loadable>
              <ConfirmDialog
                open={!!picked}
                title={changeId ? 'この日時に変更しますか' : 'この内容で予約しますか'}
                confirmLabel={changeId ? '変更する' : '予約する'}
                pending={book.pending}
                confirmDisabled={!online}
                onCancel={() => setPicked(null)}
                onConfirm={() => picked && void book.run(picked)}
              >
                {picked && (
                  <dl className="summary">
                    <div>
                      <dt>日時</dt>
                      <dd>
                        {fmtDate(picked.startsAt)} {fmtTimeRange(picked.startsAt, picked.endsAt)}
                      </dd>
                    </div>
                    <div>
                      <dt>講師</dt>
                      <dd>{profiles.find((p) => p.teacherId === picked.teacherId)?.name}</dd>
                    </div>
                    <div>
                      <dt>レッスン</dt>
                      <dd>{typeName(picked.lessonTypeId)}</dd>
                    </div>
                  </dl>
                )}
              </ConfirmDialog>
            </div>
          );
        }}
      </Loadable>
    </div>
  );
}
