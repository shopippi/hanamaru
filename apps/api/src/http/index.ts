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
  const app = createBaseApp();
  app.route('/api/student', studentRoutes(deps));
  app.route('/api/staff', staffRoutes(deps));
  app.route('/api/manage', manageRoutes(deps));
  return app;
}
