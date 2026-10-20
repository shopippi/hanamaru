import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ConfirmDialog,
  Empty,
  Loadable,
  Skeleton,
  Warning,
  addDaysKey,
  dateKey,
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
      <div className="skeleton" style={{ height: 44, width: '60%' }} />
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
                <div className="row" role="group" aria-label="講師を選ぶ">
                  {profiles.map((p) => (
                    <button
                      key={p.teacherId}
                      type="button"
                      className="choice"
                      style={{ width: 'auto' }}
                      aria-pressed={p.teacherId === activeTeacher}
                      onClick={() => {
                        setTeacherId(p.teacherId);
                        setDay(null);
                      }}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
              <Loadable state={slotsLoad.state} reload={slotsLoad.reload} skeleton={<BookSkeleton />}>
                {() =>
                  days.length === 0 ? (
                    <Empty message="予約できる枠がありません。日を改めてご確認いただくか、教室にお問い合わせください。" />
                  ) : (
                    <div className="stack">
                      <div>
                        <label className="field-label" htmlFor="day">
                          日にち
                        </label>
                        <select id="day" className="select" value={activeDay ?? ''} onChange={(e) => setDay(e.target.value)}>
                          {days.map((d) => (
                            <option key={d} value={d}>
                              {fmtDateKey(d)}（空き{byDay.get(d)!.length}枠）
                            </option>
                          ))}
                        </select>
                      </div>
                      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                        <legend className="field-label">時間を選ぶ</legend>
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
                  <dl className="stack" style={{ margin: 0 }}>
                    <div>
                      <dt className="muted small">日時</dt>
                      <dd style={{ margin: 0, fontWeight: 700, fontSize: 18 }}>
                        {fmtDate(picked.startsAt)} {fmtTimeRange(picked.startsAt, picked.endsAt)}
                      </dd>
                    </div>
                    <div>
                      <dt className="muted small">講師・レッスン</dt>
                      <dd style={{ margin: 0 }}>
                        {profiles.find((p) => p.teacherId === picked.teacherId)?.name}・{typeName(picked.lessonTypeId)}
                      </dd>
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
