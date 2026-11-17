import { describe, expect, it } from 'vitest';
import { proFormaAllows, proFormaRef, proFormaState } from '../src/pro-forma';

const T = '2026-11-09';
describe('pro forma invoices', () => {
  it('numbers them', () => expect(proFormaRef(12)).toBe('PF-0012'));

  it('works out where one stands', () => {
    expect(proFormaState('DRAFT', '2026-01-01', null, T)).toBe('DRAFT');
    expect(proFormaState('ISSUED', '2026-11-30', null, T)).toBe('ISSUED');
    expect(proFormaState('ISSUED', '2026-11-08', null, T)).toBe('EXPIRED');
    expect(proFormaState('ISSUED', '2026-11-08', { status: 'DRAFT' }, T)).toBe('INVOICED');
    // Voiding the invoice frees the pro forma.
    expect(proFormaState('ISSUED', '2026-11-30', { status: 'VOID' }, T)).toBe('ISSUED');
    expect(proFormaState('CANCELLED', '2026-11-30', null, T)).toBe('CANCELLED');
  });

  it('allows each action only where it makes sense', () => {
    expect(() => proFormaAllows('DRAFT', 'EDIT')).not.toThrow();
    expect(() => proFormaAllows('EXPIRED', 'INVOICE')).not.toThrow();
    expect(() => proFormaAllows('ISSUED', 'EDIT')).toThrow(/can no longer change/);
    expect(() => proFormaAllows('DRAFT', 'INVOICE')).toThrow(/issue it first/);
    expect(() => proFormaAllows('INVOICED', 'CANCEL')).toThrow(/already invoiced/);
    expect(() => proFormaAllows('CANCELLED', 'INVOICE')).toThrow(/cancelled/);
  });
});

import { layoutFromPreset, renderInvoiceDocument, sampleInvoiceSource } from '../src/invoice-templates';

describe('printing a pro forma invoice', () => {
  it('says it is not a tax invoice and shows the valid-until date', () => {
    const src = { ...sampleInvoiceSource('IN_GST'), kind: 'PRO_FORMA' as const, number: 'PF-0001', dueDate: '2026-11-30' };
    const html = renderInvoiceDocument({ engine: 'LAYOUT', layout: layoutFromPreset('IN_GST'), html: null }, src);
    expect(html).toContain('<h1>Pro forma invoice</h1>');
    expect(html).toContain('Not a tax invoice');
    expect(html).toContain('Valid until');
    expect(html).toContain('PF-0001');
    expect(html).not.toContain('Tax Invoice</h1>');
  });
});
