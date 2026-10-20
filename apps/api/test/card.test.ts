import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { payments, students } from '../src/db/schema.js';
import { createCourse, handlePaymentEvent, prepareMonth, reconcilePayments, resendCardRequest, startCardRegistration } from '../src/domain/billing.js';
import { balance } from '../src/domain/credits.js';
import { studentHome } from '../src/domain/home.js';
import { updateStudent } from '../src/domain/people.js';
import { billingAnchor } from '../src/lib/time.js';
import { setup } from './fixtures.js';

// カードの登録（PY-03）: カード払いなのにカードがない在籍中の生徒は、生徒の画面からカードを登録する。
// 登録が済んだら翌月1日から自動課金を始める（日割りなし）

async function noCardStudent() {
  const f = await setup();
  const course = await createCourse(f.ctx, f.admin, { name: '月4回コース', lessonsPerMonth: 4, amount: 14300 });
  const { student, actor } = await f.mkStudent('太郎', { autopay: false });
  await f.db.update(students).set({ courseId: course.id }).where(eq(students.id, student.id));
  const reload = async () => (await f.db.select().from(students).where(eq(students.id, student.id)))[0]!;
  return { f, student, actor, reload };
}

describe('PY-03 カードの登録', () => {
  test('PY-03 カード払いでカードのない生徒は、トップで登録を求められ、カードだけを登録すると翌月1日から自動課金が始まる', async () => {
    const { f, student, actor, reload } = await noCardStudent();
    expect((await studentHome(f.ctx, actor, student.id)).needsCard).toBe(true);

    const { url } = await startCardRegistration(f.ctx, actor, student.id);
    const setupSession = f.gateway.cardSetups.at(-1)!;
    expect(url).toBe(setupSession.url);
    expect(setupSession.studentId).toBe(student.id);
    expect((await reload()).cardSetupSessionId).toBe(setupSession.id);

    await handlePaymentEvent(f.ctx, { id: 'evt_setup', type: 'card_registered', studentId: student.id, sessionId: setupSession.id, paymentMethodId: 'pm_new' });
    const sub = f.gateway.subscriptions.at(-1)!;
    expect(sub).toMatchObject({ customerId: setupSession.customerId, startAt: billingAnchor('2026-11'), paymentMethodId: 'pm_new' });
    const after = await reload();
    expect(after.stripeSubscriptionId).toBe(sub.id);
    expect(after.cardSetupSessionId).toBeNull();
    expect((await studentHome(f.ctx, actor, student.id)).needsCard).toBe(false);
  });

  test('PY-03 今月分のカード払いが未払いなら、今月分を払ってカードを保存し、回数を付けて翌月から自動課金にする', async () => {
    const { f, student, actor, reload } = await noCardStudent();
    await prepareMonth(f.ctx, '2026-10');
    expect((await studentHome(f.ctx, actor, student.id)).payment).toBe('unpaid');

    await startCardRegistration(f.ctx, actor, student.id);
    const checkout = f.gateway.checkouts.at(-1)!;
    expect(checkout).toMatchObject({ method: 'card', saveCard: true, amount: 14300 });
    expect(f.gateway.cardSetups).toHaveLength(0);

    await handlePaymentEvent(f.ctx, { id: 'evt_pay', type: 'checkout_paid', paymentId: checkout.paymentId, sessionId: checkout.id, paymentMethodId: 'pm_new' });
    expect(await balance(f.db, student.id, '2026-10')).toBe(4);
    expect(f.gateway.subscriptions.at(-1)).toMatchObject({ startAt: billingAnchor('2026-11'), paymentMethodId: 'pm_new' });
    expect((await reload()).stripeSubscriptionId).toBe(f.gateway.subscriptions.at(-1)!.id);
  });

  test('PY-03 / OP-02 登録の通知が届かなくても、照合で自動課金を始める', async () => {
    const { f, student, actor, reload } = await noCardStudent();
    await startCardRegistration(f.ctx, actor, student.id);
    const id = (await reload()).cardSetupSessionId!;
    f.gateway.cardSetupStatuses.set(id, { status: 'complete', paymentMethodId: 'pm_new' });
    await reconcilePayments(f.ctx);
    expect((await reload()).stripeSubscriptionId).not.toBeNull();
    // 二度照合しても二重に作らない
    await reconcilePayments(f.ctx);
    expect(f.gateway.subscriptions.filter((s) => s.paymentMethodId === 'pm_new')).toHaveLength(1);
  });

  test('PY-03 / PY-06 管理者がカード払いに切り替えると、生徒にカードの登録をお願いし、登録までは自動課金を始めない', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('花子', { autopay: false });
    await f.db.update(students).set({ billingMethod: 'cash' }).where(eq(students.id, student.id));
    const before = f.gateway.subscriptions.length;
    await updateStudent(f.ctx, f.admin, student.id, { billingMethod: 'card' });
    expect(f.gateway.subscriptions).toHaveLength(before);
    const mail = f.mail.sent.find((m) => m.subject.includes('カードのご登録のお願い'));
    expect(mail?.to).toBe('花子@example.test');
    expect(mail?.text).toContain('https://student.example.test/?billing=register');
    expect((await studentHome(f.ctx, actor, student.id)).needsCard).toBe(true);

    // 管理画面から、もう一度お願いを送れる
    await resendCardRequest(f.ctx, f.admin, student.id);
    expect(f.mail.sent.filter((m) => m.subject.includes('カードのご登録のお願い'))).toHaveLength(2);
  });

  test('PY-03 自動課金が始まっている生徒や、ほかの家庭の生徒はカードの登録を始められない', async () => {
    const f = await setup();
    const { student, actor } = await f.mkStudent('太郎');
    await expect(startCardRegistration(f.ctx, actor, student.id)).rejects.toThrow('カードの登録は必要ありません');
    const other = await f.mkStudent('次郎', { autopay: false });
    await expect(startCardRegistration(f.ctx, actor, other.student.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(f.gateway.cardSetups).toHaveLength(0);
    const [p] = await f.db.select().from(payments).where(eq(payments.studentId, other.student.id));
    expect(p).toBeUndefined();
  });
});
