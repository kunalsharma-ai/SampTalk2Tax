import { describe, expect, it } from 'vitest';
import { compareDuplicates, duplicateFileRisk } from '../src';

describe('duplicate files across records', () => {
  it('is serious when one file supports spending twice', () => {
    expect(duplicateFileRisk(['EXPENSE_CLAIM', 'EXPENSE_CLAIM']).risk).toBe('HIGH');
    expect(duplicateFileRisk(['BILL', 'OTHER', 'BILL']).risk).toBe('HIGH');
    expect(duplicateFileRisk(['EXPENSE_CLAIM', 'BILL']).risk).toBe('MEDIUM');
    expect(duplicateFileRisk(['OTHER', 'OTHER']).risk).toBe('LOW');
    expect(duplicateFileRisk(['BILL', 'OTHER']).reason).toMatch(/shared/);
  });

  it('sorts the most serious first, then the latest', () => {
    const rows = [
      { risk: 'LOW' as const, latest: '2026-11-10' },
      { risk: 'HIGH' as const, latest: '2026-10-01' },
      { risk: 'HIGH' as const, latest: '2026-11-01' },
      { risk: 'MEDIUM' as const, latest: '2026-11-15' },
    ];
    expect(rows.sort(compareDuplicates).map((r) => `${r.risk} ${r.latest}`)).toEqual(['HIGH 2026-11-01', 'HIGH 2026-10-01', 'MEDIUM 2026-11-15', 'LOW 2026-11-10']);
  });
});
