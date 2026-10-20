import type { ReactNode } from 'react';
import { IconChevronLeft, IconChevronRight } from './icons.js';
import { fmtDateKey, fmtMonth, WEEKDAY_LABELS, weekdayOfKey } from './format.js';

// 月のカレンダー（AV-06、AV-07）。教室の受付日と講師の空き時間の設定で同じ部品を使う（UI-06）

/** 'YYYY-MM' を n か月ずらす */
export const shiftMonthKey = (m: string, n: number) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const idx = y * 12 + mo - 1 + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
};

/** その月の日付（'YYYY-MM-DD'）を並べる */
export const datesOfMonth = (m: string) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const n = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${m}-${String(i + 1).padStart(2, '0')}`);
};

/** 時間帯を短く書く（カレンダーのマスの中）。10:00〜21:00 → 10–21、10:30〜13:00 → 10:30–13 */
export const compactRange = (start: string, end: string) => `${start.replace(/:00$/, '')}–${end.replace(/:00$/, '')}`;
/** スマホの狭いマス用に、時だけで書く。10:30〜13:00 → 10–13 */
export const hourRange = (start: string, end: string) => `${Number(start.slice(0, 2))}–${Number(end.slice(0, 2)) + (end.endsWith(':00') ? 0 : 1)}`;

/** マスの中の1行。スマホでは短い書き方（short）を出す */
export function CalLine({ full, short, strong }: { full: string; short?: string; strong?: boolean }) {
  return (
    <span className={strong ? 'cal-line strong' : 'cal-line'}>
      <span className="cal-full">{full}</span>
      <span className="cal-short">{short ?? full}</span>
    </span>
  );
}

export function MonthCalendar({
  month,
  onMonth,
  today,
  renderDay,
  describeDay,
  isSelected,
  isMuted,
  onPick,
}: {
  month: string;
  onMonth: (m: string) => void;
  /** 今日（'YYYY-MM-DD'）。これより前の日は押せない */
  today: string;
  /** マスの中に出す短い内容 */
  renderDay: (date: string) => ReactNode;
  /** 読み上げ用の説明（日付のあとに続ける） */
  describeDay: (date: string) => string;
  isSelected: (date: string) => boolean;
  /** 教室の休みなど、薄く出す日 */
  isMuted?: (date: string) => boolean;
  onPick: (date: string) => void;
}) {
  const dates = datesOfMonth(month);
  const lead = weekdayOfKey(dates[0]!);
  return (
    <div className="cal">
      <div className="cal-head">
        <button type="button" className="btn btn-secondary btn-icon" aria-label="前の月" onClick={() => onMonth(shiftMonthKey(month, -1))}>
          <IconChevronLeft />
        </button>
        <h2 className="cal-title" aria-live="polite">
          {fmtMonth(month)}
        </h2>
        <button type="button" className="btn btn-secondary btn-icon" aria-label="次の月" onClick={() => onMonth(shiftMonthKey(month, 1))}>
          <IconChevronRight />
        </button>
      </div>
      <div className="cal-grid" role="group" aria-label={`${fmtMonth(month)}のカレンダー`}>
        {WEEKDAY_LABELS.map((w, i) => (
          <span key={w} className={`cal-weekday${i === 0 ? ' sun' : ''}`} aria-hidden="true">
            {w}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={`lead-${i}`} aria-hidden="true" />
        ))}
        {dates.map((d) => {
          const past = d < today;
          return (
            <button
              key={d}
              type="button"
              className={['cal-day', isMuted?.(d) ? 'muted' : '', d === today ? 'today' : ''].join(' ').trim()}
              aria-pressed={isSelected(d)}
              aria-label={`${fmtDateKey(d)} ${describeDay(d)}`}
              disabled={past}
              onClick={() => onPick(d)}
            >
              <span className="cal-day-num">{Number(d.slice(8))}</span>
              <span className="cal-day-body">{renderDay(d)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
