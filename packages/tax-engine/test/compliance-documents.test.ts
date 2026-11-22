import { describe, expect, it } from 'vitest';
import { complianceDocumentGaps, complianceRetainUntil, expectedComplianceDocument } from '../src/india/compliance-documents';

describe('compliance documents', () => {
  it('keeps documents until the end of the eighth financial year after the period', () => {
    expect(complianceRetainUntil('2026-10-31')).toBe('2035-03-31');
    expect(complianceRetainUntil('2027-03-31')).toBe('2035-03-31');
    expect(complianceRetainUntil('2027-04-30')).toBe('2036-03-31');
    expect(complianceRetainUntil(null)).toBeNull();
  });

  it('finds done returns without an acknowledgement and payments without a challan', () => {
    expect(expectedComplianceDocument('RETURN')).toBe('ACKNOWLEDGEMENT');
    expect(expectedComplianceDocument('PAYMENT')).toBe('CHALLAN');
    const done = [
      { key: 'GSTR1:2026-09', name: 'GSTR-1', periodLabel: 'September 2026', dueDate: '2026-10-11', nature: 'RETURN' as const },
      { key: 'GSTR1:2026-10', name: 'GSTR-1', periodLabel: 'October 2026', dueDate: '2026-11-11', nature: 'RETURN' as const },
      { key: 'TDS_DEPOSIT:2026-10', name: 'TDS deposit', periodLabel: 'October 2026', dueDate: '2026-11-07', nature: 'PAYMENT' as const },
      { key: 'PF:2026-10', name: 'PF', periodLabel: 'October 2026', dueDate: '2026-11-15', nature: 'PAYMENT' as const },
    ];
    const gaps = complianceDocumentGaps(done, [
      { obligationKey: 'GSTR1:2026-09', kind: 'ACKNOWLEDGEMENT', files: 1 },
      { obligationKey: 'GSTR1:2026-10', kind: 'RETURN_COPY', files: 1 },
      { obligationKey: 'TDS_DEPOSIT:2026-10', kind: 'CHALLAN', files: 0 },
    ]);
    expect(gaps.map((g) => [g.key, g.needs, g.emptyRecord])).toEqual([
      ['PF:2026-10', 'CHALLAN', false],
      ['GSTR1:2026-10', 'ACKNOWLEDGEMENT', false],
      ['TDS_DEPOSIT:2026-10', 'CHALLAN', true],
    ]);
  });
});
