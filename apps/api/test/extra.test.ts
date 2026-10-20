import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { notifications, students } from '../src/db/schema.js';
import { bookAsStudent } from '../src/domain/booking.js';
import { createCourse, enrollmentOptions } from '../src/domain/billing.js';
import { balance } from '../src/domain/credits.js';
import { EmailChannel, MemoryEmailTransport, NotificationService, type Channel, type Message } from '../src/domain/notify.js';
import { jst } from '../src/lib/time.js';
import { setup } from './fixtures.js';

describe('PY-02 月額コース', () => {
  test('管理者が作ったコースを生徒に割り当てられ、入会画面に出る', async () => {
    const f = await setup();
    const course = await createCourse(f.ctx, f.admin, { name: '月2回コース', lessonsPerMonth: 2, amount: 7700 });
    const { student, actor } = await f.mkStudent('太郎');
    await f.db.update(students).set({ status: 'enrolling', courseId: course.id }).where(eq(students.id, student.id));
    const opts = await enrollmentOptions(f.ctx, actor, student.id);
    expect(opts.course).toEqual({ name: '月2回コース', lessonsPerMonth: 2, amount: 7700 });
  });
});

describe('NT-03 送信手段の差し替え', () => {
  test('送信手段を1つ足すだけで、新しい手段でも送れる', async () => {
    const f = await setup();
    const pushed: { to: string; message: Message }[] = [];
    // 例: 将来の LINE。宛先は生徒データの LINE の識別子（2章の5）
    const line: Channel = {
      name: 'line',
      address: (r) => r.lineUserId ?? null,
      deliver: async (to, message) => {
        pushed.push({ to, message });
      },
    };
    const mail = new MemoryEmailTransport();
    const notifier = new NotificationService(f.db, [new EmailChannel(mail), line]);
    await notifier.send('reservation_reminder', { email: 'a@example.test', lineUserId: 'U123' }, { subject: '件名', body: '本文' });
    expect(mail.sent).toHaveLength(1);
    expect(pushed).toEqual([{ to: 'U123', message: { subject: '件名', body: '本文' } }]);
    const rows = await f.db.select().from(notifications);
    expect(rows.map((r) => [r.channel, r.status]).sort()).toEqual([
      ['email', 'sent'],
      ['line', 'sent'],
    ]);
  });
});

describe('RS-08 / 同時予約', () => {
  test('同じ個人レッスンの枠に10人が同時に予約しても、1人だけが予約できる', async () => {
    const f = await setup();
    const kids = await Promise.all(Array.from({ length: 10 }, (_, i) => f.mkStudent(`生徒${i}`, { credits: 4 })));
    const startsAt = jst('2026-10-22', '15:00');
    const results = await Promise.allSettled(
      kids.map((k) =>
        bookAsStudent(f.ctx, k.actor, { studentId: k.student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.privateType.id, startsAt }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // 予約できなかった人の回数は減らない
    const balances = await Promise.all(kids.map((k) => balance(f.db, k.student.id, '2026-10')));
    expect(balances.sort()).toEqual([3, 4, 4, 4, 4, 4, 4, 4, 4, 4]);
  });

  test('定員2のグループの枠に5人が同時に予約しても、2人だけが予約できる', async () => {
    const f = await setup();
    const kids = await Promise.all(Array.from({ length: 5 }, (_, i) => f.mkStudent(`生徒${i}`, { credits: 4 })));
    const startsAt = jst('2026-10-24', '10:00');
    const results = await Promise.allSettled(
      kids.map((k) =>
        bookAsStudent(f.ctx, k.actor, { studentId: k.student.id, teacherId: f.teacherA.teacher.id, lessonTypeId: f.groupType.id, startsAt }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
  });
});
