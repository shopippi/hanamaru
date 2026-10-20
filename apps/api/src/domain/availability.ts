import { and, eq, gte, inArray, lt, ne, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  availabilityExceptions,
  availabilityRules,
  closures,
  lessonTypes,
  reservations,
  schoolHours,
  teachers,
} from '../db/schema.js';
import { addDays, jst, minutesOf, weekdayOf, type DateStr } from '../lib/time.js';

// 講師の空き時間（AV-01、AV-07）から、予約できる枠を作る（AV-08）。
// 講師: 毎週の型（その日を日ごとに決めた日は型を使わない）+ その日だけの追加 − その日の不在。
// これを教室の受付時間（AV-06。日付ごと。ない日は受け付けない）の中に収め、休講（AV-04）を除く。

export interface Window {
  teacherId: string;
  date: DateStr;
  start: number; // その日の0:00からの分
  end: number;
  lessonTypeId: string;
  roomId: string | null;
  forTrial: boolean;
}

export interface Slot {
  teacherId: string;
  lessonTypeId: string;
  roomId: string | null;
  forTrial: boolean;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  booked: number;
}

export type Interval = { start: number; end: number };

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

interface AvailabilityData {
  rules: (typeof availabilityRules.$inferSelect)[];
  exceptions: (typeof availabilityExceptions.$inferSelect)[];
  closures: (typeof closures.$inferSelect)[];
  school: (typeof schoolHours.$inferSelect)[];
}

async function loadData(db: Db, teacherIds: string[], from: DateStr, to: DateStr): Promise<AvailabilityData> {
  const inRange = <T extends typeof closures.date | typeof schoolHours.date>(col: T) => and(gte(col, from), lt(col, addDays(to, 1)));
  if (teacherIds.length === 0) return { rules: [], exceptions: [], closures: [], school: [] };
  const [rules, exceptions, closureRows, school] = await Promise.all([
    db.select().from(availabilityRules).where(inArray(availabilityRules.teacherId, teacherIds)),
    db
      .select()
      .from(availabilityExceptions)
      .where(
        and(
          inArray(availabilityExceptions.teacherId, teacherIds),
          gte(availabilityExceptions.date, from),
          lt(availabilityExceptions.date, addDays(to, 1)),
        ),
      ),
    db.select().from(closures).where(inRange(closures.date)),
    db.select().from(schoolHours).where(inRange(schoolHours.date)),
  ]);
  return { rules, exceptions, closures: closureRows, school };
}

/** その日の教室の受付時間（AV-06）。ない日は空 */
export function schoolWindowsOf(rows: { date: string; startTime: string; endTime: string }[], date: DateStr): Interval[] {
  return rows
    .filter((r) => r.date === date)
    .map((r) => ({ start: minutesOf(r.startTime), end: minutesOf(r.endTime) }))
    .sort((a, b) => a.start - b.start);
}

/** 講師のその日の空き時間（教室の受付時間で切る前）。日ごとに決めた日（override）は毎週の型を使わない（AV-07） */
export function teacherWindowsOf(
  rules: (typeof availabilityRules.$inferSelect)[],
  exceptions: (typeof availabilityExceptions.$inferSelect)[],
  teacherId: string,
  date: DateStr,
): { windows: Omit<Window, 'teacherId' | 'date'>[]; overridden: boolean } {
  const mine = exceptions.filter((e) => e.teacherId === teacherId && e.date === date);
  const overridden = mine.some((e) => e.kind === 'override');
  const windows: Omit<Window, 'teacherId' | 'date'>[] = [];
  if (!overridden) {
    const weekday = weekdayOf(date);
    for (const r of rules) {
      if (r.teacherId === teacherId && r.weekday === weekday) {
        windows.push({ start: minutesOf(r.startTime), end: minutesOf(r.endTime), lessonTypeId: r.lessonTypeId, roomId: r.roomId, forTrial: r.forTrial });
      }
    }
  }
  for (const e of mine) {
    if (e.kind === 'extra' && e.startTime && e.endTime && e.lessonTypeId) {
      windows.push({ start: minutesOf(e.startTime), end: minutesOf(e.endTime), lessonTypeId: e.lessonTypeId, roomId: e.roomId, forTrial: e.forTrial });
    }
  }
  return { windows: windows.sort((a, b) => a.start - b.start), overridden };
}

function blockedIntervals(data: AvailabilityData, teacherId: string, date: DateStr): Interval[] {
  const out: Interval[] = [];
  for (const e of data.exceptions) {
    if (e.teacherId !== teacherId || e.date !== date || e.kind !== 'block') continue;
    out.push(e.startTime && e.endTime ? { start: minutesOf(e.startTime), end: minutesOf(e.endTime) } : { start: 0, end: 1440 });
  }
  for (const c of data.closures) {
    if (c.date !== date) continue;
    out.push(c.startTime && c.endTime ? { start: minutesOf(c.startTime), end: minutesOf(c.endTime) } : { start: 0, end: 1440 });
  }
  return out;
}

/** その日の予約できる時間帯（予約の有無は見ない）。講師の空き時間 ∩ 教室の受付時間（AV-08） */
function windowsFor(data: AvailabilityData, teacherId: string, date: DateStr): { windows: Window[]; blocked: Interval[] } {
  const school = schoolWindowsOf(data.school, date);
  if (school.length === 0) return { windows: [], blocked: [] };
  const windows: Window[] = [];
  for (const t of teacherWindowsOf(data.rules, data.exceptions, teacherId, date).windows) {
    for (const s of school) {
      const start = Math.max(t.start, s.start);
      const end = Math.min(t.end, s.end);
      if (start < end) windows.push({ ...t, teacherId, date, start, end });
    }
  }
  return { windows, blocked: blockedIntervals(data, teacherId, date) };
}

function* datesBetween(from: DateStr, to: DateStr): Generator<DateStr> {
  for (let d = from; d <= to; d = addDays(d, 1)) yield d;
}

/**
 * 予約が空き時間の中に収まっているかを調べる関数を返す（AV-02 で影響する予約を探すのに使う）。
 * 空き時間は from〜to の分をまとめて1回だけ読み込む
 */
export async function availabilityChecker(
  db: Db,
  teacherId: string,
  from: DateStr,
  to: DateStr,
): Promise<(r: { lessonTypeId: string; startsAt: Date; endsAt: Date }, date: DateStr) => boolean> {
  const data = await loadData(db, [teacherId], from, to);
  return (r, date) => covered(data, { ...r, teacherId }, date);
}

/** 予約が空き時間の中に収まっているか */
export async function isCoveredByAvailability(
  db: Db,
  r: { teacherId: string; lessonTypeId: string; startsAt: Date; endsAt: Date },
  date: DateStr,
): Promise<boolean> {
  return covered(await loadData(db, [r.teacherId], date, date), r, date);
}

function covered(
  data: AvailabilityData,
  r: { teacherId: string; lessonTypeId: string; startsAt: Date; endsAt: Date },
  date: DateStr,
): boolean {
  const { windows, blocked } = windowsFor(data, r.teacherId, date);
  const dayStart = jst(date).getTime();
  const iv = { start: (r.startsAt.getTime() - dayStart) / 60000, end: (r.endsAt.getTime() - dayStart) / 60000 };
  if (blocked.some((b) => overlaps(b, iv))) return false;
  return windows.some((w) => w.lessonTypeId === r.lessonTypeId && w.start <= iv.start && iv.end <= w.end);
}

/**
 * 講師ごとの予約できる枠。from〜to は日付（両端を含む）。
 * 個人レッスンは重なる予約があれば埋まり、グループは定員まで同じ枠に入れる（RS-08）。
 */
export async function listSlots(
  db: Db,
  opts: { teacherIds: string[]; from: DateStr; to: DateStr; forTrial?: boolean; excludeReservationId?: string },
): Promise<Slot[]> {
  // 無効にした講師の枠は出さない（新しい予約を止める。既存の予約は残る）
  const teacherIds = opts.teacherIds.length
    ? (await db.select({ id: teachers.id }).from(teachers).where(and(inArray(teachers.id, opts.teacherIds), eq(teachers.active, true)))).map(
        (t) => t.id,
      )
    : [];
  opts = { ...opts, teacherIds: opts.teacherIds.filter((id) => teacherIds.includes(id)) };
  const data = await loadData(db, opts.teacherIds, opts.from, opts.to);
  const types = new Map((await db.select().from(lessonTypes)).map((t) => [t.id, t]));
  const rangeStart = jst(opts.from);
  const rangeEnd = jst(addDays(opts.to, 1));

  const conds = [
    inArray(reservations.status, ['pending', 'confirmed'] as const),
    lt(reservations.startsAt, rangeEnd),
    gte(reservations.endsAt, rangeStart),
  ];
  if (opts.excludeReservationId) conds.push(ne(reservations.id, opts.excludeReservationId));
  const roomIds = [
    ...new Set([...data.rules, ...data.exceptions].map((r) => r.roomId).filter((x): x is string => !!x)),
  ];
  const teacherOrRoom =
    opts.teacherIds.length === 0
      ? undefined
      : roomIds.length > 0
        ? or(inArray(reservations.teacherId, opts.teacherIds), inArray(reservations.roomId, roomIds))
        : inArray(reservations.teacherId, opts.teacherIds);
  const booked = teacherOrRoom ? await db.select().from(reservations).where(and(...conds, teacherOrRoom)) : [];

  const slots: Slot[] = [];
  for (const teacherId of opts.teacherIds) {
    for (const date of datesBetween(opts.from, opts.to)) {
      const { windows, blocked } = windowsFor(data, teacherId, date);
      const dayStart = jst(date).getTime();
      for (const w of windows) {
        if (opts.forTrial !== undefined && w.forTrial !== opts.forTrial) continue;
        const type = types.get(w.lessonTypeId);
        if (!type || !type.active) continue;
        for (let s = w.start; s + type.durationMinutes <= w.end; s += type.durationMinutes) {
          const iv = { start: s, end: s + type.durationMinutes };
          if (blocked.some((b) => overlaps(b, iv))) continue;
          const startsAt = new Date(dayStart + iv.start * 60000);
          const endsAt = new Date(dayStart + iv.end * 60000);
          const overlapping = booked.filter(
            (r) =>
              (r.teacherId === teacherId || (w.roomId && r.roomId === w.roomId)) &&
              r.startsAt < endsAt &&
              startsAt < r.endsAt,
          );
          const sameSlot = overlapping.filter(
            (r) =>
              r.teacherId === teacherId &&
              r.lessonTypeId === w.lessonTypeId &&
              r.startsAt.getTime() === startsAt.getTime(),
          );
          // 同じ時間に別の予約（別の種別・別の講師の同じ部屋）があれば使えない
          if (overlapping.length > sameSlot.length) continue;
          const capacity = type.kind === 'group' ? type.capacity : 1;
          slots.push({
            teacherId,
            lessonTypeId: w.lessonTypeId,
            roomId: w.roomId,
            forTrial: w.forTrial,
            startsAt,
            endsAt,
            capacity,
            booked: sameSlot.length,
          });
        }
      }
    }
  }
  slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return slots;
}
