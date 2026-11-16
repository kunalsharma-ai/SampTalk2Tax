import { describe, expect, it } from 'vitest';
import { checkDraft, customerFacts, draftPasses, factsForModel } from '../src';

const facts = customerFacts({
  customer: 'Lotus Retail',
  currency: 'INR',
  today: '2026-11-02',
  open: [
    { number: 'INV-000012', issueDate: '2026-09-01', dueDate: '2026-10-01', total: '118000.00', balance: '18000.00', reference: 'PO-9' },
    { number: 'INV-000020', issueDate: '2026-10-05', dueDate: '2026-10-20', total: '59000.00', balance: '59000.00', reference: null },
    { number: 'INV-000031', issueDate: '2026-10-30', dueDate: '2026-11-29', total: '5900.00', balance: '5900.00', reference: null },
    { number: 'INV-000032', issueDate: '2026-09-30', dueDate: '2026-10-30', total: '100.00', balance: '0.00', reference: null },
  ],
  paid: [
    { number: 'INV-000001', dueDate: '2026-05-01', paidOn: '2026-05-11' },
    { number: 'INV-000004', dueDate: '2026-06-01', paidOn: '2026-06-21' },
    { number: 'INV-000000', dueDate: '2025-01-01', paidOn: '2025-03-01' }, // over a year ago: left out
  ],
  lastPayment: { date: '2026-10-15', amount: '100000.00' },
  previousReminders: [],
});

describe('customer facts', () => {
  it('lists overdue invoices oldest first, with days overdue and totals', () => {
    expect(facts.overdue.map((i) => [i.number, i.daysOverdue])).toEqual([['INV-000012', 32], ['INV-000020', 13]]);
    expect(facts.notYetDue.map((i) => i.number)).toEqual(['INV-000031']);
    expect(facts.totalOverdue).toBe('77000.00');
    expect(facts.oldestDaysOverdue).toBe(32);
    expect([facts.averageDaysLate, facts.paidInvoicesConsidered]).toEqual([15, 2]);
  });
  it('writes the facts for the model with amounts and dates for people', () => {
    const t = factsForModel(facts);
    expect(t).toContain('Overdue invoices (2), total still to pay ₹77,000.00:');
    expect(t).toContain('- INV-000012 (their reference PO-9): issued 1 Sep 2026, due 1 Oct 2026, 32 days overdue, invoice total ₹1,18,000.00, still to pay ₹18,000.00');
    expect(t).toContain('on average 15 days after the due date');
    expect(t).toContain('Last payment received: ₹1,00,000.00 on 15 Oct 2026.');
  });
});

describe('checking a draft against the books', () => {
  const good = 'Dear Lotus Retail,\n\nINV-000012 (₹18,000.00 still to pay, due 1 Oct 2026) and INV-000020 (₹59,000.00) are overdue: ₹77,000.00 in all. Thank you for your payment of Rs. 1,00,000 on 15 Oct 2026.';
  it('passes a draft whose figures and invoices all come from the books', () => {
    const c = checkDraft(facts, 'Overdue invoices: ₹77,000.00', good);
    expect(c.filter((x) => !x.ok)).toEqual([]);
    expect(draftPasses(c)).toBe(true);
  });
  it('catches invented amounts, wrong invoices, missing invoices and a two-line subject', () => {
    const c = checkDraft(facts, 'Overdue\ninvoices', 'Please pay ₹77,500.00 for INV-000012 and INV-000099, plus 1,500.00 in late fees.');
    expect(c.filter((x) => !x.ok).map((x) => x.label)).toEqual([
      'A one-line subject of up to 200 characters',
      'Amounts not in the books: ₹77,500.00, ₹1,500.00',
      "Invoice numbers that are not this customer's: INV-000099",
      'Overdue invoices not mentioned: INV-000020',
    ]);
  });
  it('ignores years, references and invoice numbers when looking for amounts', () => {
    const c = checkDraft(facts, 'Reminder', 'INV-000012 and INV-000020 for PO-9, as of 2 Nov 2026.');
    expect(draftPasses(c)).toBe(true);
  });
});
