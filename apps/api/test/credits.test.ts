import { describe, expect, test } from 'vitest';
import { auditLogs } from '../src/db/schema.js';
import { adjustCredits, balance, closeMonth, ledgerOf } from '../src/domain/credits.js';
import { updateSettings } from '../src/domain/settings.js';
import { setup } from './fixtures.js';

describe('PY-07 回数の失効と繰越', () => {
  test('繰越なしの設定では、余った回数は月末で失効する', async () => {
    const f = await setup();
    const { student } = await f.mkStudent('太郎', { credits: 4 });
    await closeMonth(f.ctx, '2026-10');
    expect(await balance(f.db, student.id, '2026-10')).toBe(0);
    expect(await balance(f.db, student.id, '2026-11')).toBe(0);
  });

  test('繰越ありの設定では、上限までを翌月に繰り越す', async () => {
    const f = await setup();
    await updateSettings(f.db, { carryoverEnabled: true, carryoverMax: 2 }, null);
    const { student } = await f.mkStudent('太郎', { credits: 3 });
    const { student: other } = await f.mkStudent('花子', { credits: 1 });
    await closeMonth(f.ctx, '2026-10');
    expect(await balance(f.db, student.id, '2026-11')).toBe(2);
    expect(await balance(f.db, other.id, '2026-11')).toBe(1);
  });

  test('二度処理しても結果は同じ', async () => {
    const f = await setup();
    await updateSettings(f.db, { carryoverEnabled: true, carryoverMax: 2 }, null);
    const { student } = await f.mkStudent('太郎', { credits: 3 });
    await closeMonth(f.ctx, '2026-10');
    await closeMonth(f.ctx, '2026-10');
    expect(await balance(f.db, student.id, '2026-11')).toBe(2);
  });
});

describe('OP-03 / OP-04 回数の手動調整と履歴', () => {
  test('調整は理由と操作した人が履歴に残る', async () => {
    const f = await setup();
    const { student } = await f.mkStudent('太郎', { credits: 4 });
    expect(await adjustCredits(f.ctx, f.admin, { studentId: student.id, month: '2026-10', delta: 1, note: '振替' })).toBe(5);
    const ledger = await ledgerOf(f.db, student.id);
    expect(ledger.map((l) => [l.reason, l.delta, l.note])).toEqual([
      ['grant_monthly', 4, ''],
      ['adjust', 1, '振替'],
    ]);
    expect(ledger[1]!.actorAccountId).toBe(f.adminAccount.id);
    const logs = await f.db.select().from(auditLogs);
    expect(logs.map((l) => l.action)).toEqual(['credits.adjust']);
  });

  test('理由のない調整は受け付けない', async () => {
    const f = await setup();
    const { student } = await f.mkStudent('太郎', { credits: 4 });
    await expect(adjustCredits(f.ctx, f.admin, { studentId: student.id, month: '2026-10', delta: 1, note: ' ' })).rejects.toThrow(
      '調整の理由',
    );
  });
});
