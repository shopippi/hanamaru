import { eq } from 'drizzle-orm';
import { connect } from '../src/db/client.js';
import { accounts } from '../src/db/schema.js';
import { issueInvite, normalizeEmail } from '../src/domain/auth.js';
import type { Ctx } from '../src/domain/context.js';

// 最初の管理者を作り、パスワードを決める招待リンクを1回だけ表示する（ST-01、AU-06）。
// メール送信を設定する前でも使える。同じメールで何度実行しても管理者は1人のまま（リンクだけ新しくなる）。
// 実行は作成者が行う（7.3）。本番の VPS で:
//   docker compose -f infra/compose.yml --env-file infra/.env exec api node --import tsx scripts/create-admin.ts <メール> <表示名>

const [email, displayName = '管理者'] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
const manageUrl = process.env.MANAGE_URL;
if (!email || !url || !manageUrl) {
  console.error('使い方: create-admin.ts <メール> [表示名]（DATABASE_URL と MANAGE_URL が必要）');
  process.exit(1);
}

const { db, close } = await connect(url);
try {
  const normalized = normalizeEmail(email);
  let [account] = await db.select().from(accounts).where(eq(accounts.email, normalized));
  if (account && account.role !== 'admin') {
    console.error('このメールは生徒または講師のアカウントで使われています。別のメールを指定してください');
    process.exit(1);
  }
  if (!account) {
    [account] = await db.insert(accounts).values({ email: normalized, role: 'admin', displayName }).returning();
  }
  // 招待のメールは送らず（まだ送れないことがある）、リンクを画面に出すだけにする
  const ctx = {
    db,
    now: () => new Date(),
    notifier: { send: async () => {} },
    urls: { student: manageUrl, staff: manageUrl, manage: manageUrl },
  } as unknown as Ctx;
  const token = await issueInvite(ctx, account!);
  console.log(`管理者: ${account!.email}`);
  console.log(`次のリンクを開いてパスワードを決めてください（1回だけ使えます）。最初のログインで二段階認証を登録します:`);
  console.log(`${manageUrl}/invite?token=${token}`);
} finally {
  await close();
}
