import { Hono } from 'hono';
import { z } from 'zod';
import {
  bookAsStudent,
  cancelAsStudent,
  cancelPreview,
  changeAsStudent,
  reservationsOfStudent,
  slotsForStudent,
} from '../domain/booking.js';
import { listLessonTypes } from '../domain/catalog.js';
import { DomainError } from '../domain/errors.js';
import { myStudents, studentHome } from '../domain/home.js';
import { register, registrationOptions, teacherProfilesForStudent } from '../domain/registration.js';
import { body, rawBody, dateParam, isoDateTime, query, requireAuth, type AppDeps, type Env } from './app.js';
import { authRoutes } from './auth-routes.js';

// 生徒の画面の API（student.hanamarumusic.com/api）

const slotInput = z.object({
  teacherId: z.string().uuid(),
  lessonTypeId: z.string().uuid(),
  startsAt: isoDateTime,
});

export function studentRoutes(deps: AppDeps) {
  const app = new Hono<Env>();
  const { ctx } = deps;

  app.route('/auth', authRoutes(deps, 'student'));

  // 自己登録（ST-02、ST-03）。OFF のときは登録画面を出さない
  app.get('/registration', async (c) => c.json(await registrationOptions(ctx)));
  app.post('/registration', async (c) => {
    const raw = (await rawBody(c)) as Record<string, unknown> | null;
    if (!(await deps.captcha.verify(raw?.captchaToken as string | undefined, c.req.header('cf-connecting-ip')))) {
      throw new DomainError('validation', '確認に失敗しました。もう一度お試しください');
    }
    await register(ctx, raw);
    return c.json({ ok: true }, 201);
  });

  const auth = requireAuth(deps, 'student');
  app.use('/students/*', auth);
  app.use('/students', auth);
  app.use('/reservations/*', auth);
  app.use('/lesson-types', auth);

  app.get('/students', async (c) => c.json(await myStudents(ctx, c.get('actor'))));
  app.get('/lesson-types', async (c) => c.json(await listLessonTypes(ctx)));
  app.get('/students/:sid/home', async (c) => c.json(await studentHome(ctx, c.get('actor'), c.req.param('sid'))));
  app.get('/students/:sid/teachers', async (c) =>
    c.json(await teacherProfilesForStudent(ctx, c.get('actor'), c.req.param('sid'))),
  );
  app.get('/students/:sid/slots', async (c) => {
    const q = query(c, z.object({ teacherId: z.string().uuid(), from: dateParam, to: dateParam }));
    const slots = await slotsForStudent(ctx, c.get('actor'), c.req.param('sid'), q.teacherId, q.from, q.to);
    // 生徒には空いている枠だけを出す。他の生徒の予約の有無は見せない
    return c.json(slots.map((s) => ({ teacherId: s.teacherId, lessonTypeId: s.lessonTypeId, startsAt: s.startsAt, endsAt: s.endsAt })));
  });
  app.get('/students/:sid/reservations', async (c) =>
    c.json(await reservationsOfStudent(ctx, c.get('actor'), c.req.param('sid'))),
  );
  app.post('/students/:sid/reservations', async (c) => {
    const input = await body(c, slotInput);
    const r = await bookAsStudent(ctx, c.get('actor'), { studentId: c.req.param('sid'), ...input });
    return c.json({ id: r.id, status: r.status, startsAt: r.startsAt }, 201);
  });
  app.get('/reservations/:id/cancel-preview', async (c) =>
    c.json(await cancelPreview(ctx, c.get('actor'), c.req.param('id'))),
  );
  app.post('/reservations/:id/cancel', async (c) =>
    c.json(await cancelAsStudent(ctx, c.get('actor'), c.req.param('id'))),
  );
  app.post('/reservations/:id/change', async (c) => {
    const input = await body(c, slotInput);
    const r = await changeAsStudent(ctx, c.get('actor'), c.req.param('id'), input);
    return c.json({ id: r.id, status: r.status, startsAt: r.startsAt });
  });

  return app;
}
