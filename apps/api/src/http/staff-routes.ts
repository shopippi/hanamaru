import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { teacherOfActor } from '../domain/access.js';
import { listLessonTypes, listRooms } from '../domain/catalog.js';
import { forbidden } from '../domain/errors.js';
import {
  lessonsOfTeacher,
  saveLessonRecord,
  setNote,
  studentDetailForTeacher,
  studentsOfTeacher,
} from '../domain/people.js';
import { availabilityChange, availabilityOf, changeAvailability } from '../domain/schedule.js';
import { jst } from '../lib/time.js';
import { body, dateParam, query, requireAuth, type AppDeps, type Env } from './app.js';
import { authRoutes } from './auth-routes.js';

// 講師の画面の API（staff.hanamarumusic.com/api）

export function staffRoutes(deps: AppDeps) {
  const app = new Hono<Env>();
  const { ctx } = deps;

  app.route('/auth', authRoutes(deps, 'staff'));
  const auth = requireAuth(deps, 'staff');
  for (const p of ['/lessons', '/lessons/*', '/students', '/students/*', '/availability', '/lesson-types', '/rooms']) {
    app.use(p, auth);
  }

  const myTeacher = async (c: Context<Env>) => {
    const t = await teacherOfActor(ctx.db, c.get('actor'));
    if (!t) throw forbidden();
    return t;
  };

  // 担当レッスン一覧（4.1）
  app.get('/lessons', async (c) => {
    const q = query(c, z.object({ from: dateParam, to: dateParam }));
    return c.json(await lessonsOfTeacher(ctx, c.get('actor'), jst(q.from), new Date(jst(q.to).getTime() + 86_400_000)));
  });
  // レッスン記録（SR-04）
  app.put('/lessons/:id/record', async (c) => {
    const input = await body(c, z.object({ content: z.string(), progress: z.string().default('') }));
    await saveLessonRecord(ctx, c.get('actor'), c.req.param('id'), input);
    return c.json({ ok: true });
  });

  // 担当生徒（SR-06: 名前・電話・メール・講師用備考・レッスン記録だけ）
  app.get('/students', async (c) => c.json(await studentsOfTeacher(ctx, c.get('actor'))));
  app.get('/students/:id', async (c) => c.json(await studentDetailForTeacher(ctx, c.get('actor'), c.req.param('id'))));
  app.put('/students/:id/teacher-note', async (c) => {
    const input = await body(c, z.object({ text: z.string() }));
    await setNote(ctx, c.get('actor'), c.req.param('id'), 'teacher', input.text);
    return c.json({ ok: true });
  });

  // 自分の空き時間（AV-01〜03）
  app.get('/availability', async (c) => {
    const t = await myTeacher(c);
    return c.json(await availabilityOf(ctx.db, t.id));
  });
  app.post('/availability', async (c) => {
    const t = await myTeacher(c);
    const input = await body(c, z.object({ change: availabilityChange, confirm: z.boolean().default(false) }));
    return c.json(await changeAvailability(ctx, c.get('actor'), t.id, input.change, input.confirm));
  });
  app.get('/lesson-types', async (c) => c.json(await listLessonTypes(ctx)));
  app.get('/rooms', async (c) => c.json(await listRooms(ctx)));

  return app;
}
