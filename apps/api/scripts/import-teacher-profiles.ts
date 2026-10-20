import { fileURLToPath } from 'node:url';
import { connect } from '../src/db/client.js';
import { importTeacherProfiles } from '../src/domain/teacher-profiles.js';

// 以前のプロフィールのデータファイル（data/teacher-profiles.json）を、データベースに取り込む（TC-06）。
// プロフィールが空の講師だけに入れるので、何度実行しても同じ結果になる。実行は作成者が行う（CLAUDE.md）。
//   DATABASE_URL=postgres://... pnpm --filter @hanamaru/api exec tsx scripts/import-teacher-profiles.ts

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const dataDir = fileURLToPath(new URL('../data/', import.meta.url));
const { db, close } = await connect(url);
try {
  const r = await importTeacherProfiles(db, `${dataDir}teacher-profiles.json`, (photo) => `${dataDir}${photo}`, new Date());
  console.log(`プロフィール ${r.profiles}件、写真 ${r.photos}件を取り込みました`);
} finally {
  await close();
}
