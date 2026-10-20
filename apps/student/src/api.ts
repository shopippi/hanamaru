import { createApi } from '@hanamaru/ui';

export const api = createApi('/api', {
  // ログインが切れていたらログイン画面へ（ST-06）
  onLoginRequired: () => {
    if (!location.pathname.startsWith('/login')) location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  },
});

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
