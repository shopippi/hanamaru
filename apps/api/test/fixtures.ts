import { eq } from 'drizzle-orm';
import type { Db } from '../src/db/client.js';
import {
  accounts,
  availabilityRules,
  courses,
  creditLedger,
  lessonTypes,
  students,
  studentTeachers,
  teachers,
} from '../src/db/schema.js';
import type { Actor, Ctx } from '../src/domain/context.js';
import { EmailChannel, MemoryEmailTransport, NotificationService } from '../src/domain/notify.js';
import { jst, monthOf, type Month } from '../src/lib/time.js';
import { testDb } from './db.js';
import { FakeGateway } from './fake-gateway.js';

/** 時計を進められるテスト用の環境。既定の「今」は 2026年10月20日（火）10:00 */
export async function setup(now = jst('2026-10-20', '10:00')) {
  const db: Db = await testDb();
  const mail = new MemoryEmailTransport();
  const clock = { now };
  const gateway = new FakeGateway();
  // fixtures の自動課金の生徒が共有する仮のサブスクリプション
  gateway.subscriptions.push({ id: 'sub_test', customerId: 'cus_test', priceId: 'price_test', startAt: now, cancelAtPeriodEnd: false, paymentMethodId: null });
  const ctx: Ctx = {
    db,
    now: () => clock.now,
    notifier: new NotificationService(db, [new EmailChannel(mail)]),
    payments: gateway,
    urls: {
      student: 'https://student.example.test',
      staff: 'https://staff.example.test',
      manage: 'https://manage.example.test',
    },
  };

  const mkAccount = async (role: 'student' | 'teacher' | 'admin', email: string, name: string) => {
    const [a] = await db.insert(accounts).values({ role, email, displayName: name }).returning();
    return a!;
  };
  const actorOf = (a: { id: string; role: 'student' | 'teacher' | 'admin' }): Actor => ({
    kind: 'account',
    accountId: a.id,
    role: a.role,
  });

  const adminAccount = await mkAccount('admin', 'matsuda@example.test', '松田');
  const admin = actorOf(adminAccount);

  const [privateType] = await db
    .insert(lessonTypes)
    .values({ name: '個人60分', kind: 'private', durationMinutes: 60, capacity: 1 })
    .returning();
  const [groupType] = await db
    .insert(lessonTypes)
    .values({ name: 'グループ60分', kind: 'group', durationMinutes: 60, capacity: 2 })
    .returning();
  const [course] = await db.insert(courses).values({ name: '月4回', lessonsPerMonth: 4 }).returning();

  const mkTeacher = async (slug: string, name: string) => {
    const acc = await mkAccount('teacher', `${slug}@example.test`, name);
    const [t] = await db.insert(teachers).values({ accountId: acc.id, name, profileSlug: slug }).returning();
    return { teacher: t!, actor: actorOf(acc), account: acc };
  };
  const teacherA = await mkTeacher('teacher-a', '講師A');
  const teacherB = await mkTeacher('teacher-b', '講師B');

  // 講師A: 月〜土 15:00-18:00 個人60分、土曜 10:00-12:00 グループ
  for (let wd = 1; wd <= 6; wd++) {
    await db.insert(availabilityRules).values({
      teacherId: teacherA.teacher.id,
      weekday: wd,
      startTime: '15:00',
      endTime: '18:00',
      lessonTypeId: privateType!.id,
    });
  }
  await db.insert(availabilityRules).values({
    teacherId: teacherA.teacher.id,
    weekday: 6,
    startTime: '10:00',
    endTime: '12:00',
    lessonTypeId: groupType!.id,
  });
  // 講師B: 水曜 15:00-18:00
  await db.insert(availabilityRules).values({
    teacherId: teacherB.teacher.id,
    weekday: 3,
    startTime: '15:00',
    endTime: '18:00',
    lessonTypeId: privateType!.id,
  });

  /** 保護者アカウントと生徒（在籍中、講師Aが担当、今月の回数 credits 回） */
  const mkStudent = async (
    name: string,
    opts: { credits?: number; account?: { id: string }; teachers?: string[]; autopay?: boolean } = {},
  ) => {
    const account = opts.account
      ? (await db.select().from(accounts).where(eq(accounts.id, opts.account.id)))[0]!
      : await mkAccount('student', `${name}@example.test`, `${name}の保護者`);
    const [s] = await db
      .insert(students)
      .values({
        accountId: account.id,
        name,
        status: 'active',
        courseId: course!.id,
        billingMethod: 'card',
        stripeSubscriptionId: opts.autopay === false ? null : 'sub_test',
      })
      .returning();
    for (const t of opts.teachers ?? [teacherA.teacher.id]) {
      await db.insert(studentTeachers).values({ studentId: s!.id, teacherId: t });
    }
    if (opts.credits) await grant(s!.id, monthOf(clock.now), opts.credits);
    return { student: s!, actor: actorOf(account), account };
  };

  const grant = async (studentId: string, month: Month, n: number) => {
    await db.insert(creditLedger).values({ studentId, month, delta: n, reason: 'grant_monthly' });
  };

  return {
    db,
    ctx,
    mail,
    gateway,
    clock,
    admin,
    adminAccount,
    privateType: privateType!,
    groupType: groupType!,
    course: course!,
    teacherA,
    teacherB,
    mkStudent,
    mkAccount,
    actorOf,
    grant,
  };
}
