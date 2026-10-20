import { useState } from 'react';
import { Button, ConfirmDialog, Empty, Loadable, Notice, Panel, Segmented, Skeleton, Warning, useToast } from './components.js';
import { IconClock, IconPlus } from './icons.js';
import { fmtDateKey, fmtDateTime, monthKey, WEEKDAY_LABELS } from './format.js';
import { useAction, useLoad } from './hooks.js';
import { CalLine, compactRange, hourRange, MonthCalendar } from './month-calendar.js';

// 講師の空き時間の設定（AV-01〜03、AV-07）。講師の画面と管理画面で同じ部品を使う（UI-06）。
// 「カレンダー」で日ごとに決め、「毎週の型」で毎週同じ時間を決める。日ごとに決めた日は毎週の型を使わない

export interface AvRule {
  weekday: number;
  startTime: string;
  endTime: string;
  lessonTypeId: string;
  roomId: string | null;
  forTrial: boolean;
}
export interface AvException {
  id?: string;
  date: string;
  kind: 'block' | 'extra';
  startTime: string | null;
  endTime: string | null;
  lessonTypeId: string | null;
  roomId: string | null;
  forTrial: boolean;
}
export interface AvLessonType {
  id: string;
  name: string;
  active: boolean;
}
export interface AvChange {
  rules?: AvRule[];
  addExceptions?: AvException[];
  removeExceptionIds?: string[];
}
export interface AvResult {
  applied: boolean;
  affected: { reservationId: string; studentName: string; startsAt: string }[];
}
export interface AvDayWindow {
  startTime: string;
  endTime: string;
  lessonTypeId: string;
  roomId: string | null;
  forTrial: boolean;
}
export interface AvCalendarDay {
  date: string;
  /** その日を日ごとに決めたか（毎週の型を使わない） */
  overridden: boolean;
  windows: AvDayWindow[];
  blocks: { startTime: string | null; endTime: string | null }[];
  /** 教室の受付時間（AV-06）。空なら教室は休み */
  school: { startTime: string; endTime: string }[];
  closures: { startTime: string | null; endTime: string | null; reason: string }[];
  reservations: number;
}
export interface AvCalendar {
  month: string;
  today: string;
  days: AvCalendarDay[];
}
/** windows=null で毎週の型に戻す */
export interface AvDayInput {
  date: string;
  windows: AvDayWindow[] | null;
}

const strip = (r: AvRule): AvRule => ({
  weekday: r.weekday,
  startTime: r.startTime,
  endTime: r.endTime,
  lessonTypeId: r.lessonTypeId,
  roomId: r.roomId,
  forTrial: r.forTrial,
});

export function AvailabilityEditor({
  load,
  save,
  loadCalendar,
  saveDay,
  lessonTypes,
  allowTrial,
}: {
  load: () => Promise<{ rules: AvRule[]; exceptions: AvException[] }>;
  save: (change: AvChange, confirm: boolean) => Promise<AvResult>;
  loadCalendar: (month: string) => Promise<AvCalendar>;
  saveDay: (input: AvDayInput, confirm: boolean) => Promise<AvResult>;
  lessonTypes: AvLessonType[];
  /** 体験専用の枠（TR-02）を設定できるか（管理者だけ） */
  allowTrial?: boolean;
}) {
  const [tab, setTab] = useState<'calendar' | 'weekly'>('calendar');
  return (
    <div className="stack-lg">
      <Segmented label="設定のしかた" value={tab} options={[['calendar', 'カレンダー'], ['weekly', '毎週の型']] as const} onChange={setTab} />
      {tab === 'calendar' ? (
        <CalendarEditor loadCalendar={loadCalendar} saveDay={saveDay} lessonTypes={lessonTypes} allowTrial={allowTrial} />
      ) : (
        <WeeklyEditor load={load} save={save} lessonTypes={lessonTypes} allowTrial={allowTrial} />
      )}
    </div>
  );
}

function WeeklyEditor({
  load,
  save,
  lessonTypes,
  allowTrial,
}: {
  load: () => Promise<{ rules: AvRule[]; exceptions: AvException[] }>;
  save: (change: AvChange, confirm: boolean) => Promise<AvResult>;
  lessonTypes: AvLessonType[];
  allowTrial?: boolean;
}) {
  const toast = useToast();
  const { state, reload } = useLoad(load, []);
  const [rules, setRules] = useState<AvRule[] | null>(null);
  const [pendingChange, setPendingChange] = useState<{ change: AvChange; affected: AvResult['affected'] } | null>(null);
  const types = lessonTypes.filter((t) => t.active);

  const submit = useAction(async (change: AvChange, confirm: boolean) => {
    try {
      const res = await save(change, confirm);
      if (!res.applied) {
        // 予約が入っている時間帯にかかる変更は、件数・生徒名・日時を並べて確認する（AV-02）
        setPendingChange({ change, affected: res.affected });
        return;
      }
      setPendingChange(null);
      toast(res.affected.length ? `変更しました。${res.affected.length}件の予約を講師都合で取り消しました` : '変更しました');
      setRules(null);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '変更できませんでした', 'error');
    }
  });

  return (
    <Loadable state={state} reload={reload} skeleton={<Skeleton lines={8} />}>
      {(data) => {
        const current = rules ?? data.rules.map(strip).sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));
        const update = (i: number, patch: Partial<AvRule>) => setRules(current.map((r, j) => (j === i ? { ...r, ...patch } : r)));
        return (
          <div className="stack-lg">
            <Panel
              title="曜日ごとの空き時間（毎週の型）"
              flush
              footer={
                <>
                  <Button
                    variant="secondary"
                    disabled={types.length === 0}
                    onClick={() => setRules([...current, { weekday: 1, startTime: '15:00', endTime: '18:00', lessonTypeId: types[0]?.id ?? '', roomId: null, forTrial: false }])}
                  >
                    <IconPlus size={18} />
                    時間帯を足す
                  </Button>
                  <Button onClick={() => void submit.run({ rules: current }, false)} pending={submit.pending} disabled={rules === null}>
                    保存する
                  </Button>
                </>
              }
            >
              {current.length === 0 && <Empty icon={<IconClock />} message="空き時間がありません" text="「時間帯を足す」から追加してください。" />}
              {current.map((r, i) => (
                <div key={i} className="rule-row">
                  <div className="row">
                    <label className="visually-hidden" htmlFor={`wd-${i}`}>
                      曜日
                    </label>
                    <select id={`wd-${i}`} className="select" style={{ width: 'auto' }} value={r.weekday} onChange={(e) => update(i, { weekday: Number(e.target.value) })}>
                      {WEEKDAY_LABELS.map((w, n) => (
                        <option key={n} value={n}>
                          {w}曜日
                        </option>
                      ))}
                    </select>
                    <label className="visually-hidden" htmlFor={`st-${i}`}>
                      開始
                    </label>
                    <input id={`st-${i}`} type="time" step={900} className="input" style={{ width: 'auto' }} value={r.startTime} onChange={(e) => update(i, { startTime: e.target.value })} />
                    <span>〜</span>
                    <label className="visually-hidden" htmlFor={`et-${i}`}>
                      終了
                    </label>
                    <input id={`et-${i}`} type="time" step={900} className="input" style={{ width: 'auto' }} value={r.endTime} onChange={(e) => update(i, { endTime: e.target.value })} />
                  </div>
                  <div className="row">
                    <label className="visually-hidden" htmlFor={`lt-${i}`}>
                      レッスン種別
                    </label>
                    <select id={`lt-${i}`} className="select" style={{ width: 'auto' }} value={r.lessonTypeId} onChange={(e) => update(i, { lessonTypeId: e.target.value })}>
                      {types.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    {allowTrial && (
                      <label className="checkbox">
                        <input type="checkbox" checked={r.forTrial} onChange={(e) => update(i, { forTrial: e.target.checked })} />
                        体験専用
                      </label>
                    )}
                    {!allowTrial && r.forTrial && <span className="badge">体験専用</span>}
                    <Button variant="quiet" onClick={() => setRules(current.filter((_, j) => j !== i))}>
                      削除
                    </Button>
                  </div>
                </div>
              ))}
            </Panel>
            <Notice>毎週の型は、カレンダーで日ごとに決めていない日に使います。教室の受付時間の外は予約を受け付けません。</Notice>
            <ConfirmDialog
              open={!!pendingChange}
              title="予約が入っている時間帯があります"
              confirmLabel="予約を取り消して変更する"
              cancelLabel="変更しない"
              pending={submit.pending}
              onCancel={() => setPendingChange(null)}
              onConfirm={() => pendingChange && void submit.run(pendingChange.change, true)}
            >
              {pendingChange && (
                <Warning title={`${pendingChange.affected.length}件の予約が取り消されます`}>
                  <ul className="list" style={{ margin: '8px 0' }}>
                    {pendingChange.affected.map((a) => (
                      <li key={a.reservationId}>
                        <strong>{a.studentName}</strong>　{fmtDateTime(a.startsAt)}
                      </li>
                    ))}
                  </ul>
                  <p>変更すると「講師都合のキャンセル」となり、回数を生徒に戻し、生徒と教室にメールでお知らせします。</p>
                </Warning>
              )}
            </ConfirmDialog>
          </div>
        );
      }}
    </Loadable>
  );
}

/** 1日の時間帯を、開始・終了・レッスン種別で編集する */
function DayWindowRows({
  windows,
  onChange,
  types,
  allowTrial,
}: {
  windows: AvDayWindow[];
  onChange: (w: AvDayWindow[]) => void;
  types: AvLessonType[];
  allowTrial?: boolean;
}) {
  const update = (i: number, patch: Partial<AvDayWindow>) => onChange(windows.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  return (
    <div className="stack-sm">
      {windows.map((w, i) => (
        <div key={i} className="window-row">
          <input aria-label={`時間帯${i + 1}の開始`} type="time" step={900} className="input" value={w.startTime} onChange={(e) => update(i, { startTime: e.target.value })} />
          <span>〜</span>
          <input aria-label={`時間帯${i + 1}の終了`} type="time" step={900} className="input" value={w.endTime} onChange={(e) => update(i, { endTime: e.target.value })} />
          <select aria-label={`時間帯${i + 1}のレッスン種別`} className="select" value={w.lessonTypeId} onChange={(e) => update(i, { lessonTypeId: e.target.value })}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {allowTrial && (
            <label className="checkbox">
              <input type="checkbox" checked={w.forTrial} onChange={(e) => update(i, { forTrial: e.target.checked })} />
              体験専用
            </label>
          )}
          <Button variant="quiet" onClick={() => onChange(windows.filter((_, j) => j !== i))} aria-label={`時間帯${i + 1}を削除`}>
            削除
          </Button>
        </div>
      ))}
      <div>
        <Button
          variant="secondary"
          disabled={types.length === 0}
          onClick={() => onChange([...windows, { startTime: '15:00', endTime: '18:00', lessonTypeId: types[0]?.id ?? '', roomId: null, forTrial: false }])}
        >
          <IconPlus size={18} />
          時間帯を足す
        </Button>
      </div>
    </div>
  );
}

/** カレンダーで、講師の空き時間を日ごとに決める（AV-07） */
function CalendarEditor({
  loadCalendar,
  saveDay,
  lessonTypes,
  allowTrial,
}: {
  loadCalendar: (month: string) => Promise<AvCalendar>;
  saveDay: (input: AvDayInput, confirm: boolean) => Promise<AvResult>;
  lessonTypes: AvLessonType[];
  allowTrial?: boolean;
}) {
  const toast = useToast();
  const types = lessonTypes.filter((t) => t.active);
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const { state, reload } = useLoad(() => loadCalendar(month), [month]);
  const [picked, setPicked] = useState<string | null>(null);
  const [draft, setDraft] = useState<AvDayWindow[]>([]);
  const [pending, setPending] = useState<{ input: AvDayInput; affected: AvResult['affected'] } | null>(null);

  const submit = useAction(async (input: AvDayInput, confirm: boolean) => {
    try {
      const res = await saveDay(input, confirm);
      if (!res.applied) {
        setPending({ input, affected: res.affected });
        return;
      }
      setPending(null);
      toast(
        res.affected.length
          ? `${fmtDateKey(input.date)}を変更しました。${res.affected.length}件の予約を講師都合で取り消しました`
          : `${fmtDateKey(input.date)}の空き時間を変更しました`,
      );
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '変更できませんでした', 'error');
    }
  });

  return (
    <Loadable state={state} reload={reload} skeleton={<Skeleton lines={10} />}>
      {(cal) => {
        const byDate = new Map(cal.days.map((d) => [d.date, d]));
        const day = picked ? byDate.get(picked) : undefined;
        const describe = (d: string) => {
          const x = byDate.get(d);
          if (!x) return '';
          if (x.school.length === 0) return '教室は休み';
          const t = x.windows.length ? `空き ${x.windows.map((w) => `${w.startTime}〜${w.endTime}`).join('、')}` : '空きなし';
          return [t, x.overridden ? 'この日だけの設定' : '', x.reservations ? `予約${x.reservations}件` : ''].filter(Boolean).join(' ');
        };
        return (
          <div className="cal-layout">
            <div>
              <MonthCalendar
                month={month}
                onMonth={(m) => (setMonth(m), setPicked(null))}
                today={cal.today}
                isSelected={(d) => d === picked}
                isMuted={(d) => (byDate.get(d)?.school.length ?? 0) === 0}
                describeDay={describe}
                onPick={(d) => {
                  setPicked(d);
                  setDraft(byDate.get(d)?.windows ?? []);
                }}
                renderDay={(d) => {
                  const x = byDate.get(d);
                  if (!x) return null;
                  if (x.school.length === 0) return <CalLine full="教室休み" short="休" />;
                  const more = x.windows.length > 1 ? ` +${x.windows.length - 1}` : '';
                  return (
                    <>
                      {x.windows.length === 0 ? (
                        <CalLine full="空きなし" short="なし" />
                      ) : (
                        <CalLine
                          strong
                          full={compactRange(x.windows[0]!.startTime, x.windows[0]!.endTime) + more}
                          short={hourRange(x.windows[0]!.startTime, x.windows[0]!.endTime) + (more ? '+' : '')}
                        />
                      )}
                      {x.overridden && <CalLine full="日ごと" short="日" />}
                      {x.reservations > 0 && <CalLine full={`予約${x.reservations}`} short={`予${x.reservations}`} />}
                    </>
                  );
                }}
              />
              <p className="cal-legend">
                <span>太字: その日の空き時間</span>
                <span>日ごと（日）: その日だけ決めた日</span>
                <span>薄い日（休）: 教室が休み</span>
                <span>予約（予）: 入っている予約</span>
              </p>
            </div>
            <Panel title={day ? fmtDateKey(day.date) : '日付を選んでください'}>
              {!day ? (
                <p className="secondary small">カレンダーの日付を押すと、その日の空き時間を決められます。決めていない日は「毎週の型」を使います。</p>
              ) : (
                <div className="stack">
                  {day.school.length === 0 ? (
                    <Warning title="この日は教室が休みです">空き時間を入れても、予約は受け付けません。</Warning>
                  ) : (
                    <p className="small secondary">教室の受付: {day.school.map((w) => `${w.startTime}〜${w.endTime}`).join('、')}</p>
                  )}
                  {day.closures.length > 0 && <p className="small secondary">休講: {day.closures.map((c) => (c.startTime ? `${c.startTime}〜${c.endTime}` : '終日')).join('、')}</p>}
                  <p className="small">
                    {day.overridden ? <span className="badge badge-strong">この日だけの設定</span> : <span className="badge">毎週の型</span>}
                    {day.reservations > 0 && <span className="badge badge-muted" style={{ marginLeft: 6 }}>予約{day.reservations}件</span>}
                  </p>
                  <DayWindowRows windows={draft} onChange={setDraft} types={types} allowTrial={allowTrial} />
                  {draft.length === 0 && <p className="small secondary">時間帯がないまま保存すると、この日は空いていない日になります。</p>}
                  <div className="stack-sm">
                    <Button block onClick={() => void submit.run({ date: day.date, windows: draft }, false)} pending={submit.pending}>
                      この日の空き時間を保存
                    </Button>
                    {draft.length > 0 && (
                      <Button variant="secondary" block onClick={() => void submit.run({ date: day.date, windows: [] }, false)} disabled={submit.pending}>
                        この日は休みにする
                      </Button>
                    )}
                    {day.overridden && (
                      <Button variant="quiet" block onClick={() => void submit.run({ date: day.date, windows: null }, false)} disabled={submit.pending}>
                        毎週の型に戻す
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </Panel>
            <ConfirmDialog
              open={!!pending}
              title="予約が入っている時間帯があります"
              confirmLabel="予約を取り消して変更する"
              cancelLabel="変更しない"
              pending={submit.pending}
              onCancel={() => setPending(null)}
              onConfirm={() => pending && void submit.run(pending.input, true)}
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
                  <p>変更すると「講師都合のキャンセル」となり、回数を生徒に戻し、生徒と教室にメールでお知らせします。</p>
                </Warning>
              )}
            </ConfirmDialog>
          </div>
        );
      }}
    </Loadable>
  );
}
