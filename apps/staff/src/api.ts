import { createApi } from '@hanamaru/ui';

export const api = createApi('/api', {
  onLoginRequired: () => {
    if (!location.pathname.startsWith('/login')) location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  },
});

export interface Lesson {
  id: string;
  studentId: string | null;
  studentName: string | null;
  lessonTypeName: string;
  startsAt: string;
  endsAt: string;
  status: string;
  hasRecord: boolean;
}

export interface LessonRecord {
  id: string;
  reservationId: string;
  startsAt: string;
  teacherName: string;
  content: string;
  progress: string;
}

export interface StudentDetail {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  teacherNote: string;
  lessonRecords: LessonRecord[];
}

export interface Rule {
  weekday: number;
  startTime: string;
  endTime: string;
  lessonTypeId: string;
  roomId: string | null;
  forTrial: boolean;
}

export interface Exception {
  id?: string;
  date: string;
  kind: 'block' | 'extra';
  startTime: string | null;
  endTime: string | null;
  lessonTypeId: string | null;
  roomId: string | null;
  forTrial: boolean;
}

export interface LessonType {
  id: string;
  name: string;
  kind: string;
  durationMinutes: number;
  active: boolean;
}

export interface Affected {
  reservationId: string;
  studentName: string;
  startsAt: string;
}
