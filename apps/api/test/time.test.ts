import { describe, expect, test } from 'vitest';
import { billingAnchor, billingMonthOf } from '../src/lib/time.js';

describe('PY-03 月額の課金日と対象月', () => {
  test('PY-03 自動課金の基準は1日 9:00（日本時間）で、UTC でも1日になる', () => {
    for (const m of ['2026-11', '2026-12', '2027-01', '2027-03', '2027-05', '2027-07', '2027-10']) {
      const at = billingAnchor(m);
      expect(at.getUTCDate()).toBe(1);
      expect(at.toISOString()).toBe(`${m}-01T00:00:00.000Z`);
    }
  });

  test('PY-05 請求期間の開始が前後にずれても、いちばん近い月の月謝として扱う（12月・1月・3月をまたぐ）', () => {
    // 日本時間の1日 0:00（UTC では前月末）
    expect(billingMonthOf(new Date('2026-11-30T15:00:00Z'))).toBe('2026-12');
    expect(billingMonthOf(new Date('2027-02-28T15:00:00Z'))).toBe('2027-03');
    // 課金日が前月末（日本時間の12月31日）にずれた請求は1月分
    expect(billingMonthOf(new Date('2026-12-30T15:00:00Z'))).toBe('2027-01');
    expect(billingMonthOf(new Date('2027-02-27T15:00:00Z'))).toBe('2027-03');
    // 1日 9:00（基準どおり）や、数日遅れた請求はその月
    expect(billingMonthOf(new Date('2027-01-01T00:00:00Z'))).toBe('2027-01');
    expect(billingMonthOf(new Date('2027-03-03T00:00:00Z'))).toBe('2027-03');
    expect(billingMonthOf(new Date('2026-12-01T00:00:00Z'))).toBe('2026-12');
  });
});
