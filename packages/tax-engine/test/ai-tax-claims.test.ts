import { describe, expect, it } from 'vitest';
import { checkTaxClaims, normaliseRate, taxClaimsNotice } from '../src';

describe('AI tax claims', () => {
  it('normalises rates', () => {
    expect(['18.00', '7.50', '05', '0.1'].map(normaliseRate)).toEqual(['18', '7.5', '5', '0.1']);
  });

  it('supports rates and sections found in the evidence and flags the rest', () => {
    const evidence = ['{"taxRates":[{"name":"GST 18%","rate":"18.00"}],"tds":[{"section":"194J","rate":"10"}]}'];
    const answer = [
      'Your sales carried GST at 18% this quarter.',
      'TDS under section 194J was deducted at 10%.',
      'From next year the rate becomes 12%, and section 194Q applies to your purchases.',
      'Revenue grew 25% over last year.',
    ].join('\n');
    const r = checkTaxClaims(answer, { evidence, ownRates: ['5'] });
    expect(r.claims.map((c) => `${c.kind} ${c.value} ${c.supported}`)).toEqual(['RATE 18 true', 'RATE 10 true', 'CITATION 194J true', 'RATE 12 false', 'CITATION 194Q false']);
    expect(r.unsupported.map((c) => c.sentence)).toEqual([
      'From next year the rate becomes 12%, and section 194Q applies to your purchases.',
      'From next year the rate becomes 12%, and section 194Q applies to your purchases.',
    ]);
    expect(taxClaimsNotice(r)).toBe(
      'This answer mentions 12%, section 194Q, which Talk2Tax could not find in your records or its built-in rules. The AI may have recalled or invented it: confirm it with your tax adviser before relying on it.',
    );
  });

  it('uses the organisation rates, matches whole citations only and is quiet when nothing is claimed', () => {
    expect(checkTaxClaims('VAT is charged at 5 per cent.', { evidence: [], ownRates: ['5.000'] }).unsupported).toEqual([]);
    expect(checkTaxClaims('See section 19 of the Act.', { evidence: ['section 194J'] }).unsupported.map((c) => c.value)).toEqual(['19']);
    expect(checkTaxClaims('Rule 36(4) limits input tax credit.', { evidence: ['as per rule 36(4)'] }).unsupported).toEqual([]);
    const none = checkTaxClaims('Profit was ₹12,34,567.50 for the year.', { evidence: [] });
    expect(none).toEqual({ claims: [], unsupported: [] });
    expect(taxClaimsNotice(none)).toBeNull();
  });
});
