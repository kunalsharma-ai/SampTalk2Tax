import { describe, expect, it } from 'vitest';
import { collectExpenseEvidence, expenseEvidenceCsv, type EvidenceClaim } from '../src/expense-evidence';

const base: EvidenceClaim = {
  status: 'REIMBURSED',
  claimantId: 'u1',
  approvedOn: '2026-11-01',
  approver: { id: 'u2', name: 'Anil Approver' },
  decidedAt: '2026-11-01T09:30:00.000Z',
  decisionNote: null,
  policyExceptions: [],
  receipts: [{ fileName: 'taxi.pdf', sha256: 'a'.repeat(64) }],
  journal: { number: 'JE-000010', posted: true },
  reimbursement: { date: '2026-11-05', account: '1120 · Operating Bank Account', cash: false, journal: 'JE-000011', onStatement: true, statementThrough: '2026-11-20' },
  voided: null,
  auditActions: ['expense_claim.created', 'expense_claim.submitted', 'expense_claim.approved', 'expense_claim.reimbursed'],
};
const states = (c: EvidenceClaim) => Object.fromEntries(collectExpenseEvidence(c).items.map((i) => [i.kind, i.state]));

describe('expense audit evidence (EXP-027)', () => {
  it('finds a fully evidenced claim complete', () => {
    const e = collectExpenseEvidence(base);
    expect(e.complete).toBe(true);
    expect(e.gaps).toEqual([]);
    expect(e.items.map((i) => [i.kind, i.state])).toEqual([['RECEIPTS', 'OK'], ['APPROVAL', 'OK'], ['POLICY', 'OK'], ['POSTING', 'OK'], ['PAYMENT', 'OK'], ['BANK', 'OK'], ['AUDIT_TRAIL', 'OK']]);
    expect(e.items[1]!.detail).toBe('Approved by Anil Approver at 2026-11-01 09:30 UTC, posted on 2026-11-01');
    expect(e.items[4]!.detail).toBe('Reimbursed on 2026-11-05 from 1120 · Operating Bank Account (JE-000011)');
    expect(e.items[6]!.detail).toBe('4 events in the hash-chained audit trail');
  });

  it('records gaps: no receipt, policy exception without a note, payment missing from a statement that covers it', () => {
    const e = collectExpenseEvidence({ ...base, receipts: [], policyExceptions: ['Meals above 1,500 a day'], reimbursement: { ...base.reimbursement!, onStatement: false, statementThrough: '2026-11-09' } });
    expect(e.complete).toBe(false);
    expect(e.gaps).toEqual(['RECEIPTS', 'POLICY', 'BANK']);
    expect(e.items.find((i) => i.kind === 'BANK')!.detail).toBe('Not matched on the statement, which runs to 2026-11-09');
    expect(e.items.find((i) => i.kind === 'POLICY')!.detail).toBe('Approved outside the policy (Meals above 1,500 a day) without a note');
  });

  it('treats a noted exception, a recent statement, cash and unpaid claims as not gaps', () => {
    expect(states({ ...base, policyExceptions: ['No receipt'], decisionNote: 'Lost; confirmed with vendor' }).POLICY).toBe('NOTED');
    expect(states({ ...base, reimbursement: { ...base.reimbursement!, onStatement: false, statementThrough: '2026-11-08' } }).BANK).toBe('PENDING');
    expect(states({ ...base, reimbursement: { ...base.reimbursement!, onStatement: false, statementThrough: null } }).BANK).toBe('PENDING');
    expect(states({ ...base, reimbursement: { ...base.reimbursement!, cash: true, onStatement: false } }).BANK).toBe('NA');
    const unpaid = collectExpenseEvidence({ ...base, status: 'APPROVED', reimbursement: null, auditActions: ['expense_claim.approved'] });
    expect(unpaid.complete).toBe(true);
    expect(unpaid.items.map((i) => i.state)).toEqual(['OK', 'OK', 'OK', 'OK', 'PENDING', 'NA', 'OK']);
  });

  it('flags a void claim whose void is missing from the audit trail, and self-approval', () => {
    const v = collectExpenseEvidence({ ...base, status: 'VOID', reimbursement: null, voided: { date: '2026-11-03', reason: 'Duplicate' }, auditActions: ['expense_claim.approved'] });
    expect(v.gaps).toEqual(['AUDIT_TRAIL']);
    expect(v.items.find((i) => i.kind === 'PAYMENT')!.detail).toBe('Voided on 2026-11-03: Duplicate');
    expect(v.items.find((i) => i.kind === 'AUDIT_TRAIL')!.detail).toBe('Missing from the audit trail: voided');
    expect(collectExpenseEvidence({ ...base, approver: { id: 'u1', name: 'Self' } }).gaps).toEqual(['APPROVAL']);
  });

  it('writes a CSV index with files and guards against formulas', () => {
    const e = collectExpenseEvidence(base);
    const csv = expenseEvidenceCsv([{ number: 'EXP-000001', claimant: '=HYPERLINK("x")', status: 'REIMBURSED', total: '1200.00', items: e.items.slice(0, 1), receipts: base.receipts }]);
    expect(csv).toBe(
      [
        'Claim,Claimant,Status,Total,Evidence,State,Detail,File,SHA-256',
        `EXP-000001,"'=HYPERLINK(""x"")",REIMBURSED,1200.00,Receipts,OK,"1 file attached, each with its SHA-256 checksum",,`,
        `EXP-000001,"'=HYPERLINK(""x"")",REIMBURSED,1200.00,Receipt file,OK,,taxi.pdf,${'a'.repeat(64)}`,
        '',
      ].join('\n'),
    );
  });
});
