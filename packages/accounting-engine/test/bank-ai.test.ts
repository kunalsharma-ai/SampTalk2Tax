import { describe, expect, it } from 'vitest';
import { BankLineContext, checkProposal, contextForModel, rankCandidates } from '../src/bank-ai';

const ctx = (amount: string): BankLineContext => ({
  currency: 'INR',
  line: { date: '2026-10-20', amount, description: 'NEFT CR LOTUS RETAIL INV-000012', reference: 'N123' },
  ledger: [
    { ref: 'L1', id: 'jl-1', date: '2026-10-18', amount: '30000.00', text: 'RCT-000004 Lotus Retail' },
    { ref: 'L2', id: 'jl-2', date: '2026-10-19', amount: '20000.00', text: 'RCT-000005 Lotus Retail' },
    { ref: 'L3', id: 'jl-3', date: '2026-10-19', amount: '-1200.00', text: 'Bank charges' },
  ],
  documents: [
    { ref: 'D1', id: 'doc-1', kind: 'INVOICE', number: 'INV-000012', contactRef: 'C1', dueDate: '2026-10-10', balance: '45000.00', reference: 'PO-9' },
    { ref: 'D2', id: 'doc-2', kind: 'INVOICE', number: 'INV-000013', contactRef: 'C1', dueDate: '2026-10-30', balance: '10000.00', reference: null },
    { ref: 'D3', id: 'doc-3', kind: 'INVOICE', number: 'INV-000014', contactRef: 'C2', dueDate: null, balance: '8000.00', reference: null },
    { ref: 'D4', id: 'doc-4', kind: 'BILL', number: 'BILL-000002', contactRef: 'C2', dueDate: null, balance: '8000.00', reference: null },
  ],
  contacts: [
    { ref: 'C1', id: 'c-1', name: 'Lotus Retail' },
    { ref: 'C2', id: 'c-2', name: 'Peacock Stores' },
  ],
  accounts: [{ code: '6500', id: 'a-6500', name: 'Bank charges', type: 'EXPENSE' }],
  history: [{ date: '2026-09-30', text: 'SMS CHARGES', amount: '-59.00', accountCode: '6500', accountName: 'Bank charges' }],
});

describe('checking AI proposals for a bank line', () => {
  it('matches only ledger lines it was shown, adding up to the line', () => {
    expect(checkProposal(ctx('50000.00'), { action: 'MATCH', ledgerRefs: ['L1', 'L2'] }).resolved).toMatchObject({ action: 'MATCH', journalLineIds: ['jl-1', 'jl-2'] });
    const short = checkProposal(ctx('50000.00'), { action: 'MATCH', ledgerRefs: ['L1'] });
    expect(short.resolved).toBeNull();
    expect(short.checks.find((c) => !c.ok)?.label).toBe('The ledger lines add up to ₹30,000.00, not ₹50,000.00');
    const unknown = checkProposal(ctx('50000.00'), { action: 'MATCH', ledgerRefs: ['L1', 'L9'] });
    expect(unknown.checks[0]).toEqual({ ok: false, label: 'Ledger lines it was not shown: L9' });
    expect(checkProposal(ctx('50000.00'), { action: 'MATCH', ledgerRefs: [] }).resolved).toBeNull();
  });

  it("applies a receipt to one customer's open invoices for no more than each owes", () => {
    const good = checkProposal(ctx('50000.00'), { action: 'PAYMENT', contactRef: 'C1', allocations: [{ documentRef: 'D1', amount: '45000.00' }, { documentRef: 'D2', amount: '5000' }] });
    expect(good.resolved).toEqual({ action: 'PAYMENT', contactId: 'c-1', contactName: 'Lotus Retail', allocations: [{ documentId: 'doc-1', number: 'INV-000012', amount: '45000.00' }, { documentId: 'doc-2', number: 'INV-000013', amount: '5000.00' }], unallocated: '0.00' });
    expect(good.checks.map((c) => c.label)).toEqual(['A receipt from Lotus Retail', 'Applied to INV-000012, INV-000013', 'The amounts applied add up to the bank line']);
    const partial = checkProposal(ctx('50000.00'), { action: 'PAYMENT', contactRef: 'C1', allocations: [{ documentRef: 'D1', amount: '45000.00' }] });
    expect(partial.resolved).toMatchObject({ unallocated: '5000.00' });
    expect(partial.checks[2]).toEqual({ ok: true, label: '₹5,000.00 left on account' });

    const bad = (allocations: { documentRef: string; amount: string }[], contactRef = 'C1') => checkProposal(ctx('50000.00'), { action: 'PAYMENT', contactRef, allocations }).checks.filter((c) => !c.ok).map((c) => c.label);
    expect(bad([{ documentRef: 'D1', amount: '46000.00' }])).toEqual(['INV-000012 only has ₹45,000.00 still to pay']);
    expect(bad([{ documentRef: 'D3', amount: '8000.00' }])).toEqual(["INV-000014 is not Lotus Retail's"]);
    expect(bad([{ documentRef: 'D4', amount: '8000.00' }])).toEqual(['BILL-000002 is a bill, but money came in']);
    expect(bad([{ documentRef: 'D1', amount: '45,000' }])).toEqual(['INV-000012: "45,000" is not an amount']);
    expect(bad([{ documentRef: 'D1', amount: '1.00' }, { documentRef: 'D1', amount: '1.00' }])).toEqual(['INV-000012 is listed twice']);
    expect(bad([{ documentRef: 'D7', amount: '1.00' }])).toEqual(['D7 was not shown']);
    expect(bad([], 'C9')).toEqual(['A contact it was not shown: C9']);
    expect(checkProposal(ctx('40000.00'), { action: 'PAYMENT', contactRef: 'C1', allocations: [{ documentRef: 'D1', amount: '45000.00' }] }).checks[2]).toEqual({ ok: false, label: '₹45,000.00 applied is more than the ₹40,000.00 on the bank line' });
  });

  it('posts entries only to the accounts it was offered, and never applies "none"', () => {
    expect(checkProposal(ctx('-1200.00'), { action: 'ENTRY', accountCode: '6500', entryDescription: 'Quarterly account fee' }).resolved).toEqual({ action: 'ENTRY', accountId: 'a-6500', accountCode: '6500', accountName: 'Bank charges', description: 'Quarterly account fee' });
    expect(checkProposal(ctx('-1200.00'), { action: 'ENTRY', accountCode: '1100', entryDescription: 'x' }).checks[0]).toEqual({ ok: false, label: 'An account it may not use: 1100' });
    expect(checkProposal(ctx('-1200.00'), { action: 'ENTRY', accountCode: '6500', entryDescription: 'a\nb' }).resolved).toBeNull();
    const none = checkProposal(ctx('-1200.00'), { action: 'NONE' });
    expect(none.checks.every((c) => c.ok)).toBe(false);
  });

  it('shows the model references, never ids', () => {
    const text = contextForModel(ctx('50000.00'));
    expect(text).toContain('Bank statement line: 20 Oct 2026, money in ₹50,000.00, text "NEFT CR LOTUS RETAIL INV-000012", bank reference "N123".');
    expect(text).toContain('- L3: 19 Oct 2026, -₹1,200.00, "Bank charges"');
    expect(text).toContain('- D1: INV-000012, Lotus Retail (C1), due 10 Oct 2026, still to pay ₹45,000.00, reference "PO-9"');
    expect(text).toContain('- "SMS CHARGES", -₹59.00 → 6500 Bank charges');
    expect(text).not.toMatch(/doc-1|jl-1|c-1|a-6500/);
  });

  it('ranks candidates by shared words, then amount, then date', () => {
    const line = { amount: '50000.00', date: '2026-10-20', description: 'NEFT CR LOTUS RETAIL', reference: null };
    const rows = [
      { id: 'a', amount: '50000.00', date: '2026-10-01', text: 'Banyan' },
      { id: 'b', amount: '12000.00', date: '2026-10-20', text: 'Lotus Retail' },
      { id: 'c', amount: '49000.00', date: '2026-10-20', text: 'Other' },
    ];
    expect(rankCandidates(line, rows, 2).map((r) => r.id)).toEqual(['b', 'a']);
  });
});
