import { and, asc, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { auditLogs, closures, lessonTypes, reservations, students, teachers } from '../db/schema.js';
import { listSlots } from '../domain/availability.js';
import {
  bookAsAdmin,
  cancelAsAdmin,
  createSeries,
  creditShortages,
  decidePending,
  markAttendance,
} from '../domain/booking.js';
import {
  chargeDetail,
  createCharge,
  createCourse,
  listCharges,
  listCourses,
  listPackages,
  markChargePaid,
  paymentsCsv,
  paymentsOfMonth,
  recordCashEnrollment,
  recordCashPayment,
  resendCardRequest,
  revisePrice,
  savePackage,
  updateCourse,
} from '../domain/billing.js';
import { listLessonTypes, listRooms, saveLessonType, saveRoom } from '../domain/catalog.js';
import { dashboard } from '../domain/dashboard.js';
import { bookTrialAsAdmin, listTrialRequests, setTrialStatus } from '../domain/trial.js';
import { adjustCredits } from '../domain/credits.js';
import {
  approveStudent,
  changeStudentStatus,
  createStudent,
  createTeacher,
  importStudentsCsv,
  listStudents,
  listTeachers,
  setNote,
  setStudentTeachers,
  setTeacherActive,
  studentDetailForAdmin,
  updateStudent,
} from '../domain/people.js';
import { createInviteCode, deactivateInviteCode, listInviteCodes } from '../domain/registration.js';
import {
  availabilityChange,
  availabilityOf,
  changeAvailability,
  createClosure,
  deleteClosure,
  schoolCalendar,
  setSchoolHours,
  setTeacherDay,
  teacherCalendar,
  teacherMonthStats,
} from '../domain/schedule.js';
import { getSettings, settingsPatchSchema, updateSettings } from '../domain/settings.js';
import { audit } from '../domain/audit.js';
import { jst, monthOf } from '../lib/time.js';
import { body, rawBody, dateParam, isoDateTime, monthParam, query, requireAuth, type AppDeps, type Env } from './app.js';
import { authRoutes } from './auth-routes.js';

// 管理者の画面の API（manage.hanamarumusic.com/api。手前に Cloudflare Access: URL-02）

const studentStatus = z.enum(['trial', 'enrolling', 'active', 'suspended', 'withdrawn']);
const bookInput = z.object({
  studentId: z.string().uuid(),
  teacherId: z.string().uuid(),
  lessonTypeId: z.string().uuid(),
  startsAt: isoDateTime,
});

export function manageRoutes(deps: AppDeps) {
  const app = new Hono<Env>();
  const { ctx } = deps;

  app.route('/auth', authRoutes(deps, 'manage'));
  const auth = requireAuth(deps, 'manage');
  const priv = new Hono<Env>();
  priv.use('*', auth);

  // --- 生徒（ST、TC-01、SR） ---
  priv.get('/students', async (c) => {
    const q = query(c, z.object({ status: studentStatus.optional(), pendingApproval: z.literal('1').optional() }));
    return c.json(await listStudents(ctx, c.get('actor'), { status: q.status, pendingApproval: !!q.pendingApproval }));
  });
  priv.post('/students', async (c) => c.json(await createStudent(ctx, c.get('actor'), await rawBody(c)), 201));
  priv.post('/students/import', async (c) => {
    const input = await body(c, z.object({ csv: z.string().max(1_000_000) }));
    return c.json(await importStudentsCsv(ctx, c.get('actor'), input.csv));
  });
  priv.get('/students/:id', async (c) => c.json(await studentDetailForAdmin(ctx, c.get('actor'), c.req.param('id'))));
  priv.patch('/students/:id', async (c) => c.json(await updateStudent(ctx, c.get('actor'), c.req.param('id'), await rawBody(c))));
  priv.post('/students/:id/status', async (c) => {
    const input = await body(c, z.object({ status: studentStatus, immediately: z.boolean().default(false) }));
    return c.json(await changeStudentStatus(ctx, c.get('actor'), c.req.param('id'), input.status, input));
  });
  priv.post('/students/:id/approve', async (c) => {
    await approveStudent(ctx, c.get('actor'), c.req.param('id'));
    return c.json({ ok: true });
  });
  priv.put('/students/:id/teachers', async (c) => {
    const input = await body(c, z.object({ teacherIds: z.array(z.string().uuid()) }));
    await setStudentTeachers(ctx, c.get('actor'), c.req.param('id'), input.teacherIds);
    return c.json({ ok: true });
  });
  priv.put('/students/:id/notes/:kind{admin|teacher}', async (c) => {
    const input = await body(c, z.object({ text: z.string() }));
    await setNote(ctx, c.get('actor'), c.req.param('id'), c.req.param('kind') as 'admin' | 'teacher', input.text);
    return c.json({ ok: true });
  });
  priv.post('/students/:id/credits', async (c) => {
    const input = await body(c, z.object({ month: monthParam, delta: z.number().int(), note: z.string().max(500) }));
    const balance = await adjustCredits(ctx, c.get('actor'), { studentId: c.req.param('id'), ...input });
    return c.json({ balance });
  });

  // --- 講師・空き時間（AV） ---
  priv.get('/teachers', async (c) => c.json(await listTeachers(ctx, c.get('actor'))));
  priv.post('/teachers', async (c) => c.json(await createTeacher(ctx, c.get('actor'), await rawBody(c)), 201));
  priv.post('/teachers/:id/active', async (c) => {
    const input = await body(c, z.object({ active: z.boolean() }));
    await setTeacherActive(ctx, c.get('actor'), c.req.param('id'), input.active);
    return c.json({ ok: true });
  });
  priv.get('/teachers/:id/availability', async (c) => c.json(await availabilityOf(ctx.db, c.req.param('id'))));
  priv.post('/teachers/:id/availability', async (c) => {
    const input = await body(c, z.object({ change: availabilityChange, confirm: z.boolean().default(false) }));
    return c.json(await changeAvailability(ctx, c.get('actor'), c.req.param('id'), input.change, input.confirm));
  });

  priv.get('/teachers/:id/availability/calendar', async (c) => {
    const q = query(c, z.object({ month: monthParam }));
    return c.json(await teacherCalendar(ctx, c.get('actor'), c.req.param('id'), q.month));
  });
  priv.put('/teachers/:id/availability/days', async (c) => {
    const input = (await rawBody(c)) as { confirm?: unknown };
    return c.json(await setTeacherDay(ctx, c.get('actor'), c.req.param('id'), input, input?.confirm === true));
  });

  // --- 教室の受付時間（AV-06） ---
  priv.get('/school-hours', async (c) => {
    const q = query(c, z.object({ month: monthParam }));
    return c.json(await schoolCalendar(ctx, c.get('actor'), q.month));
  });
  priv.put('/school-hours', async (c) => {
    const input = (await rawBody(c)) as { confirm?: unknown };
    return c.json(await setSchoolHours(ctx, c.get('actor'), input, input?.confirm === true));
  });

  // --- 予約（RS-06、RS-07） ---
  priv.get('/reservations', async (c) => {
    const q = query(c, z.object({ from: dateParam, to: dateParam, teacherId: z.string().uuid().optional() }));
    const conds = [
      inArray(reservations.status, ['pending', 'confirmed'] as const),
      gte(reservations.startsAt, jst(q.from)),
      lt(reservations.startsAt, new Date(jst(q.to).getTime() + 86_400_000)),
    ];
    if (q.teacherId) conds.push(eq(reservations.teacherId, q.teacherId));
    const rows = await ctx.db
      .select({
        id: reservations.id,
        startsAt: reservations.startsAt,
        endsAt: reservations.endsAt,
        status: reservations.status,
        attendance: reservations.attendance,
        roomId: reservations.roomId,
        teacherId: reservations.teacherId,
        teacherName: teachers.name,
        studentId: reservations.studentId,
        studentName: students.name,
        lessonTypeName: lessonTypes.name,
        online: lessonTypes.online,
        trialRequestId: reservations.trialRequestId,
      })
      .from(reservations)
      .innerJoin(teachers, eq(teachers.id, reservations.teacherId))
      .innerJoin(lessonTypes, eq(lessonTypes.id, reservations.lessonTypeId))
      .leftJoin(students, eq(students.id, reservations.studentId))
      .where(and(...conds))
      .orderBy(asc(reservations.startsAt));
    return c.json(rows);
  });
  priv.get('/slots', async (c) => {
    const q = query(c, z.object({ teacherId: z.string().uuid(), from: dateParam, to: dateParam }));
    return c.json(await listSlots(ctx.db, { teacherIds: [q.teacherId], from: q.from, to: q.to }));
  });
  priv.post('/reservations', async (c) => {
    const input = await body(c, bookInput);
    const r = await bookAsAdmin(ctx, c.get('actor'), input);
    return c.json({ id: r.reservation.id, warning: r.warning }, 201);
  });
  priv.post('/reservations/:id/cancel', async (c) => {
    const input = await body(c, z.object({ refund: z.boolean() }));
    return c.json(await cancelAsAdmin(ctx, c.get('actor'), c.req.param('id'), input));
  });
  priv.post('/reservations/:id/decide', async (c) => {
    const input = await body(c, z.object({ approve: z.boolean() }));
    await decidePending(ctx, c.get('actor'), c.req.param('id'), input.approve);
    return c.json({ ok: true });
  });
  priv.post('/reservations/:id/attendance', async (c) => {
    const input = await body(c, z.object({ attendance: z.enum(['scheduled', 'attended', 'no_show']) }));
    await markAttendance(ctx, c.get('actor'), c.req.param('id'), input.attendance);
    return c.json({ ok: true });
  });
  priv.post('/series', async (c) => {
    const input = await body(
      c,
      z.object({
        studentId: z.string().uuid(),
        teacherId: z.string().uuid(),
        lessonTypeId: z.string().uuid(),
        weekday: z.number().int().min(0).max(6),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        startDate: dateParam,
        endDate: dateParam,
      }),
    );
    return c.json(await createSeries(ctx, c.get('actor'), input), 201);
  });
  priv.get('/credit-shortages', async (c) => c.json(await creditShortages(ctx.db, ctx.now())));

  // --- 休講（AV-04） ---
  priv.get('/closures', async (c) => c.json(await ctx.db.select().from(closures).orderBy(desc(closures.date))));
  priv.post('/closures', async (c) => c.json(await createClosure(ctx, c.get('actor'), await rawBody(c)), 201));
  priv.delete('/closures/:id', async (c) => {
    await deleteClosure(ctx, c.get('actor'), c.req.param('id'));
    return c.json({ ok: true });
  });

  // --- 集計（AV-05、DB-04） ---
  priv.get('/stats/teachers', async (c) => {
    const q = query(c, z.object({ month: monthParam.optional() }));
    return c.json(await teacherMonthStats(ctx.db, q.month ?? monthOf(ctx.now())));
  });

  // --- 設定（3.8） ---
  priv.get('/settings', async (c) => c.json(await getSettings(ctx.db)));
  priv.patch('/settings', async (c) => {
    const patch = await body(c, settingsPatchSchema);
    const next = await updateSettings(ctx.db, patch, c.get('auth').account.id);
    await audit(ctx.db, c.get('actor'), 'settings.update', 'settings', null, patch);
    return c.json(next);
  });
  priv.get('/lesson-types', async (c) => c.json(await listLessonTypes(ctx)));
  priv.post('/lesson-types', async (c) => c.json(await saveLessonType(ctx, c.get('actor'), null, await rawBody(c)), 201));
  priv.patch('/lesson-types/:id', async (c) =>
    c.json(await saveLessonType(ctx, c.get('actor'), c.req.param('id'), await rawBody(c))),
  );
  priv.get('/rooms', async (c) => c.json(await listRooms(ctx)));
  priv.post('/rooms', async (c) => c.json(await saveRoom(ctx, c.get('actor'), null, await rawBody(c)), 201));
  priv.patch('/rooms/:id', async (c) => c.json(await saveRoom(ctx, c.get('actor'), c.req.param('id'), await rawBody(c))));

  // --- 料金（PY-01、PY-02、PY-14） ---
  priv.get('/packages', async (c) => c.json(await listPackages(ctx.db)));
  priv.post('/packages', async (c) => c.json(await savePackage(ctx, c.get('actor'), null, await rawBody(c)), 201));
  priv.patch('/packages/:id', async (c) => c.json(await savePackage(ctx, c.get('actor'), c.req.param('id'), await rawBody(c))));
  priv.get('/courses', async (c) => c.json(await listCourses(ctx.db)));
  priv.post('/courses', async (c) => c.json(await createCourse(ctx, c.get('actor'), await rawBody(c)), 201));
  priv.patch('/courses/:id', async (c) => c.json(await updateCourse(ctx, c.get('actor'), c.req.param('id'), await rawBody(c))));
  priv.post('/courses/:id/price', async (c) => c.json(await revisePrice(ctx, c.get('actor'), c.req.param('id'), await rawBody(c)), 201));

  // --- 入金（PY-06、PY-09、PY-15、PY-17） ---
  priv.get('/payments', async (c) => {
    const q = query(c, z.object({ month: monthParam, unpaid: z.literal('1').optional() }));
    return c.json(await paymentsOfMonth(ctx, c.get('actor'), q.month, { unpaidOnly: !!q.unpaid }));
  });
  priv.post('/payments/cash', async (c) => {
    const input = await body(c, z.object({ studentId: z.string().uuid(), month: monthParam, amount: z.number().int().min(0).optional() }));
    await recordCashPayment(ctx, c.get('actor'), input);
    return c.json({ ok: true }, 201);
  });
  priv.post('/students/:id/card-request', async (c) => {
    await resendCardRequest(ctx, c.get('actor'), c.req.param('id'));
    return c.json({ ok: true });
  });
  priv.post('/students/:id/enrollment/cash', async (c) => {
    const input = await body(c, z.object({ packageId: z.string().uuid() }));
    await recordCashEnrollment(ctx, c.get('actor'), c.req.param('id'), input.packageId);
    return c.json({ ok: true }, 201);
  });
  priv.get('/payments.csv', async (c) => {
    const q = query(c, z.object({ from: dateParam, to: dateParam }));
    const csv = await paymentsCsv(ctx, c.get('actor'), jst(q.from), new Date(jst(q.to).getTime() + 86_400_000));
    return c.body(csv, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="payments-${q.from}-${q.to}.csv"`,
    });
  });
  priv.get('/charges', async (c) => c.json(await listCharges(ctx, c.get('actor'))));
  priv.post('/charges', async (c) => c.json(await createCharge(ctx, c.get('actor'), await rawBody(c)), 201));
  priv.get('/charges/:id', async (c) => c.json(await chargeDetail(ctx, c.get('actor'), c.req.param('id'))));
  priv.post('/charge-items/:id/paid', async (c) => {
    await markChargePaid(ctx, c.get('actor'), c.req.param('id'));
    return c.json({ ok: true });
  });

  // --- ダッシュボード（DB-01〜04） ---
  priv.get('/dashboard', async (c) => {
    const q = query(c, z.object({ month: monthParam.optional() }));
    return c.json(await dashboard(ctx, c.get('actor'), q));
  });

  // --- 体験レッスン（TR-01） ---
  priv.get('/trial-requests', async (c) => c.json(await listTrialRequests(ctx, c.get('actor'))));
  priv.post('/trial-requests/:id/status', async (c) => {
    const input = await body(c, z.object({ status: z.enum(['new', 'scheduled', 'done', 'cancelled']) }));
    await setTrialStatus(ctx, c.get('actor'), c.req.param('id'), input.status);
    return c.json({ ok: true });
  });
  priv.post('/trial-requests/:id/reservations', async (c) => {
    const input = await body(c, bookInput.omit({ studentId: true }));
    const r = await bookTrialAsAdmin(ctx, c.get('actor'), c.req.param('id'), input);
    return c.json({ id: r.id }, 201);
  });

  // --- 招待コード（ST-03） ---
  priv.get('/invite-codes', async (c) => c.json(await listInviteCodes(ctx, c.get('actor'))));
  priv.post('/invite-codes', async (c) => {
    const input = await body(c, z.object({ validDays: z.number().int().min(1).max(365).optional(), maxUses: z.number().int().min(1).nullish() }));
    return c.json(await createInviteCode(ctx, c.get('actor'), input), 201);
  });
  priv.delete('/invite-codes/:id', async (c) => {
    await deactivateInviteCode(ctx, c.get('actor'), c.req.param('id'));
    return c.json({ ok: true });
  });

  // --- 操作記録（OP-03） ---
  priv.get('/audit-logs', async (c) => {
    const q = query(c, z.object({ targetType: z.string().optional(), targetId: z.string().optional() }));
    const conds = [];
    if (q.targetType) conds.push(eq(auditLogs.targetType, q.targetType));
    if (q.targetId) conds.push(eq(auditLogs.targetId, q.targetId));
    return c.json(
      await ctx.db
        .select()
        .from(auditLogs)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(auditLogs.createdAt))
        .limit(500),
    );
  });

  app.route('/', priv);
  return app;
}
