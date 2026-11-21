import { describe, expect, it } from 'vitest';
import { dutyConflicts, sodFindings, sodReviewIssue, type SodFacts } from '../src';

const empty: SodFacts = { journals: [], bills: [], batches: [], bankDetailChanges: [], payments: [], reconciliations: [] };

describe('segregation-of-duties checks (AUDIT-014)', () => {
  it('flags manual journals and bills one person both prepared and posted, and nothing else', () => {
    const f = sodFindings({
      ...empty,
      journals: [
        { id: 'j1', number: 'JE-1', date: '2026-10-01', source: 'MANUAL', createdById: 'a', postedById: 'a', amount: '100.00' },
        { id: 'j2', number: 'JE-2', date: '2026-10-02', source: 'MANUAL', createdById: 'a', postedById: 'b', amount: '5.00' },
        { id: 'j3', number: 'JE-3', date: '2026-10-03', source: 'DEPRECIATION', createdById: 'a', postedById: 'a', amount: '9.00' },
        { id: 'j4', number: null, date: '2026-10-04', source: 'MANUAL', createdById: 'a', postedById: null, amount: '9.00' },
      ],
      bills: [
        { id: 'b1', number: 'BILL-1', date: '2026-10-05', contactId: 'v', createdById: 'c', postedById: 'c', amount: '250.00' },
        { id: 'b2', number: 'BILL-2', date: '2026-10-06', contactId: 'v', createdById: 'c', postedById: 'a', amount: '250.00' },
      ],
    });
    expect(f.map((x) => [x.key, x.people])).toEqual([
      ['SELF_POSTED_BILL:b1', ['c']],
      ['SELF_POSTED_JOURNAL:j1', ['a']],
    ]);
  });

  it('flags a self-approved payment batch', () => {
    const f = sodFindings({ ...empty, batches: [{ id: 'p1', reference: 'PB-1', date: '2026-10-09', createdById: 'a', approvedById: 'a', selfApproved: true, amount: '10.00' }, { id: 'p2', reference: 'PB-2', date: '2026-10-09', createdById: 'a', approvedById: 'b', selfApproved: false, amount: '10.00' }] });
    expect(f.map((x) => x.key)).toEqual(['SELF_APPROVED_PAYMENT_BATCH:p1']);
  });

  it('flags a payment by the person who changed the vendor’s bank details before it', () => {
    const pay = (id: string, date: string, by: string, status = 'POSTED') => ({ id, number: id.toUpperCase(), date, contactId: 'v', bankAccountId: 'bank', createdById: by, amount: '900.00', status });
    const f = sodFindings({
      ...empty,
      bankDetailChanges: [{ contactId: 'v', changedById: 'a', changedAt: '2026-10-10T09:00:00.000Z' }],
      payments: [pay('p1', '2026-10-09', 'a'), pay('p2', '2026-10-10', 'a'), pay('p3', '2026-10-12', 'b'), pay('p4', '2026-10-13', 'a', 'VOID')],
    });
    expect(f.map((x) => [x.key, x.detail])).toEqual([['BANK_DETAILS_CHANGED_THEN_PAID:p2', 'Bank details changed on 2026-10-10 by the person who recorded this payment']]);
  });

  it('flags a reconciliation by the person who recorded payments it covers', () => {
    const payments = [{ id: 'p1', number: 'P1', date: '2026-10-15', contactId: 'v', bankAccountId: 'bank', createdById: 'a', amount: '1.00', status: 'POSTED' }];
    const rec = (id: string, by: string, accountId = 'bank', status = 'COMPLETED') => ({ id, accountId, startDate: '2026-10-01', statementDate: '2026-10-31', completedById: by, completedAt: '2026-11-01T00:00:00.000Z', status });
    const f = sodFindings({ ...empty, payments, reconciliations: [rec('r1', 'a'), rec('r2', 'b'), rec('r3', 'a', 'other'), rec('r4', 'a', 'bank', 'UNDONE')] });
    expect(f.map((x) => [x.key, x.detail])).toEqual([['RECONCILED_OWN_PAYMENTS:r1', 'A payment it covers was recorded by the same person']]);
  });

  it('names the conflicting duties a set of permissions holds', () => {
    const accountant = new Set(['journals.create', 'journals.post', 'contacts.manage', 'banking.manage', 'banking.reconcile', 'purchases.manage', 'payroll.manage']);
    expect(dutyConflicts((p) => accountant.has(p)).map((c) => c.id)).toEqual(['PREPARE_AND_POST_JOURNALS', 'VENDORS_AND_PAYMENTS', 'PAY_AND_RECONCILE', 'PAYROLL_AND_POST']);
    expect(dutyConflicts((p) => p === 'journals.post' || p === 'approvals.decide')).toEqual([]);
  });

  it('lets only someone who was not involved clear a finding, with a reason', () => {
    expect(sodReviewIssue({ people: ['a'] }, 'a', 'Checked the invoice behind it')).toMatch(/cannot clear/);
    expect(sodReviewIssue({ people: ['a'] }, 'b', 'ok')).toMatch(/reason/);
    expect(sodReviewIssue({ people: ['a'] }, 'b', 'Checked the invoice behind it')).toBeNull();
  });
});
