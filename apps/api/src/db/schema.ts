import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

// ---------------------------------------------------------------------------
// ログイン（3.1）
// ---------------------------------------------------------------------------

export const roleEnum = pgEnum('role', ['student', 'teacher', 'admin']);

/** ログインする人。生徒ロールのアカウントは保護者（または本人）で、子ども＝students を複数持てる（ST-04） */
export const accounts = pgTable('accounts', {
  id: id(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  role: roleEnum('role').notNull(),
  displayName: text('display_name').notNull(),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: ts('locked_until'),
  totpSecret: text('totp_secret'),
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  disabled: boolean('disabled').notNull().default(false),
  createdAt: createdAt(),
});

export const sessions = pgTable(
  'sessions',
  {
    /** トークンそのものではなく SHA-256 を保存する */
    id: text('id').primaryKey(),
    accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    expiresAt: ts('expires_at').notNull(),
    /** 管理者が2段階目を済ませていない間は true（AU-06） */
    mfaPending: boolean('mfa_pending').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_account_idx').on(t.accountId)],
);

export const authTokenPurposeEnum = pgEnum('auth_token_purpose', ['invite', 'reset']);

/** 招待・パスワード再設定のリンク（ST-01、AU-03）。一度使うと usedAt が入り無効 */
export const authTokens = pgTable('auth_tokens', {
  id: id(),
  tokenHash: text('token_hash').notNull().unique(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  purpose: authTokenPurposeEnum('purpose').notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: createdAt(),
});

/** 入会時に配る招待コード（ST-03） */
export const inviteCodes = pgTable('invite_codes', {
  id: id(),
  code: text('code').notNull().unique(),
  expiresAt: ts('expires_at'),
  maxUses: integer('max_uses'),
  usedCount: integer('used_count').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by').references(() => accounts.id),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// 生徒・講師（3.2、3.3、3.9）
// ---------------------------------------------------------------------------

export const studentStatusEnum = pgEnum('student_status', [
  'trial', // 体験
  'enrolling', // 入会手続き中
  'active', // 在籍中
  'suspended', // 休会中
  'withdrawn', // 退会
]);

export const billingMethodEnum = pgEnum('billing_method', ['card', 'konbini', 'paypay', 'cash']);

export const students = pgTable(
  'students',
  {
    id: id(),
    /** ログインに使う保護者（または本人）のアカウント */
    accountId: uuid('account_id').notNull().references(() => accounts.id),
    name: text('name').notNull(),
    guardianName: text('guardian_name'),
    phone: text('phone'),
    email: text('email'),
    address: text('address'),
    status: studentStatusEnum('status').notNull().default('enrolling'),
    /** 自己登録・招待コード登録の直後は false。管理者の承認で true（ST-02、ST-03） */
    approved: boolean('approved').notNull().default(true),
    /** 退会・休会は翌月1日から効く（ST-05）。それまでの予定をここに持つ */
    scheduledStatus: studentStatusEnum('scheduled_status'),
    scheduledStatusAt: ts('scheduled_status_at'),
    courseId: uuid('course_id').references(() => courses.id),
    coursePriceId: uuid('course_price_id').references(() => coursePrices.id),
    billingMethod: billingMethodEnum('billing_method').notNull().default('card'),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    /** 管理用備考: 管理者だけ（SR-03） */
    adminNote: text('admin_note').notNull().default(''),
    /** 講師用備考: 管理者と担当講師全員（SR-03） */
    teacherNote: text('teacher_note').notNull().default(''),
    /** 将来のLINE通知用（2章の5） */
    lineUserId: text('line_user_id'),
    createdAt: createdAt(),
  },
  (t) => [index('students_account_idx').on(t.accountId)],
);

export const teachers = pgTable('teachers', {
  id: id(),
  accountId: uuid('account_id').notNull().unique().references(() => accounts.id),
  name: text('name').notNull(),
  /** プロフィールのデータファイル（TC-06）のキー */
  profileSlug: text('profile_slug').notNull().unique(),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

/** 担当講師（TC-01）。行を消すと担当を外す（TC-04: 既存の予約は残る） */
export const studentTeachers = pgTable(
  'student_teachers',
  {
    studentId: uuid('student_id').notNull().references(() => students.id, { onDelete: 'cascade' }),
    teacherId: uuid('teacher_id').notNull().references(() => teachers.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.studentId, t.teacherId] })],
);

export const rooms = pgTable('rooms', {
  id: id(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
});

export const lessonKindEnum = pgEnum('lesson_kind', ['private', 'group']);

/** レッスン種別（RS-08、3.8） */
export const lessonTypes = pgTable('lesson_types', {
  id: id(),
  name: text('name').notNull(),
  kind: lessonKindEnum('kind').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  /** 個人は1 */
  capacity: integer('capacity').notNull().default(1),
  active: boolean('active').notNull().default(true),
});

// ---------------------------------------------------------------------------
// 空き時間と予約（3.4）
// ---------------------------------------------------------------------------

/** 曜日ごとの空き時間（AV-01） */
export const availabilityRules = pgTable(
  'availability_rules',
  {
    id: id(),
    teacherId: uuid('teacher_id').notNull().references(() => teachers.id, { onDelete: 'cascade' }),
    /** 0=日曜 */
    weekday: integer('weekday').notNull(),
    startTime: text('start_time').notNull(),
    endTime: text('end_time').notNull(),
    lessonTypeId: uuid('lesson_type_id').notNull().references(() => lessonTypes.id),
    roomId: uuid('room_id').references(() => rooms.id),
    /** 体験専用の枠（TR-02） */
    forTrial: boolean('for_trial').notNull().default(false),
  },
  (t) => [index('availability_rules_teacher_idx').on(t.teacherId)],
);

export const exceptionKindEnum = pgEnum('availability_exception_kind', ['block', 'extra']);

/** 日付ごとの例外（AV-01）。block=その時間は空いていない、extra=その日だけ空いている */
export const availabilityExceptions = pgTable(
  'availability_exceptions',
  {
    id: id(),
    teacherId: uuid('teacher_id').notNull().references(() => teachers.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    kind: exceptionKindEnum('kind').notNull(),
    /** block で null は終日 */
    startTime: text('start_time'),
    endTime: text('end_time'),
    lessonTypeId: uuid('lesson_type_id').references(() => lessonTypes.id),
    roomId: uuid('room_id').references(() => rooms.id),
    forTrial: boolean('for_trial').notNull().default(false),
  },
  (t) => [index('availability_exceptions_teacher_date_idx').on(t.teacherId, t.date)],
);

/** 休講日・臨時休講（AV-04）。時刻が null なら終日 */
export const closures = pgTable('closures', {
  id: id(),
  date: text('date').notNull(),
  startTime: text('start_time'),
  endTime: text('end_time'),
  reason: text('reason').notNull().default(''),
  createdBy: uuid('created_by').references(() => accounts.id),
  createdAt: createdAt(),
});

export const reservationStatusEnum = pgEnum('reservation_status', ['pending', 'confirmed', 'cancelled']);
export const attendanceEnum = pgEnum('attendance', ['scheduled', 'attended', 'no_show']);
export const cancelKindEnum = pgEnum('cancel_kind', [
  'student', // 締切前の生徒キャンセル（回数を戻す）
  'student_late', // 締切後の生徒キャンセル（戻さない、RS-05）
  'teacher', // 講師都合（AV-03、戻す）
  'school', // 教室都合・休講（AV-04、戻す）
  'admin', // 管理者の取消（戻す）
  'rejected', // 承認制で管理者が却下（戻す、RS-06）
  'unpaid', // 未払いの猶予切れで翌月分を取消（3.4）
  'rescheduled', // 変更で元の予約を取り消した
]);

/** 毎週の繰り返し予約（RS-07） */
export const reservationSeries = pgTable('reservation_series', {
  id: id(),
  studentId: uuid('student_id').notNull().references(() => students.id),
  teacherId: uuid('teacher_id').notNull().references(() => teachers.id),
  lessonTypeId: uuid('lesson_type_id').notNull().references(() => lessonTypes.id),
  roomId: uuid('room_id').references(() => rooms.id),
  weekday: integer('weekday').notNull(),
  startTime: text('start_time').notNull(),
  startDate: text('start_date').notNull(),
  endDate: text('end_date').notNull(),
  createdBy: uuid('created_by').references(() => accounts.id),
  createdAt: createdAt(),
});

export const reservations = pgTable(
  'reservations',
  {
    id: id(),
    /** 体験の予約では null で trialRequestId が入る */
    studentId: uuid('student_id').references(() => students.id),
    trialRequestId: uuid('trial_request_id').references(() => trialRequests.id),
    teacherId: uuid('teacher_id').notNull().references(() => teachers.id),
    lessonTypeId: uuid('lesson_type_id').notNull().references(() => lessonTypes.id),
    roomId: uuid('room_id').references(() => rooms.id),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    /** レッスン日が属する月。回数はこの月から使う（3.4） */
    lessonMonth: text('lesson_month').notNull(),
    status: reservationStatusEnum('status').notNull(),
    attendance: attendanceEnum('attendance').notNull().default('scheduled'),
    cancelKind: cancelKindEnum('cancel_kind'),
    cancelledAt: ts('cancelled_at'),
    cancelledBy: uuid('cancelled_by').references(() => accounts.id),
    seriesId: uuid('series_id').references(() => reservationSeries.id),
    createdBy: uuid('created_by').references(() => accounts.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('reservations_teacher_time_idx').on(t.teacherId, t.startsAt),
    index('reservations_student_time_idx').on(t.studentId, t.startsAt),
  ],
);

// ---------------------------------------------------------------------------
// 回数（3.4、3.5、OP-04）
// ---------------------------------------------------------------------------

export const creditReasonEnum = pgEnum('credit_reason', [
  'grant_enrollment', // 入会セット（PY-03）
  'grant_monthly', // 月額コース（PY-03、PY-06）
  'consume', // 予約で使用（RS-01）
  'refund', // 締切前キャンセル・講師都合・教室都合などで返却（RS-04、PY-08）
  'expire', // 月末の失効（PY-07）
  'carryover', // 翌月への繰越（PY-07）
  'adjust', // 管理者の手動調整（OP-03）
]);

/** 回数の増減の履歴。残り回数は月ごとの合計で求める（OP-04） */
export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: id(),
    studentId: uuid('student_id').notNull().references(() => students.id),
    month: text('month').notNull(),
    delta: integer('delta').notNull(),
    reason: creditReasonEnum('reason').notNull(),
    reservationId: uuid('reservation_id').references(() => reservations.id),
    paymentId: uuid('payment_id').references(() => payments.id),
    actorAccountId: uuid('actor_account_id').references(() => accounts.id),
    note: text('note').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [
    index('credit_ledger_student_month_idx').on(t.studentId, t.month),
    // 同じ予約で二重に使用・返却しない
    uniqueIndex('credit_ledger_reservation_reason_uq')
      .on(t.reservationId, t.reason)
      .where(sql`${t.reservationId} is not null`),
    // 同じ入金で二重に付与しない（OP-02）
    uniqueIndex('credit_ledger_payment_reason_uq')
      .on(t.paymentId, t.reason)
      .where(sql`${t.paymentId} is not null`),
  ],
);

// ---------------------------------------------------------------------------
// 料金と入金（3.5）
// ---------------------------------------------------------------------------

/** 入会セット（PY-01）。金額はすべて税込（MB-03） */
export const enrollmentPackages = pgTable('enrollment_packages', {
  id: id(),
  name: text('name').notNull(),
  admissionFee: integer('admission_fee').notNull(),
  lessonCount: integer('lesson_count').notNull(),
  lessonsPrice: integer('lessons_price').notNull(),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});

/** 月額コース（PY-02） */
export const courses = pgTable('courses', {
  id: id(),
  name: text('name').notNull(),
  lessonsPerMonth: integer('lessons_per_month').notNull(),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});

/** コースの料金。改定のたびに行を足す（PY-14）。新規の生徒には isCurrent の料金を使う */
export const coursePrices = pgTable('course_prices', {
  id: id(),
  courseId: uuid('course_id').notNull().references(() => courses.id),
  amount: integer('amount').notNull(),
  isCurrent: boolean('is_current').notNull().default(true),
  stripePriceId: text('stripe_price_id'),
  createdAt: createdAt(),
});

/** 既存の生徒にも新料金を適用する改定（PY-14）。適用月の1日に処理する */
export const priceChanges = pgTable('price_changes', {
  id: id(),
  courseId: uuid('course_id').notNull().references(() => courses.id),
  toPriceId: uuid('to_price_id').notNull().references(() => coursePrices.id),
  effectiveMonth: text('effective_month').notNull(),
  appliedAt: ts('applied_at'),
  createdBy: uuid('created_by').references(() => accounts.id),
  createdAt: createdAt(),
});

export const paymentKindEnum = pgEnum('payment_kind', ['enrollment', 'monthly', 'one_off']);
export const paymentStatusEnum = pgEnum('payment_status', ['pending', 'succeeded', 'failed', 'cancelled']);

export const payments = pgTable(
  'payments',
  {
    id: id(),
    studentId: uuid('student_id').notNull().references(() => students.id),
    kind: paymentKindEnum('kind').notNull(),
    method: billingMethodEnum('method').notNull(),
    /** 月額の対象月 */
    month: text('month'),
    amount: integer('amount').notNull(),
    status: paymentStatusEnum('status').notNull().default('pending'),
    enrollmentPackageId: uuid('enrollment_package_id').references(() => enrollmentPackages.id),
    chargeItemId: uuid('charge_item_id'),
    stripeCheckoutSessionId: text('stripe_checkout_session_id').unique(),
    stripeInvoiceId: text('stripe_invoice_id').unique(),
    paymentUrl: text('payment_url'),
    failureReason: text('failure_reason'),
    /** 現金の入金を記録した人（PY-06） */
    recordedBy: uuid('recorded_by').references(() => accounts.id),
    paidAt: ts('paid_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('payments_student_idx').on(t.studentId),
    // 1人1か月に月額の請求は1件
    uniqueIndex('payments_monthly_uq')
      .on(t.studentId, t.month)
      .where(sql`${t.kind} = 'monthly'`),
  ],
);

/** Stripe の通知（Webhook）の受信記録。同じ通知を二度処理しない（OP-02） */
export const stripeEvents = pgTable('stripe_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  receivedAt: createdAt(),
});

/** 教材費・発表会費などの単発の請求（PY-17） */
export const charges = pgTable('charges', {
  id: id(),
  title: text('title').notNull(),
  amount: integer('amount').notNull(),
  dueDate: text('due_date'),
  createdBy: uuid('created_by').references(() => accounts.id),
  createdAt: createdAt(),
});

export const chargeItems = pgTable(
  'charge_items',
  {
    id: id(),
    chargeId: uuid('charge_id').notNull().references(() => charges.id, { onDelete: 'cascade' }),
    studentId: uuid('student_id').notNull().references(() => students.id),
    amount: integer('amount').notNull(),
    paid: boolean('paid').notNull().default(false),
    paymentId: uuid('payment_id').references(() => payments.id),
  },
  (t) => [uniqueIndex('charge_items_charge_student_uq').on(t.chargeId, t.studentId)],
);

// ---------------------------------------------------------------------------
// 設定・通知・記録
// ---------------------------------------------------------------------------

/** 管理者が変えられる設定（3.8）。既定値はコードの settings.ts */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by').references(() => accounts.id),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const notificationStatusEnum = pgEnum('notification_status', ['pending', 'sent', 'failed', 'skipped']);

/** 送った通知（NT-01）。送信手段ごとに1行 */
export const notifications = pgTable('notifications', {
  id: id(),
  channel: text('channel').notNull(),
  type: text('type').notNull(),
  recipient: text('recipient').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  status: notificationStatusEnum('status').notNull().default('pending'),
  error: text('error'),
  createdAt: createdAt(),
  sentAt: ts('sent_at'),
});

/** 管理者の操作記録（OP-03） */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    actorAccountId: uuid('actor_account_id').references(() => accounts.id),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    details: jsonb('details').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('audit_logs_target_idx').on(t.targetType, t.targetId)],
);

/** レッスン記録（SR-04）。生徒には見せない（SR-05） */
export const lessonRecords = pgTable('lesson_records', {
  id: id(),
  reservationId: uuid('reservation_id').notNull().unique().references(() => reservations.id),
  studentId: uuid('student_id').notNull().references(() => students.id),
  teacherId: uuid('teacher_id').notNull().references(() => teachers.id),
  content: text('content').notNull(),
  progress: text('progress').notNull().default(''),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const trialStatusEnum = pgEnum('trial_status', ['new', 'scheduled', 'done', 'cancelled']);

/** 体験レッスンの申込（TR-01、TR-02） */
export const trialRequests = pgTable('trial_requests', {
  id: id(),
  name: text('name').notNull(),
  guardianName: text('guardian_name'),
  email: text('email').notNull(),
  phone: text('phone'),
  instrument: text('instrument'),
  preferredTimes: text('preferred_times').notNull().default(''),
  message: text('message').notNull().default(''),
  status: trialStatusEnum('status').notNull().default('new'),
  createdAt: createdAt(),
});
