// 時刻はすべて日本時間で扱う（UI-18）。日本時間には夏時間がないため、+09:00 固定で計算する。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM' */
export type Month = string;
/** 'YYYY-MM-DD' */
export type DateStr = string;
/** 'HH:MM' */
export type TimeStr = string;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 日本時間での年月日・曜日・時分 */
export function jstParts(d: Date) {
  const j = new Date(d.getTime() + JST_OFFSET_MS);
  return {
    year: j.getUTCFullYear(),
    month: j.getUTCMonth() + 1,
    day: j.getUTCDate(),
    weekday: j.getUTCDay(),
    hour: j.getUTCHours(),
    minute: j.getUTCMinutes(),
  };
}

export function monthOf(d: Date): Month {
  const p = jstParts(d);
  return `${p.year}-${pad(p.month)}`;
}

export function dateOf(d: Date): DateStr {
  const p = jstParts(d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function timeOf(d: Date): TimeStr {
  const p = jstParts(d);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** 日本時間の日付と時刻から瞬間を作る */
export function jst(date: DateStr, time: TimeStr = '00:00'): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - JST_OFFSET_MS);
}

export function addMonths(month: Month, n: number): Month {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}

export function addDays(date: DateStr, n: number): DateStr {
  return dateOf(new Date(jst(date).getTime() + n * DAY_MS));
}

export function weekdayOf(date: DateStr): number {
  return jstParts(jst(date)).weekday;
}

/** その月の1日 0:00（日本時間） */
export function startOfMonth(month: Month): Date {
  return jst(`${month}-01`);
}

/**
 * 月額の自動課金の基準時刻（Stripe の課金日）。その月の1日 9:00（日本時間）= 1日 0:00（UTC）。
 * Stripe は基準時刻の UTC の日付で毎月の課金日を決めるため、日本時間の1日 0:00（UTC では前月末）を
 * 基準にすると、30日・28日始まりの月で課金日が前月末にずれる。UTC でも1日になる時刻にする。
 */
export function billingAnchor(month: Month): Date {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1));
}

/**
 * Stripe の請求期間の開始から、どの月の月謝かを求める。
 * 課金日が前後に数日ずれても、いちばん近い月の1日（日本時間）の月とする。
 */
export function billingMonthOf(periodStart: Date): Month {
  const m = monthOf(periodStart);
  const next = addMonths(m, 1);
  const toThis = Math.abs(periodStart.getTime() - startOfMonth(m).getTime());
  const toNext = Math.abs(startOfMonth(next).getTime() - periodStart.getTime());
  return toNext < toThis ? next : m;
}

export function minutesOf(t: TimeStr): number {
  const [h, m] = t.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

export function timeFromMinutes(min: number): TimeStr {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

export const HOUR_MS = 60 * 60 * 1000;
export { DAY_MS };

const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** 「10月20日（火） 15:00」（UI-18） */
export function formatJa(d: Date, withTime = true): string {
  const p = jstParts(d);
  const date = `${p.month}月${p.day}日（${WEEKDAYS_JA[p.weekday]}）`;
  return withTime ? `${date} ${pad(p.hour)}:${pad(p.minute)}` : date;
}
