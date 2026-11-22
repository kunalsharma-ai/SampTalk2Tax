import { describe, expect, it } from 'vitest';
import { classifyDispute } from '../src/dispute-classification';

describe('dispute classification', () => {
  it('reads the reason from what the customer said', () => {
    expect(classifyDispute({ description: 'Billed at 1,000 a unit; the agreed rate as per quotation was 750' })).toMatchObject({ reason: 'PRICE', label: 'Price or rate', confidence: 'HIGH', because: ['"agreed rate"', '"as per quotation"'] });
    expect(classifyDispute({ description: 'Only received 40 cartons, 10 boxes missing' })).toMatchObject({ reason: 'QUANTITY', confidence: 'HIGH', because: ['"only received"', '"boxes missing"', '"cartons"'] });
    expect(classifyDispute({ description: 'Three chairs arrived damaged and one is broken' })).toMatchObject({ reason: 'QUALITY', confidence: 'HIGH' });
    expect(classifyDispute({ description: "We haven't received the goods yet" })).toMatchObject({ reason: 'NOT_RECEIVED', confidence: 'MEDIUM', because: ['"haven t received"'] });
    expect(classifyDispute({ description: 'This is a duplicate, you invoiced twice for March' })).toMatchObject({ reason: 'DUPLICATE', confidence: 'HIGH' });
    expect(classifyDispute({ description: 'Should be IGST, not CGST and SGST: place of supply is Karnataka' })).toMatchObject({ reason: 'TAX', confidence: 'HIGH' });
  });

  it('says Other, with low confidence, when nothing points anywhere', () => {
    expect(classifyDispute({ description: 'Customer is unhappy, call them' })).toEqual({ reason: 'OTHER', label: 'Other', confidence: 'LOW', because: [], scores: expect.any(Array) });
    // One weak word is a low-confidence guess.
    expect(classifyDispute({ description: 'Please check the rate' })).toMatchObject({ reason: 'PRICE', confidence: 'LOW' });
  });

  it('uses the invoice: another one for the same total, and a disputed amount equal to the tax', () => {
    const invoice = { number: 'INV-0010', issueDate: '2026-11-10', total: '11800.00' };
    const twin = classifyDispute({ description: 'Please check', invoice, others: [{ id: 'x', number: 'INV-0007', issueDate: '2026-10-20', total: '11800' }, { id: 'y', number: 'INV-0001', issueDate: '2026-06-01', total: '11800' }] });
    expect(twin).toMatchObject({ reason: 'DUPLICATE', confidence: 'MEDIUM', because: ['INV-0007 of 20 Oct 2026 is for the same total'] });
    const old = classifyDispute({ description: 'Please check', invoice, others: [{ id: 'y', number: 'INV-0001', issueDate: '2026-06-01', total: '11800' }] });
    expect(old.reason).toBe('OTHER');
    expect(classifyDispute({ description: 'They will not pay this part', amount: '1800.00', invoiceTax: '1800' })).toMatchObject({ reason: 'TAX', because: ["the amount in dispute is the invoice's tax"] });
  });
});
