import type { Db } from '../db/client.js';
import type { Notifier } from './notify.js';

export type Role = 'student' | 'teacher' | 'admin';

/** 操作した人。system は定期処理や Stripe の通知による処理 */
export type Actor = { kind: 'account'; accountId: string; role: Role } | { kind: 'system' };

export interface Ctx {
  db: Db;
  now: () => Date;
  notifier: Notifier;
}

export const SYSTEM: Actor = { kind: 'system' };

export function actorId(actor: Actor): string | null {
  return actor.kind === 'account' ? actor.accountId : null;
}

export function isAdmin(actor: Actor): boolean {
  return actor.kind === 'system' || actor.role === 'admin';
}
