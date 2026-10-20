// 表示の形式（UI-18）。日付は「10月20日（火）」、時刻は「15:00」。すべて日本時間

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const JST = 9 * 60 * 60 * 1000;

function parts(d: Date | string) {
  const j = new Date(new Date(d).getTime() + JST);
  return { y: j.getUTCFullYear(), m: j.getUTCMonth() + 1, d: j.getUTCDate(), w: j.getUTCDay(), h: j.getUTCHours(), min: j.getUTCMinutes() };
}
const pad = (n: number) => String(n).padStart(2, '0');

export const fmtDate = (d: Date | string) => {
  const p = parts(d);
  return `${p.m}月${p.d}日（${WEEKDAYS[p.w]}）`;
};
export const fmtTime = (d: Date | string) => {
  const p = parts(d);
  return `${pad(p.h)}:${pad(p.min)}`;
};
export const fmtDateTime = (d: Date | string) => `${fmtDate(d)} ${fmtTime(d)}`;
export const fmtTimeRange = (a: Date | string, b: Date | string) => `${fmtTime(a)}〜${fmtTime(b)}`;
export const fmtMonth = (m: string) => `${Number(m.slice(0, 4))}年${Number(m.slice(5))}月`;
export const fmtMonthShort = (m: string) => `${Number(m.slice(5))}月`;

/** 金額はすべて税込の総額（MB-03） */
export const fmtYen = (n: number) => `${n.toLocaleString('ja-JP')}円`;

/** 日本時間の 'YYYY-MM-DD' */
export const dateKey = (d: Date | string) => {
  const p = parts(d);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
};
export const monthKey = (d: Date | string) => dateKey(d).slice(0, 7);
export const addDaysKey = (key: string, n: number) => {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return dateKey(new Date(Date.UTC(y, m - 1, d + n) - JST + 12 * 3600 * 1000));
};
export const weekdayOfKey = (key: string) => {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
export const fmtDateKey = (key: string) => {
  const [, m, d] = key.split('-').map(Number) as [number, number, number];
  return `${m}月${d}日（${WEEKDAYS[weekdayOfKey(key)]}）`;
};
export const WEEKDAY_LABELS = WEEKDAYS;

export const STUDENT_STATUS_LABEL: Record<string, string> = {
  trial: '体験',
  enrolling: '入会手続き中',
  active: '在籍中',
  suspended: '休会中',
  withdrawn: '退会',
};
export const METHOD_LABEL: Record<string, string> = { card: 'カード', konbini: 'コンビニ', paypay: 'PayPay', cash: '現金' };
