import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { students } from '../src/db/schema.js';
import { createCourse, enrollmentOptions, savePackage, startEnrollment } from '../src/domain/billing.js';
import { createStudent, updateStudent } from '../src/domain/people.js';
import { updateSettings } from '../src/domain/settings.js';
import { setup } from './fixtures.js';

// 支払い方法（PY-04）: いまはカードと現金だけ。コンビニ払い・PayPay は設定で有効にしてから使う

async function enrolling() {
  const f = await setup();
  const course = await createCourse(f.ctx, f.admin, { name: '1h×月3回コース', lessonsPerMonth: 3, amount: 15000 });
  const pkg = await savePackage(f.ctx, f.admin, null, { name: '最初の月（3回）', admissionFee: 0, lessonCount: 3, lessonsPrice: 15000 });
  const s = await f.mkStudent('太郎', { autopay: false });
  await f.db.update(students).set({ status: 'enrolling', courseId: course.id }).where(eq(students.id, s.student.id));
  return { f, pkg, ...s };
}

describe('PY-04 使える支払い方法', () => {
  test('PY-04 初期設定では、入会画面にカードだけを出し、コンビニ払い・PayPay では始められない', async () => {
    const { f, pkg, student, actor } = await enrolling();
    expect((await enrollmentOptions(f.ctx, actor, student.id)).methods.map((m) => m.method)).toEqual(['card']);
    for (const method of ['konbini', 'paypay'] as const) {
      await expect(startEnrollment(f.ctx, actor, student.id, { packageId: pkg.id, method, agreed: true })).rejects.toThrow('いまは使えません');
    }
    expect(f.gateway.checkouts).toHaveLength(0);
  });

  test('PY-04 管理者も、止めている支払い方法の生徒は登録・変更できない。カードと現金はできる', async () => {
    const f = await setup();
    const base = { accountEmail: 'new-family@example.test', name: '花子', status: 'active' };
    await expect(createStudent(f.ctx, f.admin, { ...base, billingMethod: 'konbini' })).rejects.toThrow('いまは使えません');
    const s = await createStudent(f.ctx, f.admin, { ...base, billingMethod: 'cash' });
    await expect(updateStudent(f.ctx, f.admin, s.id, { billingMethod: 'paypay' })).rejects.toThrow('いまは使えません');
    await updateStudent(f.ctx, f.admin, s.id, { billingMethod: 'card' });
  });

  test('PY-04 設定でコンビニ払い・PayPay を有効にすると、選べるようになる', async () => {
    const { f, pkg, student, actor } = await enrolling();
    await updateSettings(f.db, { konbiniEnabled: true, paypayEnabled: true }, null);
    expect((await enrollmentOptions(f.ctx, actor, student.id)).methods.map((m) => m.method)).toEqual(['card', 'konbini', 'paypay']);
    await startEnrollment(f.ctx, actor, student.id, { packageId: pkg.id, method: 'paypay', agreed: true });
    expect(f.gateway.checkouts.at(-1)?.method).toBe('paypay');
  });
});
