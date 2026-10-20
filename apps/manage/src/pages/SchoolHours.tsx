import { useState } from 'react';
import {
  Button,
  ConfirmDialog,
  IconPlus,
  Loadable,
  MonthCalendar,
  PageHeader,
  Panel,
  Skeleton,
  WEEKDAY_LABELS,
  Warning,
  CalLine,
  compactRange,
  hourRange,
  datesOfMonth,
  fmtDateKey,
  fmtDateTime,
  monthKey,
  useAction,
  useLoad,
  useToast,
  weekdayOfKey,
} from '@hanamaru/ui';
import { api } from '../api.js';

// 教室の受付日（AV-06）。不定休なので、カレンダーで日付ごとに受け付ける時間を決める。
// 受付時間のない日は予約を受け付けない。予約できるのは、講師の空き時間と重なる時間だけ（AV-08）

interface Day {
  date: string;
  windows: { startTime: string; endTime: string }[];
  closures: { startTime: string | null; endTime: string | null; reason: string }[];
  reservations: number;
}
interface Calendar {
  month: string;
  today: string;
  days: Day[];
}
interface Result {
  applied: boolean;
  affected: { reservationId: string; studentName: string; startsAt: string }[];
}
type Window = { startTime: string; endTime: string };

const DEFAULT_WINDOW: Window = { startTime: '10:00', endTime: '21:00' };

export function SchoolHours() {
  const toast = useToast();
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const { state, reload } = useLoad(() => api.get<Calendar>(`/school-hours?month=${month}`), [month]);
  const [selected, setSelected] = useState<string[]>([]);
  const [windows, setWindows] = useState<Window[]>([DEFAULT_WINDOW]);
  const [pending, setPending] = useState<{ body: { dates: string[]; windows: Window[] }; affected: Result['affected'] } | null>(null);

  const apply = useAction(async (body: { dates: string[]; windows: Window[] }, confirm: boolean) => {
    try {
      const res = await api.put<Result>('/school-hours', { ...body, confirm });
      if (!res.applied) {
        setPending({ body, affected: res.affected });
        return;
      }
      setPending(null);
      const what = body.windows.length ? '受付時間を設定しました' : '休みにしました';
      toast(res.affected.length ? `${body.dates.length}日の${what}。${res.affected.length}件の予約を教室都合で取り消しました` : `${body.dates.length}日の${what}`);
      setSelected([]);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '変更できませんでした', 'error');
    }
  });

  const updateWindow = (i: number, patch: Partial<Window>) => setWindows(windows.map((w, j) => (j === i ? { ...w, ...patch } : w)));

  return (
    <div>
      <PageHeader title="受付日" description="教室で予約を受け付ける日と時間を、日付ごとに決めます。受付時間を入れていない日は予約を受け付けません。" />
      <Loadable state={state} reload={reload} skeleton={<Skeleton lines={12} />}>
        {(cal) => {
          const byDate = new Map(cal.days.map((d) => [d.date, d]));
          const future = datesOfMonth(month).filter((d) => d >= cal.today);
          const toggle = (d: string) => {
            const next = selected.includes(d) ? selected.filter((x) => x !== d) : [...selected, d].sort();
            setSelected(next);
            // 1日だけ選んだときは、その日の今の時間帯を編集の初期値にする
            if (next.length === 1) {
              const w = byDate.get(next[0]!)?.windows ?? [];
              setWindows(w.length ? w : [DEFAULT_WINDOW]);
            }
          };
          const selectWeekday = (wd: number) => {
            const ds = future.filter((d) => weekdayOfKey(d) === wd);
            const all = ds.every((d) => selected.includes(d));
            setSelected(all ? selected.filter((d) => !ds.includes(d)) : [...new Set([...selected, ...ds])].sort());
          };
          const affectedCount = selected.reduce((n, d) => n + (byDate.get(d)?.reservations ?? 0), 0);
          return (
            <div className="cal-layout">
              <div className="stack">
                <MonthCalendar
                  month={month}
                  onMonth={(m) => (setMonth(m), setSelected([]))}
                  today={cal.today}
                  isSelected={(d) => selected.includes(d)}
                  isMuted={(d) => (byDate.get(d)?.windows.length ?? 0) === 0}
                  onPick={toggle}
                  describeDay={(d) => {
                    const x = byDate.get(d);
                    if (!x) return '';
                    const w = x.windows.length ? `受付 ${x.windows.map((v) => `${v.startTime}〜${v.endTime}`).join('、')}` : '休み';
                    return [w, x.closures.length ? '休講あり' : '', x.reservations ? `予約${x.reservations}件` : ''].filter(Boolean).join(' ');
                  }}
                  renderDay={(d) => {
                    const x = byDate.get(d);
                    if (!x) return null;
                    return (
                      <>
                        {x.windows.length === 0 ? (
                          <CalLine full="休み" short="休" />
                        ) : (
                          x.windows.map((w) => <CalLine key={w.startTime} strong full={compactRange(w.startTime, w.endTime)} short={hourRange(w.startTime, w.endTime)} />)
                        )}
                        {x.closures.length > 0 && <CalLine full="休講" short="講" />}
                        {x.reservations > 0 && <CalLine full={`予約${x.reservations}`} short={`予${x.reservations}`} />}
                      </>
                    );
                  }}
                />
                <div className="stack-sm">
                  <p className="small secondary">曜日でまとめて選ぶ（今日より後の日だけ）</p>
                  <div className="row" role="group" aria-label="曜日でまとめて選ぶ">
                    {WEEKDAY_LABELS.map((w, i) => (
                      <button key={w} type="button" className="btn btn-secondary btn-icon" onClick={() => selectWeekday(i)} aria-label={`${w}曜日をすべて選ぶ`}>
                        {w}
                      </button>
                    ))}
                    {selected.length > 0 && (
                      <Button variant="quiet" onClick={() => setSelected([])}>
                        選択を解除
                      </Button>
                    )}
                  </div>
                </div>
              </div>
              <Panel title={selected.length ? `選んだ日（${selected.length}日）` : '日付を選んでください'}>
                {selected.length === 0 ? (
                  <p className="small secondary">カレンダーの日付を押して選びます。何日でもまとめて選べます。</p>
                ) : (
                  <div className="stack">
                    <p className="small secondary">{selected.length <= 4 ? selected.map(fmtDateKey).join('、') : `${fmtDateKey(selected[0]!)} ほか${selected.length - 1}日`}</p>
                    {affectedCount > 0 && <p className="small">選んだ日には予約が{affectedCount}件あります。受付時間の外になる予約は、確認のあと教室都合で取り消します。</p>}
                    <div className="stack-sm">
                      <p className="field-label">受け付ける時間</p>
                      {windows.map((w, i) => (
                        <div key={i} className="window-row">
                          <input aria-label={`受付時間${i + 1}の開始`} type="time" step={900} className="input" value={w.startTime} onChange={(e) => updateWindow(i, { startTime: e.target.value })} />
                          <span>〜</span>
                          <input aria-label={`受付時間${i + 1}の終了`} type="time" step={900} className="input" value={w.endTime} onChange={(e) => updateWindow(i, { endTime: e.target.value })} />
                          {windows.length > 1 && (
                            <Button variant="quiet" onClick={() => setWindows(windows.filter((_, j) => j !== i))} aria-label={`受付時間${i + 1}を削除`}>
                              削除
                            </Button>
                          )}
                        </div>
                      ))}
                      <div>
                        <Button variant="secondary" onClick={() => setWindows([...windows, { startTime: '15:00', endTime: '18:00' }])}>
                          <IconPlus size={18} />
                          時間帯を足す
                        </Button>
                      </div>
                    </div>
                    <div className="stack-sm">
                      <Button block onClick={() => void apply.run({ dates: selected, windows }, false)} pending={apply.pending} disabled={windows.length === 0}>
                        この時間で受け付ける
                      </Button>
                      <Button variant="secondary" block onClick={() => void apply.run({ dates: selected, windows: [] }, false)} disabled={apply.pending}>
                        休みにする
                      </Button>
                    </div>
                  </div>
                )}
              </Panel>
              <ConfirmDialog
                open={!!pending}
                title="予約が入っている時間があります"
                confirmLabel="予約を取り消して変更する"
                cancelLabel="変更しない"
                pending={apply.pending}
                onCancel={() => setPending(null)}
                onConfirm={() => pending && void apply.run(pending.body, true)}
              >
                {pending && (
                  <Warning title={`${pending.affected.length}件の予約が取り消されます`}>
                    <ul className="list" style={{ margin: '8px 0' }}>
                      {pending.affected.map((a) => (
                        <li key={a.reservationId}>
                          <strong>{a.studentName}</strong>　{fmtDateTime(a.startsAt)}
                        </li>
                      ))}
                    </ul>
                    <p>変更すると「教室都合のキャンセル」となり、回数を生徒に戻し、生徒にメールでお知らせします。</p>
                  </Warning>
                )}
              </ConfirmDialog>
            </div>
          );
        }}
      </Loadable>
    </div>
  );
}
