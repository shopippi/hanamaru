import { createApi } from '@hanamaru/ui';

export const api = createApi('/api', {
  onLoginRequired: (code) => {
    if (location.pathname.startsWith('/login')) return;
    location.assign(code === 'mfa_required' ? '/login?step=mfa' : `/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  },
});

export type StudentStatus = 'trial' | 'enrolling' | 'active' | 'suspended' | 'withdrawn';

export interface StudentRow {
  id: string;
  name: string;
  guardianName: string | null;
  status: StudentStatus;
  approved: boolean;
  scheduledStatus: StudentStatus | null;
  scheduledStatusAt: string | null;
  accountEmail: string;
  phone: string | null;
}

export interface Teacher {
  id: string;
  name: string;
  profileSlug: string;
  active: boolean;
  email: string;
}

export interface LessonType {
  id: string;
  name: string;
  kind: 'private' | 'group';
  durationMinutes: number;
  capacity: number;
  active: boolean;
}

export interface Course {
  id: string;
  name: string;
  lessonsPerMonth: number;
  amount: number | null;
  active: boolean;
  sortOrder: number;
}

export interface Package {
  id: string;
  name: string;
  admissionFee: number;
  lessonCount: number;
  lessonsPrice: number;
  active: boolean;
  sortOrder: number;
}

export interface ReservationRow {
  id: string;
  startsAt: string;
  endsAt: string;
  status: 'pending' | 'confirmed';
  attendance: 'scheduled' | 'attended' | 'no_show';
  teacherId: string;
  teacherName: string;
  studentId: string | null;
  studentName: string | null;
  lessonTypeName: string;
  trialRequestId: string | null;
}

export interface Slot {
  teacherId: string;
  lessonTypeId: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  booked: number;
  forTrial: boolean;
}
