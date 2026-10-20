import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../src/db/schema.js';
import { MIGRATIONS_DIR, type Db } from '../src/db/client.js';

// マイグレーション済みのデータベースを1つ作り、テストごとに複製する（メモリ上の PostgreSQL）
let template: Promise<PGlite> | null = null;

function migrated(): Promise<PGlite> {
  template ??= (async () => {
    const client = new PGlite();
    await migrate(drizzle(client, { schema }), { migrationsFolder: MIGRATIONS_DIR });
    return client;
  })();
  return template;
}

/** テストごとに空のデータベースを作る */
export async function testDb(): Promise<Db> {
  const client = (await (await migrated()).clone()) as PGlite;
  return drizzle(client, { schema }) as unknown as Db;
}
