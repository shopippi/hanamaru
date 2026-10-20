import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { accounts, students, studentTeachers, teachers } from '../db/schema.js';
import type { Actor } from './context.js';
import { forbidden, notFound } from './errors.js';
import type { Recipient } from './notify.js';

// 誰が何を見られるか・操作できるかの判定を1か所に集める（2章の6、5.2）

export type Student = typeof students.$inferSelect;
export type Teacher = typeof teachers.$inferSelect;

export async function loadStudent(db: Db, studentId: string): Promise<Student> {
  const [s] = await db.select().from(students).where(eq(students.id, studentId));
  if (!s) throw notFound('生徒が見つかりません');
  return s;
}

export async function loadTeacher(db: Db, teacherId: string): Promise<Teacher> {
  const [t] = await db.select().from(teachers).where(eq(teachers.id, teacherId));
  if (!t) throw notFound('講師が見つかりません');
  return t;
}

/**
 * 生徒アカウントは自分（保護者なら自分の子ども）の生徒だけを操作できる。
 * 他人の生徒は「存在しない」として扱い、存在も知らせない。
 */
export async function studentForActor(db: Db, actor: Actor, studentId: string): Promise<Student> {
  const s = await loadStudent(db, studentId);
  if (actor.kind === 'system' || actor.role === 'admin') return s;
  if (actor.role === 'student' && s.accountId === actor.accountId) return s;
  if (actor.role === 'teacher') {
    // 担当を外れた講師は見られない（SR-07）
    const t = await teacherOfActor(db, actor);
    if (t && (await isAssigned(db, s.id, t.id))) return s;
  }
  throw notFound('生徒が見つかりません');
}

/** 講師アカウントに対応する講師 */
export async function teacherOfActor(db: Db, actor: Actor): Promise<Teacher | null> {
  if (actor.kind !== 'account' || actor.role !== 'teacher') return null;
  const [t] = await db.select().from(teachers).where(eq(teachers.accountId, actor.accountId));
  return t ?? null;
}

/** 管理者、または講師本人 */
export async function assertTeacherSelfOrAdmin(db: Db, actor: Actor, teacherId: string): Promise<Teacher> {
  const t = await loadTeacher(db, teacherId);
  if (actor.kind === 'system' || actor.role === 'admin') return t;
  if (actor.role === 'teacher' && t.accountId === actor.accountId) return t;
  throw forbidden();
}

export function assertAdmin(actor: Actor): void {
  if (actor.kind === 'system' || actor.role === 'admin') return;
  throw forbidden();
}

export async function isAssigned(db: Db, studentId: string, teacherId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(studentTeachers)
    .where(and(eq(studentTeachers.studentId, studentId), eq(studentTeachers.teacherId, teacherId)));
  return rows.length > 0;
}

export async function assignedTeacherIds(db: Db, studentId: string): Promise<string[]> {
  const rows = await db
    .select({ teacherId: studentTeachers.teacherId })
    .from(studentTeachers)
    .where(eq(studentTeachers.studentId, studentId));
  return rows.map((r) => r.teacherId);
}

/** 生徒への通知の宛先。生徒のメールがなければ保護者アカウントのメール */
export async function recipientOfStudent(db: Db, student: Student): Promise<Recipient> {
  if (student.email) return { email: student.email, lineUserId: student.lineUserId };
  const [a] = await db.select({ email: accounts.email }).from(accounts).where(eq(accounts.id, student.accountId));
  return { email: a?.email ?? null, lineUserId: student.lineUserId };
}

export async function adminRecipients(db: Db): Promise<Recipient[]> {
  const rows = await db
    .select({ email: accounts.email })
    .from(accounts)
    .where(and(eq(accounts.role, 'admin'), eq(accounts.disabled, false)));
  return rows.map((r) => ({ email: r.email }));
}
