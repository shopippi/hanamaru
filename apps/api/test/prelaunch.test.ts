import { describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { auditLogs, students } from '../src/db/schema.js';
import { createCourse, enrollmentOptions, handlePaymentEvent, savePackage, startEnrollment } from '../src/domain/billing.js';
import { StripeGateway } from '../src/integrations/stripe.js';
import { billingAnchor } from '../src/lib/time.js';
import { setup } from './fixtures.js';

// カードの決済を始める前の調査（docs/stripe-prelaunch.md）で見つかったことの再発防止

async function enrollingStudent() {
  const f = await setup();
  const course = await createCourse(f.ctx, f.admin, { name: '月4回コース', lessonsPerMonth: 4, amount: 14300 });
  const pkg = await savePackage(f.ctx, f.admin, null, { name: '入会金＋4回', admissionFee: 5500, lessonCount: 4, lessonsPrice: 14300 });
  const s = await f.mkStudent('太郎', { autopay: false });
  await f.db.update(students).set({ status: 'enrolling', courseId: course.id }).where(eq(students.id, s.student.id));
  return { f, pkg, ...s };
}

describe('PY-03 / PY-04 入会時の同意', () => {
  test('PY-04 契約の内容と利用規約に同意しないと、お支払いに進めない', async () => {
    const { f, pkg, student, actor } = await enrollingStudent();
    await expect(startEnrollment(f.ctx, actor, student.id, { packageId: pkg.id, method: 'card', agreed: false })).rejects.toThrow('同意が必要です');
    expect(f.gateway.checkouts).toHaveLength(0);
  });

  test('PY-04 同意してお支払いに進むと、いつ同意したかが記録に残る', async () => {
    const { f, pkg, student, actor } = await enrollingStudent();
    await startEnrollment(f.ctx, actor, student.id, { packageId: pkg.id, method: 'card', agreed: true });
    const rows = await f.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'student.terms_agreed'), eq(auditLogs.targetId, student.id)));
    expect(rows).toHaveLength(1);
  });

  test('PY-04 入会画面に出す契約の内容は、設定値（キャンセルの締切・繰り越し）から作り、未確定の未払いの扱いは出さない', async () => {
    const { f, student, actor } = await enrollingStudent();
    expect((await enrollmentOptions(f.ctx, actor, student.id)).terms).toEqual({
      cancelDeadlineHours: 24,
      cancelDeadline: 'レッスンの前日20時まで',
      carryover: true,
    });
  });
});

describe('PY-11 自動課金の失敗', () => {
  test('PY-11 Stripe が引き落としを何度やり直して失敗しても、失敗のメールは1通だけ', async () => {
    const f = await setup();
    const { student } = await f.mkStudent('太郎');
    const ev = (n: number) => ({
      id: `evt_fail_${n}`,
      type: 'invoice_failed' as const,
      subscriptionId: 'sub_test',
      invoiceId: 'in_nov',
      periodStart: billingAnchor('2026-11'),
      amount: 14300,
      hostedUrl: 'https://invoice.stripe.test/i/1',
    });
    for (const n of [1, 2, 3]) await handlePaymentEvent(f.ctx, ev(n));
    const mails = f.mail.sent.filter((m) => m.subject.includes('月謝のお支払いができませんでした'));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe('太郎@example.test');
    expect(student.id).toBeTruthy();
  });

  test('PY-11 自動課金で本人認証（3-D セキュア）が求められたら、失敗と同じく生徒にお支払いの画面を知らせる', async () => {
    const secret = 'whsec_test_secret';
    const gw = new StripeGateway('sk_test_dummy', secret, 'bpc_1');
    const start = Math.floor(billingAnchor('2026-11').getTime() / 1000);
    const raw = JSON.stringify({
      id: 'evt_action',
      object: 'event',
      type: 'invoice.payment_action_required',
      data: {
        object: {
          id: 'in_1',
          object: 'invoice',
          amount_due: 14300,
          hosted_invoice_url: 'https://invoice.stripe.test/i/1',
          parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } },
          lines: { data: [{ period: { start, end: start + 2_678_400 } }] },
        },
      },
    });
    const header = new Stripe('sk_test_dummy').webhooks.generateTestHeaderString({ payload: raw, secret });
    expect(await gw.parseWebhook(raw, header)).toMatchObject({
      type: 'invoice_failed',
      subscriptionId: 'sub_1',
      hostedUrl: 'https://invoice.stripe.test/i/1',
    });
  });
});
