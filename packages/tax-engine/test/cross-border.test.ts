import { describe, expect, it } from 'vitest';
import { COUNTRY_NAMES, crossBorderCsv, crossBorderReport, isCountryCode, type CrossBorderDocument } from '../src/cross-border';

let n = 0;
const doc = (o: Partial<CrossBorderDocument>): CrossBorderDocument => ({
  id: `d${++n}`,
  kind: 'INVOICE',
  number: `INV-${n}`,
  issueDate: '2026-10-01',
  contactId: 'c1',
  contactName: 'Customer',
  contactCountry: null,
  contactTaxId: null,
  currency: 'EUR',
  netLocal: '100',
  taxLocal: '0',
  reverseCharge: false,
  placeOfSupply: null,
  ...o,
});

describe('countries', () => {
  it('knows ISO codes', () => {
    expect(COUNTRY_NAMES.DE).toBe('Germany');
    expect(isCountryCode('FR')).toBe(true);
    expect(isCountryCode('XX')).toBe(false);
    expect(isCountryCode('constructor')).toBe(false);
  });
});

describe('cross-border report (TAX-038)', () => {
  it('groups foreign sales and purchases by country, netting credit notes, and skips home ones', () => {
    const r = crossBorderReport({
      orgCountry: 'DE',
      functionalCurrency: 'EUR',
      documents: [
        doc({ contactCountry: 'FR', contactTaxId: 'FR12345678901', netLocal: '1000' }),
        doc({ kind: 'CREDIT_NOTE', contactCountry: 'FR', contactTaxId: 'FR12345678901', netLocal: '200' }),
        doc({ contactCountry: 'DE', netLocal: '5000', taxLocal: '950' }),
        doc({ kind: 'BILL', contactId: 'v1', contactName: 'US Vendor', contactCountry: 'US', currency: 'USD', netLocal: '300', reverseCharge: true }),
      ],
    });
    expect(r.considered).toBe(3);
    expect(r.byCountry.map((c) => c.country)).toEqual(['FR', 'US']);
    expect(r.byCountry[0]).toMatchObject({ countryName: 'France', euMember: true, sales: { net: '800.00', documents: 2 } });
    expect(r.totals.reverseCharge).toEqual({ net: '300.00', tax: '0.00', documents: 1 });
    expect(r.ecSalesList).toEqual([{ contactId: 'c1', contactName: 'Customer', country: 'FR', countryName: 'France', vatId: 'FR12345678901', net: '800.00', documents: 2 }]);
    expect(r.checks).toEqual([]);
  });

  it('flags taxed exports, untaxed imports, missing VAT IDs and missing countries', () => {
    const r = crossBorderReport({
      orgCountry: 'DE',
      functionalCurrency: 'EUR',
      documents: [
        doc({ contactCountry: 'AT', netLocal: '100' }),
        doc({ contactId: 'c2', contactCountry: 'US', netLocal: '100', taxLocal: '19' }),
        doc({ kind: 'BILL', contactId: 'v1', contactCountry: 'GB', netLocal: '50' }),
        doc({ contactId: 'c3', currency: 'USD' }),
        doc({ contactId: 'c4', currency: 'EUR' }),
      ],
    });
    expect(r.checks.map((c) => c.kind).sort()).toEqual(['COUNTRY_MISSING', 'EXPORT_TAXED', 'IMPORT_NO_REVERSE_CHARGE', 'INTRA_EU_NO_VAT_ID']);
    expect(r.ecSalesList![0]).toMatchObject({ country: 'AT', vatId: null });
  });

  it('has no recapitulative statement outside the EU and reads India place of supply 96', () => {
    const r = crossBorderReport({ orgCountry: 'IN', functionalCurrency: 'INR', documents: [doc({ currency: 'INR', placeOfSupply: '96' }), doc({ contactCountry: 'AE', currency: 'INR' })] });
    expect(r.ecSalesList).toBeNull();
    expect(r.checks.map((c) => c.kind)).toEqual(['COUNTRY_MISSING']);
    expect(r.byCountry.map((c) => c.country)).toEqual(['AE']);
  });

  it('writes a CSV', () => {
    const r = crossBorderReport({ orgCountry: 'DE', functionalCurrency: 'EUR', documents: [doc({ contactCountry: 'FR', contactName: 'A, B', contactTaxId: 'FR1' })] });
    const csv = crossBorderCsv(r, 'EUR');
    expect(csv.split('\n')[1]).toBe('France,FR,Yes,100.00,0.00,1,0.00,0.00,0,EUR');
    expect(csv).toContain('"A, B",FR,FR1,100.00,1');
  });
});
