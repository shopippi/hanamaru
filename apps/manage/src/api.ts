import { createApi, useLoad } from '@hanamaru/ui';

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
  /** オンラインのレッスン（RS-09） */
  online: boolean;
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
  /** オンラインのレッスン（RS-09） */
  online?: boolean;
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

/** いま選べる支払い方法（設定で止めているものは出さない: PY-04）。選んでいる値が止めた方法でも、表示は残す */
const BILLING_LABELS = { card: 'カード（自動課金）', konbini: 'コンビニ', paypay: 'PayPay', cash: '現金' } as const;
export function useBillingOptions(current?: string): { value: string; label: string }[] {
  const { data } = useLoad(() => api.get<{ konbiniEnabled: boolean; paypayEnabled: boolean }>('/settings'), []);
  const enabled = new Set(['card', 'cash', ...(data?.konbiniEnabled ? ['konbini'] : []), ...(data?.paypayEnabled ? ['paypay'] : [])]);
  if (current) enabled.add(current);
  return (Object.keys(BILLING_LABELS) as (keyof typeof BILLING_LABELS)[]).filter((k) => enabled.has(k)).map((k) => ({ value: k, label: BILLING_LABELS[k] }));
}
