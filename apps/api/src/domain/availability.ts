import { and, eq, gte, inArray, lt, ne, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  availabilityExceptions,
  availabilityRules,
  closures,
  lessonTypes,
  reservations,
} from '../db/schema.js';
import { addDays, jst, minutesOf, weekdayOf, type DateStr } from '../lib/time.js';
import { getSettings, type Settings } from './settings.js';

// 講師の空き時間（AV-01）から、予約できる枠を作る。
// 曜日ごとの時間帯 + その日だけの追加 − その日の不在 − 休講（AV-04）、を営業時間（3.8）の範囲に収める。

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

type Interval = { start: number; end: number };

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

interface AvailabilityData {
  rules: (typeof availabilityRules.$inferSelect)[];
  exceptions: (typeof availabilityExceptions.$inferSelect)[];
  closures: (typeof closures.$inferSelect)[];
  settings: Settings;
}

async function loadData(db: Db, teacherIds: string[], from: DateStr, to: DateStr): Promise<AvailabilityData> {
  if (teacherIds.length === 0) return { rules: [], exceptions: [], closures: [], settings: await getSettings(db) };
  const [rules, exceptions, closureRows, settings] = await Promise.all([
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
    db.select().from(closures).where(and(gte(closures.date, from), lt(closures.date, addDays(to, 1)))),
    getSettings(db),
  ]);
  return { rules, exceptions, closures: closureRows, settings };
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

/** その日の空き時間帯（予約の有無は見ない） */
function windowsFor(data: AvailabilityData, teacherId: string, date: DateStr): { windows: Window[]; blocked: Interval[] } {
  const weekday = weekdayOf(date);
  const hours = data.settings.businessHours[weekday];
  if (!hours) return { windows: [], blocked: [] };
  const open = minutesOf(hours.open);
  const close = minutesOf(hours.close);
  const windows: Window[] = [];
  const push = (start: number, end: number, lessonTypeId: string | null, roomId: string | null, forTrial: boolean) => {
    const s = Math.max(start, open);
    const e = Math.min(end, close);
    if (lessonTypeId && s < e) windows.push({ teacherId, date, start: s, end: e, lessonTypeId, roomId, forTrial });
  };
  for (const r of data.rules) {
    if (r.teacherId === teacherId && r.weekday === weekday) {
      push(minutesOf(r.startTime), minutesOf(r.endTime), r.lessonTypeId, r.roomId, r.forTrial);
    }
  }
  for (const e of data.exceptions) {
    if (e.teacherId === teacherId && e.date === date && e.kind === 'extra' && e.startTime && e.endTime) {
      push(minutesOf(e.startTime), minutesOf(e.endTime), e.lessonTypeId, e.roomId, e.forTrial);
    }
  }
  return { windows, blocked: blockedIntervals(data, teacherId, date) };
}

function* datesBetween(from: DateStr, to: DateStr): Generator<DateStr> {
  for (let d = from; d <= to; d = addDays(d, 1)) yield d;
}

/** 予約が空き時間の中に収まっているか（AV-02 で影響する予約を探すのに使う） */
export async function isCoveredByAvailability(
  db: Db,
  r: { teacherId: string; lessonTypeId: string; startsAt: Date; endsAt: Date },
  date: DateStr,
): Promise<boolean> {
  const data = await loadData(db, [r.teacherId], date, date);
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
