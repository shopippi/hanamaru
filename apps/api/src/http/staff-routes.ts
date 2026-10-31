import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { teacherOfActor } from '../domain/access.js';
import { listLessonTypes, listRooms } from '../domain/catalog.js';
import { forbidden } from '../domain/errors.js';
import {
  lessonOfTeacher,
  lessonsOfTeacher,
  saveLessonRecord,
  setNote,
  studentDetailForTeacher,
  studentsOfTeacher,
} from '../domain/people.js';
import { markAllReviewsChecked, markReviewChecked, reviewsForTeacher } from '../domain/reviews.js';
import { availabilityChange, availabilityOf, changeAvailability, setTeacherDay, teacherCalendar } from '../domain/schedule.js';
import { jst } from '../lib/time.js';
import { body, dateParam, monthParam, photoResponse, query, rawBody, requireAuth, type AppDeps, type Env } from './app.js';
import { deleteMyPhoto, myPhoto, myProfile, setMyPhoto, updateMyProfile } from '../domain/teacher-profiles.js';
import { authRoutes } from './auth-routes.js';

// 講師の画面の API（staff.hanamarumusic.com/api）

export function staffRoutes(deps: AppDeps) {
  const app = new Hono<Env>();
  const { ctx } = deps;

  app.route('/auth', authRoutes(deps, 'staff'));
  const auth = requireAuth(deps, 'staff');
  for (const p of ['/lessons', '/lessons/*', '/students', '/students/*', '/availability', '/availability/*', '/lesson-types', '/rooms', '/reviews', '/reviews/*', '/profile', '/profile/*']) {
    app.use(p, auth);
  }

  const myTeacher = async (c: Context<Env>) => {
    const t = await teacherOfActor(ctx.db, c.get('actor'));
    if (!t) throw forbidden();
    return t;
  };

  // 自分のプロフィールと写真（TC-07）
  app.get('/profile', async (c) => c.json(await myProfile(ctx, c.get('actor'))));
  app.put('/profile', async (c) => c.json(await updateMyProfile(ctx, c.get('actor'), await rawBody(c))));
  app.get('/profile/photo', async (c) => photoResponse(c, await myPhoto(ctx, c.get('actor'))));
  app.put('/profile/photo', async (c) => c.json(await setMyPhoto(ctx, c.get('actor'), await rawBody(c))));
  app.delete('/profile/photo', async (c) => {
    await deleteMyPhoto(ctx, c.get('actor'));
    return c.json({ ok: true });
  });

  // 担当レッスン一覧（4.1）
  app.get('/lessons', async (c) => {
    const q = query(c, z.object({ from: dateParam, to: dateParam }));
    return c.json(await lessonsOfTeacher(ctx, c.get('actor'), jst(q.from), new Date(jst(q.to).getTime() + 86_400_000)));
  });
  app.get('/lessons/:id', async (c) => c.json(await lessonOfTeacher(ctx, c.get('actor'), c.req.param('id'))));
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
  // 自分の空き時間のカレンダーと、日ごとの設定（AV-07）
  app.get('/availability/calendar', async (c) => {
    const t = await myTeacher(c);
    const q = query(c, z.object({ month: monthParam }));
    return c.json(await teacherCalendar(ctx, c.get('actor'), t.id, q.month));
  });
  app.put('/availability/days', async (c) => {
    const t = await myTeacher(c);
    const input = (await rawBody(c)) as { confirm?: unknown };
    return c.json(await setTeacherDay(ctx, c.get('actor'), t.id, input, input?.confirm === true));
  });
  // 自分へのレビュー（RV-04、RV-05）
  app.get('/reviews', async (c) => c.json(await reviewsForTeacher(ctx, c.get('actor'))));
  app.post('/reviews/check-all', async (c) => c.json({ checked: await markAllReviewsChecked(ctx, c.get('actor')) }));
  app.post('/reviews/:id/check', async (c) => {
    await markReviewChecked(ctx, c.get('actor'), c.req.param('id'));
    return c.json({ ok: true });
  });
  app.get('/lesson-types', async (c) => c.json(await listLessonTypes(ctx)));
  app.get('/rooms', async (c) => c.json(await listRooms(ctx)));

  return app;
}
