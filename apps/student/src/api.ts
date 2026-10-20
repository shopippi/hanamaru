import { createApi } from '@hanamaru/ui';

export const api = createApi('/api', {
  // ログインが切れていたらログイン画面へ（ST-06）
  onLoginRequired: () => {
    if (!location.pathname.startsWith('/login')) location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  },
});

/** 公開トップに置く利用規約のページ。入会時の同意（3.11）でリンクする */
export const TERMS_URL = import.meta.env.VITE_TERMS_URL as string | undefined;
export const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

export interface StudentSummary {
  id: string;
  name: string;
  status: string;
}

export interface Home {
  student: { id: string; name: string; status: string; scheduledStatus: string | null; scheduledStatusAt: string | null };
  month: string;
  remaining: number;
  nextMonth: { month: string; remaining: number };
  nextReservation: { id: string; startsAt: string; endsAt: string; status: string; teacherName: string; lessonTypeName: string } | null;
  payment: 'paid' | 'confirming' | 'unpaid' | 'failed' | 'none';
  autopay: boolean;
  /** カード払いなのにカードが未登録。登録をお願いする（PY-03） */
  needsCard: boolean;
  /** 今月分のカード払いを、自動課金ではなく自分で払う月 */
  cardPaymentDue: boolean;
  /** コンビニ・PayPay の今月分の決済画面を開ける（PY-16） */
  paymentLinkAvailable: boolean;
  course: { name: string; lessonsPerMonth: number } | null;
  blocker: string | null;
}

export interface TeacherProfile {
  teacherId: string;
  name: string;
  photo: string | null;
  instruments: string[];
  career: string;
  message: string;
}

export interface Slot {
  teacherId: string;
  lessonTypeId: string;
  startsAt: string;
  endsAt: string;
}

export interface Reservation {
  id: string;
  teacherId: string;
  teacherName: string;
  lessonTypeName: string;
  startsAt: string;
  endsAt: string;
  status: 'pending' | 'confirmed' | 'cancelled';
  cancelKind: string | null;
  attendance: string;
}

export interface LessonType {
  id: string;
  name: string;
  kind: string;
  durationMinutes: number;
}
