import { useState } from 'react';
import { Button, ConfirmDialog, Empty, Loadable, Notice, Panel, Skeleton, Warning, useToast } from './components.js';
import { IconClock, IconPlus } from './icons.js';
import { fmtDateKey, fmtDateTime, WEEKDAY_LABELS } from './format.js';
import { useAction, useLoad } from './hooks.js';

// 講師の空き時間の設定（AV-01〜03）。講師の画面と管理画面で同じ部品を使う（UI-06）

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
  lessonTypes,
  allowTrial,
}: {
  load: () => Promise<{ rules: AvRule[]; exceptions: AvException[] }>;
  save: (change: AvChange, confirm: boolean) => Promise<AvResult>;
  lessonTypes: AvLessonType[];
  /** 体験専用の枠（TR-02）を設定できるか（管理者だけ） */
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
              title="曜日ごとの空き時間"
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
            <ExceptionSection data={data} types={types} onSubmit={(c) => void submit.run(c, false)} pending={submit.pending} />
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

function ExceptionSection({
  data,
  types,
  onSubmit,
  pending,
}: {
  data: { exceptions: AvException[] };
  types: AvLessonType[];
  onSubmit: (change: AvChange) => void;
  pending: boolean;
}) {
  const [date, setDate] = useState('');
  const [kind, setKind] = useState<'block' | 'extra'>('block');
  const [allDay, setAllDay] = useState(true);
  const [start, setStart] = useState('15:00');
  const [end, setEnd] = useState('18:00');
  const [lessonTypeId, setLessonTypeId] = useState(types[0]?.id ?? '');
  const add = () => {
    if (!date) return;
    const timed = kind === 'extra' || !allDay;
    onSubmit({
      addExceptions: [
        {
          date,
          kind,
          startTime: timed ? start : null,
          endTime: timed ? end : null,
          lessonTypeId: kind === 'extra' ? lessonTypeId : null,
          roomId: null,
          forTrial: false,
        },
      ],
    });
  };
  return (
    <Panel title="日付ごとの例外" flush>
      <div className="panel-body">
        <Notice>お休みの日（不在）や、その日だけ空いている時間を設定します。</Notice>
      </div>
      {data.exceptions.length > 0 && (
        <ul className="list panel-divider">
          {data.exceptions.map((e) => (
            <li key={e.id} className="spread">
              <span className="row-tight" style={{ alignItems: 'center' }}>
                <strong className="num">{fmtDateKey(e.date)}</strong>
                <span className={e.kind === 'block' ? 'badge badge-strong' : 'badge'}>{e.kind === 'block' ? '不在' : '追加'}</span>
                <span className="num secondary">{e.startTime ? `${e.startTime}〜${e.endTime}` : '終日'}</span>
              </span>
              <Button variant="quiet" onClick={() => onSubmit({ removeExceptionIds: [e.id!] })}>
                削除
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="panel-body panel-divider stack">
        <div className="row">
          <label className="field-label" htmlFor="ex-date" style={{ margin: 0 }}>
            日付
          </label>
          <input id="ex-date" type="date" className="input" style={{ width: 'auto' }} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="row" role="radiogroup" aria-label="種類">
          <label className="checkbox">
            <input type="radio" name="ex-kind" checked={kind === 'block'} onChange={() => setKind('block')} /> 不在
          </label>
          <label className="checkbox">
            <input type="radio" name="ex-kind" checked={kind === 'extra'} onChange={() => setKind('extra')} /> その日だけ追加
          </label>
          {kind === 'block' && (
            <label className="checkbox">
              <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> 終日
            </label>
          )}
        </div>
        {(kind === 'extra' || !allDay) && (
          <div className="row">
            <input aria-label="開始" type="time" step={900} className="input" style={{ width: 'auto' }} value={start} onChange={(e) => setStart(e.target.value)} />
            <span>〜</span>
            <input aria-label="終了" type="time" step={900} className="input" style={{ width: 'auto' }} value={end} onChange={(e) => setEnd(e.target.value)} />
            {kind === 'extra' && (
              <select aria-label="レッスン種別" className="select" style={{ width: 'auto' }} value={lessonTypeId} onChange={(e) => setLessonTypeId(e.target.value)}>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
        <div>
          <Button variant="secondary" onClick={add} disabled={!date} pending={pending}>
            <IconPlus size={18} />
            例外を追加する
          </Button>
        </div>
      </div>
    </Panel>
  );
}
