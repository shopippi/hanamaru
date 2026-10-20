import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { onTestFinished } from 'vitest';
import * as schema from '../src/db/schema.js';
import { MIGRATIONS_DIR, type Db } from '../src/db/client.js';

// テストごとに空のデータベースを作る。
// - 既定: メモリ上の PostgreSQL（PGlite）。マイグレーション済みのものを1つ作り、テストごとに複製する
// - TEST_DATABASE_URL を指定: 本物の PostgreSQL に、テストごとのデータベースを作る（同時実行・ロックの確認用）
//     TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/postgres pnpm --filter @hanamaru/api test

const SERVER_URL = process.env.TEST_DATABASE_URL;
const TEMPLATE = 'hanamaru_test_template';

let template: Promise<unknown> | null = null;

function pgliteTemplate(): Promise<PGlite> {
  template ??= (async () => {
    const client = new PGlite();
    await migratePglite(drizzlePglite(client, { schema }), { migrationsFolder: MIGRATIONS_DIR });
    return client;
  })();
  return template as Promise<PGlite>;
}

const withDb = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

/** 本物の PostgreSQL にマイグレーション済みのひな形を作る（テストファイルごとに1回） */
function pgTemplate(): Promise<void> {
  template ??= (async () => {
    const admin = new pg.Client({ connectionString: SERVER_URL });
    await admin.connect();
    // 並行して走るテストファイルどうしで、ひな形を作るのを1回にする
    await admin.query('select pg_advisory_lock(424242)');
    try {
      const exists = await admin.query('select 1 from pg_database where datname = $1', [TEMPLATE]);
      if (exists.rowCount === 0) {
        await admin.query(`create database ${TEMPLATE}`);
        const pool = new pg.Pool({ connectionString: withDb(SERVER_URL!, TEMPLATE) });
        await migratePg(drizzlePg(pool, { schema }), { migrationsFolder: MIGRATIONS_DIR });
        await pool.end();
      }
    } finally {
      await admin.query('select pg_advisory_unlock(424242)');
      await admin.end();
    }
  })();
  return template as Promise<void>;
}

export async function testDb(): Promise<Db> {
  if (!SERVER_URL) {
    const client = (await (await pgliteTemplate()).clone()) as PGlite;
    // メモリを返す（閉じないとテストの数だけ WASM のメモリが残る）
    onTestFinished(() => client.close());
    return drizzlePglite(client, { schema }) as unknown as Db;
  }
  await pgTemplate();
  const name = `hanamaru_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: SERVER_URL });
  await admin.connect();
  await admin.query(`create database ${name} template ${TEMPLATE}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: withDb(SERVER_URL, name), max: 5 });
  onTestFinished(async () => {
    await pool.end();
    const a = new pg.Client({ connectionString: SERVER_URL });
    await a.connect();
    await a.query(`drop database if exists ${name}`);
    await a.end();
  });
  return drizzlePg(pool, { schema }) as unknown as Db;
}
