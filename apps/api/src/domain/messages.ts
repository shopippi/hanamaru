import { formatJa } from '../lib/time.js';
import type { Message } from './notify.js';

// 通知の文面。金額は税込の総額で書く（MB-03）

const SIGNATURE = '\n\n--\nはなまる音楽教室';

const lesson = (r: { studentName: string; teacherName: string; startsAt: Date }) =>
  `生徒: ${r.studentName}\n日時: ${formatJa(r.startsAt)}\n講師: ${r.teacherName}`;

type R = { studentName: string; teacherName: string; startsAt: Date };

export const messages = {
  reservationConfirmed: (r: R, pending: boolean): Message => ({
    subject: pending ? '【仮予約】レッスンの予約を受け付けました' : '【予約確定】レッスンの予約が確定しました',
    body:
      (pending
        ? '次のレッスンを仮予約として受け付けました。教室が確認すると確定します。\n\n'
        : '次のレッスンの予約が確定しました。\n\n') +
      lesson(r) +
      SIGNATURE,
  }),
  reservationApproved: (r: R): Message => ({
    subject: '【予約確定】レッスンの予約が確定しました',
    body: '仮予約していた次のレッスンが確定しました。\n\n' + lesson(r) + SIGNATURE,
  }),
  reservationChanged: (r: R, from: Date): Message => ({
    subject: '【予約変更】レッスンの日時を変更しました',
    body: `レッスンの日時を変更しました。\n\n変更前: ${formatJa(from)}\n` + lesson(r) + SIGNATURE,
  }),
  reservationCancelled: (r: R, reason: string, refunded: boolean): Message => ({
    subject: '【予約キャンセル】レッスンの予約を取り消しました',
    body:
      `次のレッスンの予約を取り消しました（${reason}）。\n\n` +
      lesson(r) +
      `\n\n回数: ${refunded ? '1回お戻ししました' : '締切後のため戻りません'}` +
      SIGNATURE,
  }),
  trialCancelled: (r: R, reason: string): Message => ({
    subject: '【予約キャンセル】体験レッスンの予約を取り消しました',
    body:
      `${r.studentName} 様\n\n次の体験レッスンの予約を取り消しました（${reason}）。\n` +
      `ご迷惑をおかけし申し訳ありません。日程の調整は教室からご連絡します。\n\n` +
      lesson(r) +
      SIGNATURE,
  }),
  reservationReminder: (r: R): Message => ({
    subject: '【明日のレッスン】ご予約のお知らせ',
    body: '明日のレッスンのお知らせです。\n\n' + lesson(r) + SIGNATURE,
  }),
};

export const CANCEL_REASON_LABEL: Record<string, string> = {
  student: 'ご本人のキャンセル',
  student_late: 'ご本人のキャンセル（締切後）',
  teacher: '講師の都合',
  school: '教室の都合・休講',
  admin: '教室での取消',
  rejected: '予約を承認できなかったため',
  unpaid: 'お支払いが確認できなかったため',
  rescheduled: '日時の変更',
};
