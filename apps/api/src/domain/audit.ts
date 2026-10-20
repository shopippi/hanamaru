import { auditLogs } from '../db/schema.js';
import type { Db } from '../db/client.js';
import { actorId, type Actor } from './context.js';

/** 管理者の操作記録（OP-03）。誰が・いつ・何をしたか */
export async function audit(
  db: Db,
  actor: Actor,
  action: string,
  targetType: string,
  targetId: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(auditLogs).values({ actorAccountId: actorId(actor), action, targetType, targetId, details });
}
