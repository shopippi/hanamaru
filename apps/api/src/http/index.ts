import { handlePaymentEvent } from '../domain/billing.js';
import { trackedRun } from '../domain/system.js';
import { createBaseApp, type AppDeps } from './app.js';
import { manageRoutes } from './manage-routes.js';
import { staffRoutes } from './staff-routes.js';
import { studentRoutes } from './student-routes.js';

/**
 * API 全体。本番では各サブドメインの /api を、それぞれのポータルへ振り分ける（4.4）。
 *   student.hanamarumusic.com/api/* → /api/student/*
 *   staff.hanamarumusic.com/api/*   → /api/staff/*
 *   manage.hanamarumusic.com/api/*  → /api/manage/*
 */
export function createApp(deps: AppDeps) {
  const app = createBaseApp(deps.ctx.db);
  app.route('/api/student', studentRoutes(deps));
  app.route('/api/staff', staffRoutes(deps));
  app.route('/api/manage', manageRoutes(deps));

  // Stripe の通知（PY-05）。署名を確かめてから処理する。処理に失敗したら 500 を返して再送させる
  app.post('/api/stripe/webhook', async (c) => {
    const raw = await c.req.text();
    let event;
    try {
      event = await deps.ctx.payments.parseWebhook(raw, c.req.header('stripe-signature') ?? '');
    } catch {
      return c.json({ error: 'invalid signature' }, 400);
    }
    if (!event) return c.json({ received: true, handled: false });
    // 受け取った時刻と成否を記録し、失敗が続いたら管理者に知らせる（OP-05）。署名の誤りは数えない
    const result = await trackedRun(deps.ctx, 'stripeWebhook', () => handlePaymentEvent(deps.ctx, event));
    return c.json({ received: true, result });
  });
  return app;
}
