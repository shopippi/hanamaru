import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIT_LABELS, auditLogsForAdmin } from '../src/domain/audit.js';
import { adjustCredits } from '../src/domain/credits.js';
import { changeStudentStatus } from '../src/domain/people.js';
import { setup } from './fixtures.js';

// 操作記録（OP-03）: 管理者が読める日本語で出す

const SRC_DIRS = [join(import.meta.dirname, '../src/domain'), join(import.meta.dirname, '../src/http')];

/** コードの中で audit() に渡している操作の名前（`student.note.${kind}` は admin・teacher の2つ） */
function actionsInCode(): string[] {
  const found = new Set<string>(['student.note.admin', 'student.note.teacher']);
  for (const dir of SRC_DIRS) for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(/audit\(\s*[^,]+,\s*[^,]+,\s*(?:[^,]*\?\s*)?'([a-z_.]+)'(?:\s*:\s*'([a-z_.]+)')?/g)) {
      found.add(m[1]!);
      if (m[2]) found.add(m[2]);
    }
  }
  return [...found].sort();
}

describe('OP-03 操作記録', () => {
  test('OP-03 コードで記録しているすべての操作に、日本語の名前がある', () => {
    const actions = actionsInCode();
    expect(actions.length).toBeGreaterThan(20);
    expect(actions.filter((a) => !AUDIT_LABELS[a])).toEqual([]);
  });

  test('OP-03 操作記録は、操作の名前・操作した人・対象の名前・内容を、内部の記号を出さずに返す', async () => {
    const f = await setup();
    const { student } = await f.mkStudent('太郎');
    await adjustCredits(f.ctx, f.admin, { studentId: student.id, month: '2026-10', delta: 2, note: '振替の分' });
    await changeStudentStatus(f.ctx, f.admin, student.id, 'suspended');

    const logs = await auditLogsForAdmin(f.ctx, f.admin, {});
    const adjust = logs.find((l) => l.label === '回数の手動調整')!;
    expect(adjust).toMatchObject({ actorName: '松田', targetName: '太郎' });
    expect(adjust.summary).toContain('2026年10月');
    expect(adjust.summary).toContain('+2回');
    expect(adjust.summary).toContain('振替の分');
    const status = logs.find((l) => l.label === '状態の変更')!;
    expect(status.summary).toContain('休会');
    for (const l of logs) {
      // UUID や JSON、英字の内部の名前をそのまま出さない
      expect(l.summary).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(l.summary).not.toMatch(/[{}"]/);
      expect(l.label).not.toMatch(/^[a-z_.]+$/);
    }
  });

  test('OP-03 操作記録は管理者だけが読める', async () => {
    const f = await setup();
    const { actor } = await f.mkStudent('太郎');
    await expect(auditLogsForAdmin(f.ctx, actor, {})).rejects.toThrow();
  });
});
