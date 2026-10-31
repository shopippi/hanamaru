import { describe, expect, test } from 'vitest';
import { setupHttp } from './http.js';

// エラーの文言は、画面にそのまま出せる日本語にする（CLAUDE.md・UI-16）

describe('UI-16 入力の誤りの文言', () => {
  test('UI-16 入力の誤りは、英語や内部の型の名前を出さず、日本語で返す', async () => {
    const f = await setupHttp();
    const admin = await f.adminBrowser();
    const { student } = await f.mkStudent('太郎');
    const cases: [string, unknown][] = [
      // 長すぎる理由・空の理由・数でない回数
      [`/students/${student.id}/credits`, { month: '2026-10', delta: 1, note: 'あ'.repeat(501) }],
      [`/students/${student.id}/credits`, { month: '2026-10', delta: 'たくさん', note: '振替' }],
      [`/students/${student.id}/credits`, { month: '10月', delta: 1, note: '振替' }],
    ];
    for (const [path, json] of cases) {
      const r = await admin.post(path, json);
      expect(r.status, JSON.stringify(json)).toBe(400);
      expect(r.data.error, JSON.stringify(json)).not.toMatch(/[A-Za-z]{3,}/);
    }
  });
});
