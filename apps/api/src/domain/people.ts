import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  accounts,
  courses,
  creditLedger,
  lessonRecords,
  lessonTypes,
  payments,
  reservations,
  students,
  studentTeachers,
  teachers,
} from '../db/schema.js';
import { addMonths, monthOf, startOfMonth } from '../lib/time.js';
import { assertAdmin, loadStudent, studentForActor, teacherOfActor } from './access.js';
import { audit } from './audit.js';
import { issueInvite, normalizeEmail, type Account } from './auth.js';
import type { Actor, Ctx } from './context.js';
import { conflict, forbidden, invalid, notFound } from './errors.js';
import { parseCsv } from '../lib/csv.js';
import { resumeBilling, stopBilling } from './billing.js';

// 生徒・講師の登録と管理（3.2、3.3、3.9）

type StudentStatus = (typeof students.$inferSelect)['status'];

const email = z.string().trim().email('メールアドレスの形式が正しくありません').transform(normalizeEmail);
const optionalText = z
  .string()
  .trim()
  .max(500)
  .nullish()
  .transform((v) => (v ? v : null));

export const studentInput = z.object({
  /** ログインに使うメール（保護者または本人）。既にあるアカウントなら、その家庭に子どもを足す（ST-04） */
  accountEmail: email,
  guardianName: optionalText,
  name: z.string().trim().min(1, '生徒の名前を入力してください').max(100),
  phone: optionalText,
  email: z
    .string()
    .trim()
    .email('メールアドレスの形式が正しくありません')
    .nullish()
    .or(z.literal('').transform(() => null)),
  address: optionalText,
  status: z.enum(['trial', 'enrolling', 'active']).default('enrolling'),
  courseId: z.string().uuid().nullish(),
  billingMethod: z.enum(['card', 'konbini', 'paypay', 'cash']).default('card'),
  teacherIds: z.array(z.string().uuid()).default([]),
});
export type StudentInput = z.input<typeof studentInput>;

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw invalid(r.error.issues[0]?.message ?? '入力に誤りがあります', r.error.issues);
  return r.data;
}

async function findOrCreateStudentAccount(
  db: Db,
  emailAddr: string,
  displayName: string,
): Promise<{ account: Account; created: boolean }> {
  const [existing] = await db.select().from(accounts).where(eq(accounts.email, emailAddr));
  if (existing) {
    if (existing.role !== 'student') throw conflict('このメールアドレスは講師・管理者のアカウントで使われています');
    return { account: existing, created: false };
  }
  const [account] = await db.insert(accounts).values({ email: emailAddr, role: 'student', displayName }).returning();
  return { account: account!, created: true };
}

/** 管理者が生徒を1件登録する（ST-01）。新しいアカウントには招待メールを送る */
export async function createStudent(ctx: Ctx, actor: Actor, raw: unknown) {
  assertAdmin(actor);
  const input = parse(studentInput, raw);
  const result = await ctx.db.transaction(async (tx) => {
    const { account, created } = await findOrCreateStudentAccount(tx, input.accountEmail, input.guardianName ?? input.name);
    const [student] = await tx
      .insert(students)
      .values({
        accountId: account.id,
        name: input.name,
        guardianName: input.guardianName,
        phone: input.phone,
        email: input.email ?? null,
        address: input.address,
        status: input.status,
        courseId: input.courseId ?? null,
        billingMethod: input.billingMethod,
        approved: true,
      })
      .returning();
    if (input.teacherIds.length) {
      await tx.insert(studentTeachers).values(input.teacherIds.map((teacherId) => ({ studentId: student!.id, teacherId })));
    }
    await audit(tx, actor, 'student.create', 'student', student!.id, { name: input.name, accountEmail: input.accountEmail });
    return { student: student!, account, created };
  });
  if (result.created || !result.account.passwordHash) await issueInvite(ctx, result.account);
  return result.student;
}

const CSV_COLUMNS = ['ログインメール', '保護者名', '生徒名', '電話番号', '生徒のメール', '住所'] as const;

/**
 * CSVで一括登録する（ST-01）。1行でも誤りがあれば何も登録せず、行番号と理由を返す。
 * 1行目は見出し: ログインメール,保護者名,生徒名,電話番号,生徒のメール,住所
 */
export async function importStudentsCsv(ctx: Ctx, actor: Actor, csv: string) {
  assertAdmin(actor);
  const rows = parseCsv(csv);
  const header = rows.shift() ?? [];
  if (CSV_COLUMNS.some((c, i) => header[i]?.trim() !== c)) {
    throw invalid(`1行目の見出しは「${CSV_COLUMNS.join(',')}」にしてください`);
  }
  const errors: { line: number; message: string }[] = [];
  const inputs: StudentInput[] = [];
  rows.forEach((cols, i) => {
    if (cols.every((c) => !c.trim())) return;
    const [accountEmail, guardianName, name, phone, studentEmail, address] = cols;
    const r = studentInput.safeParse({ accountEmail, guardianName, name, phone, email: studentEmail ?? '', address });
    if (!r.success) errors.push({ line: i + 2, message: r.error.issues[0]?.message ?? '入力に誤りがあります' });
    else inputs.push(r.data);
  });
  if (errors.length) return { created: 0, errors };
  const created = [];
  for (const input of inputs) created.push(await createStudent(ctx, actor, input));
  return { created: created.length, errors };
}

export const studentPatch = studentInput
  .omit({ accountEmail: true, status: true, teacherIds: true })
  .partial()
  .extend({ lineUserId: optionalText });

/** 生徒の基本情報の編集（SR-01） */
export async function updateStudent(ctx: Ctx, actor: Actor, studentId: string, raw: unknown) {
  assertAdmin(actor);
  const patch = parse(studentPatch, raw);
  await loadStudent(ctx.db, studentId);
  return ctx.db.transaction(async (tx) => {
    const [s] = await tx.update(students).set(patch).where(eq(students.id, studentId)).returning();
    await audit(tx, actor, 'student.update', 'student', studentId, patch);
    return s!;
  });
}

/**
 * 状態の切り替え（SR-02）。退会・休会は管理者だけが操作し、翌月1日から効く（ST-05）。
 * それまでは支払い済みの月の予約を続けられる。
 */
export async function changeStudentStatus(
  ctx: Ctx,
  actor: Actor,
  studentId: string,
  status: StudentStatus,
  opts: { immediately?: boolean } = {},
) {
  assertAdmin(actor);
  const s = await loadStudent(ctx.db, studentId);
  const leaving = status === 'withdrawn' || status === 'suspended';
  const deferred = leaving && !opts.immediately;
  const at = startOfMonth(addMonths(monthOf(ctx.now()), 1));
  // 課金は翌月1日から止める（今月分は返金しない）。休会から戻ると翌月1日から再開する
  if (leaving) await stopBilling(ctx, s);
  else if (status === 'active' && s.status === 'suspended') await resumeBilling(ctx, s);
  return ctx.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(students)
      .set(
        deferred
          ? { scheduledStatus: status, scheduledStatusAt: at }
          : { status, scheduledStatus: null, scheduledStatusAt: null },
      )
      .where(eq(students.id, studentId))
      .returning();
    await audit(tx, actor, 'student.status', 'student', studentId, {
      from: s.status,
      to: status,
      effectiveAt: deferred ? at.toISOString() : 'now',
    });
    return updated!;
  });
}

/** 予定していた退会・休会を、その日が来たら反映する（定期処理） */
export async function applyScheduledStatuses(ctx: Ctx): Promise<number> {
  const due = await ctx.db
    .select()
    .from(students)
    .where(and(isNotNull(students.scheduledStatus), lte(students.scheduledStatusAt, ctx.now())));
  for (const s of due) {
    await ctx.db.transaction(async (tx) => {
      await tx
        .update(students)
        .set({ status: s.scheduledStatus!, scheduledStatus: null, scheduledStatusAt: null })
        .where(eq(students.id, s.id));
      await audit(tx, { kind: 'system' }, 'student.status', 'student', s.id, { from: s.status, to: s.scheduledStatus });
    });
  }
  return due.length;
}

/** 自己登録・招待コードで登録した生徒を承認する（ST-02、ST-03） */
export async function approveStudent(ctx: Ctx, actor: Actor, studentId: string) {
  assertAdmin(actor);
  await loadStudent(ctx.db, studentId);
  await ctx.db.transaction(async (tx) => {
    await tx.update(students).set({ approved: true }).where(eq(students.id, studentId));
    await audit(tx, actor, 'student.approve', 'student', studentId);
  });
}

/** 担当講師を設定する（TC-01）。外しても既存の予約は残す（TC-04） */
export async function setStudentTeachers(ctx: Ctx, actor: Actor, studentId: string, teacherIds: string[]) {
  assertAdmin(actor);
  await loadStudent(ctx.db, studentId);
  const unique = [...new Set(teacherIds)];
  if (unique.length) {
    const found = await ctx.db.select({ id: teachers.id }).from(teachers).where(inArray(teachers.id, unique));
    if (found.length !== unique.length) throw invalid('講師が見つかりません');
  }
  await ctx.db.transaction(async (tx) => {
    const before = await tx.select().from(studentTeachers).where(eq(studentTeachers.studentId, studentId));
    await tx.delete(studentTeachers).where(eq(studentTeachers.studentId, studentId));
    if (unique.length) await tx.insert(studentTeachers).values(unique.map((teacherId) => ({ studentId, teacherId })));
    await audit(tx, actor, 'student.teachers', 'student', studentId, {
      from: before.map((b) => b.teacherId),
      to: unique,
    });
  });
}

/**
 * 備考（SR-03）。管理用備考は管理者だけ、講師用備考は管理者と担当講師全員が読み書きする。
 */
export async function setNote(ctx: Ctx, actor: Actor, studentId: string, kind: 'admin' | 'teacher', text: string) {
  if (text.length > 5000) throw invalid('備考が長すぎます');
  if (kind === 'admin') assertAdmin(actor);
  else {
    if (actor.kind === 'account' && actor.role === 'student') throw forbidden();
    await studentForActor(ctx.db, actor, studentId); // 講師は担当している生徒だけ
  }
  await ctx.db
    .update(students)
    .set(kind === 'admin' ? { adminNote: text } : { teacherNote: text })
    .where(eq(students.id, studentId));
  if (actor.kind === 'system' || actor.role === 'admin') {
    await audit(ctx.db, actor, `student.note.${kind}`, 'student', studentId);
  }
}

// --- 一覧・詳細 ---------------------------------------------------------------------

export async function listStudents(ctx: Ctx, actor: Actor, filter: { status?: StudentStatus; pendingApproval?: boolean } = {}) {
  assertAdmin(actor);
  const conds = [];
  if (filter.status) conds.push(eq(students.status, filter.status));
  if (filter.pendingApproval) conds.push(eq(students.approved, false));
  return ctx.db
    .select({
      id: students.id,
      name: students.name,
      guardianName: students.guardianName,
      status: students.status,
      approved: students.approved,
      scheduledStatus: students.scheduledStatus,
      scheduledStatusAt: students.scheduledStatusAt,
      accountEmail: accounts.email,
      phone: students.phone,
    })
    .from(students)
    .innerJoin(accounts, eq(accounts.id, students.accountId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(students.name));
}

/** 管理者の生徒詳細（4.1）: 基本情報、状態、備考、担当、レッスン記録、回数の履歴、入金記録 */
export async function studentDetailForAdmin(ctx: Ctx, actor: Actor, studentId: string) {
  assertAdmin(actor);
  const s = await loadStudent(ctx.db, studentId);
  const [account] = await ctx.db.select({ email: accounts.email }).from(accounts).where(eq(accounts.id, s.accountId));
  const [teacherRows, records, ledger, paymentRows, course] = await Promise.all([
    ctx.db
      .select({ id: teachers.id, name: teachers.name })
      .from(studentTeachers)
      .innerJoin(teachers, eq(teachers.id, studentTeachers.teacherId))
      .where(eq(studentTeachers.studentId, studentId)),
    recordsOf(ctx.db, studentId),
    ctx.db.select().from(creditLedger).where(eq(creditLedger.studentId, studentId)).orderBy(desc(creditLedger.createdAt)),
    ctx.db.select().from(payments).where(eq(payments.studentId, studentId)).orderBy(desc(payments.createdAt)),
    s.courseId ? ctx.db.select().from(courses).where(eq(courses.id, s.courseId)) : Promise.resolve([]),
  ]);
  return {
    ...s,
    accountEmail: account?.email ?? null,
    course: course[0] ?? null,
    teachers: teacherRows,
    lessonRecords: records,
    creditLedger: ledger,
    payments: paymentRows,
  };
}

/** 講師に見せる生徒の情報は、名前・電話・メール・講師用備考・レッスン記録だけ（SR-06） */
export async function studentDetailForTeacher(ctx: Ctx, actor: Actor, studentId: string) {
  const teacher = await teacherOfActor(ctx.db, actor);
  if (!teacher) throw forbidden();
  const s = await studentForActor(ctx.db, actor, studentId); // 担当外は not_found（SR-07）
  const [account] = await ctx.db.select({ email: accounts.email }).from(accounts).where(eq(accounts.id, s.accountId));
  return {
    id: s.id,
    name: s.name,
    phone: s.phone,
    email: s.email ?? account?.email ?? null,
    teacherNote: s.teacherNote,
    lessonRecords: await recordsOf(ctx.db, s.id),
  };
}

/** 講師の担当生徒の一覧（SR-07: 担当を外れたら出ない） */
export async function studentsOfTeacher(ctx: Ctx, actor: Actor) {
  const teacher = await teacherOfActor(ctx.db, actor);
  if (!teacher) throw forbidden();
  return ctx.db
    .select({ id: students.id, name: students.name, status: students.status })
    .from(studentTeachers)
    .innerJoin(students, eq(students.id, studentTeachers.studentId))
    .where(and(eq(studentTeachers.teacherId, teacher.id), inArray(students.status, ['trial', 'enrolling', 'active', 'suspended'])))
    .orderBy(asc(students.name));
}

// --- レッスン記録（SR-04、SR-05） ------------------------------------------------

function recordsOf(db: Db, studentId: string) {
  return db
    .select({
      id: lessonRecords.id,
      reservationId: lessonRecords.reservationId,
      startsAt: reservations.startsAt,
      teacherName: teachers.name,
      content: lessonRecords.content,
      progress: lessonRecords.progress,
      updatedAt: lessonRecords.updatedAt,
    })
    .from(lessonRecords)
    .innerJoin(reservations, eq(reservations.id, lessonRecords.reservationId))
    .innerJoin(teachers, eq(teachers.id, lessonRecords.teacherId))
    .where(eq(lessonRecords.studentId, studentId))
    .orderBy(asc(reservations.startsAt));
}

export const recordInput = z.object({
  content: z.string().trim().min(1, 'レッスンの内容を入力してください').max(5000),
  progress: z.string().trim().max(2000).default(''),
});

/** 講師がレッスンごとに記録を書く（SR-04）。自分の担当レッスンだけ */
export async function saveLessonRecord(ctx: Ctx, actor: Actor, reservationId: string, raw: unknown) {
  const input = parse(recordInput, raw);
  const [r] = await ctx.db.select().from(reservations).where(eq(reservations.id, reservationId));
  if (!r || !r.studentId || r.status === 'cancelled') throw notFound('レッスンが見つかりません');
  let teacherId = r.teacherId;
  if (!(actor.kind === 'system' || actor.role === 'admin')) {
    const teacher = await teacherOfActor(ctx.db, actor);
    if (!teacher || teacher.id !== r.teacherId) throw notFound('レッスンが見つかりません');
    teacherId = teacher.id;
  }
  await ctx.db
    .insert(lessonRecords)
    .values({ reservationId, studentId: r.studentId, teacherId, ...input })
    .onConflictDoUpdate({ target: lessonRecords.reservationId, set: { ...input, updatedAt: new Date() } });
}

/** 講師の担当レッスン一覧（4.1） */
export async function lessonsOfTeacher(ctx: Ctx, actor: Actor, from: Date, to: Date) {
  const teacher = await teacherOfActor(ctx.db, actor);
  if (!teacher) throw forbidden();
  return ctx.db
    .select({
      id: reservations.id,
      studentId: reservations.studentId,
      studentName: students.name,
      lessonTypeName: lessonTypes.name,
      startsAt: reservations.startsAt,
      endsAt: reservations.endsAt,
      status: reservations.status,
      hasRecord: sql<boolean>`exists (select 1 from ${lessonRecords} where ${lessonRecords.reservationId} = ${reservations.id})`,
    })
    .from(reservations)
    .leftJoin(students, eq(students.id, reservations.studentId))
    .innerJoin(lessonTypes, eq(lessonTypes.id, reservations.lessonTypeId))
    .where(
      and(
        eq(reservations.teacherId, teacher.id),
        inArray(reservations.status, ['pending', 'confirmed']),
        sql`${reservations.startsAt} >= ${from} and ${reservations.startsAt} < ${to}`,
      ),
    )
    .orderBy(asc(reservations.startsAt));
}

/** 担当レッスン1件（記録の入力画面用）。自分の担当でなければ見つからない */
export async function lessonOfTeacher(ctx: Ctx, actor: Actor, reservationId: string) {
  const teacher = await teacherOfActor(ctx.db, actor);
  if (!teacher) throw forbidden();
  const [row] = await ctx.db
    .select({
      id: reservations.id,
      studentId: reservations.studentId,
      studentName: students.name,
      lessonTypeName: lessonTypes.name,
      startsAt: reservations.startsAt,
      endsAt: reservations.endsAt,
      status: reservations.status,
    })
    .from(reservations)
    .leftJoin(students, eq(students.id, reservations.studentId))
    .innerJoin(lessonTypes, eq(lessonTypes.id, reservations.lessonTypeId))
    .where(and(eq(reservations.id, reservationId), eq(reservations.teacherId, teacher.id)));
  if (!row) throw notFound('レッスンが見つかりません');
  return row;
}

// --- 講師の登録 ----------------------------------------------------------------------

export const teacherInput = z.object({
  email,
  name: z.string().trim().min(1, '名前を入力してください').max(100),
  profileSlug: z.string().regex(/^[a-z0-9-]+$/, 'プロフィールのキーは英小文字・数字・ハイフンで入力してください'),
});

export async function createTeacher(ctx: Ctx, actor: Actor, raw: unknown) {
  assertAdmin(actor);
  const input = parse(teacherInput, raw);
  const result = await ctx.db.transaction(async (tx) => {
    const [exists] = await tx.select().from(accounts).where(eq(accounts.email, input.email));
    if (exists) throw conflict('このメールアドレスは登録済みです');
    const [account] = await tx.insert(accounts).values({ email: input.email, role: 'teacher', displayName: input.name }).returning();
    const [teacher] = await tx
      .insert(teachers)
      .values({ accountId: account!.id, name: input.name, profileSlug: input.profileSlug })
      .returning();
    await audit(tx, actor, 'teacher.create', 'teacher', teacher!.id, input);
    return { account: account!, teacher: teacher! };
  });
  await issueInvite(ctx, result.account);
  return result.teacher;
}

export async function setTeacherActive(ctx: Ctx, actor: Actor, teacherId: string, active: boolean) {
  assertAdmin(actor);
  await ctx.db.transaction(async (tx) => {
    const [t] = await tx.update(teachers).set({ active }).where(eq(teachers.id, teacherId)).returning();
    if (!t) throw notFound('講師が見つかりません');
    await tx.update(accounts).set({ disabled: !active }).where(eq(accounts.id, t.accountId));
    await audit(tx, actor, active ? 'teacher.activate' : 'teacher.deactivate', 'teacher', teacherId);
  });
}

export async function listTeachers(ctx: Ctx, actor: Actor) {
  assertAdmin(actor);
  return ctx.db
    .select({ id: teachers.id, name: teachers.name, profileSlug: teachers.profileSlug, active: teachers.active, email: accounts.email })
    .from(teachers)
    .innerJoin(accounts, eq(accounts.id, teachers.accountId))
    .orderBy(asc(teachers.name));
}
