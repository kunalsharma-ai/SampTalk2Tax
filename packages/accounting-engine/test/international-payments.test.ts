import { describe, expect, it } from 'vitest';
import { abaChecksumOk, form15Requirement, ibanChecksumOk, instructionCsv, internationalBankIssues, remittanceIssues } from '../src/international-payments';

const good = { accountName: 'Müller Maschinenbau GmbH', accountNumber: 'DE89 3704 0044 0532 0130 00', swiftBic: 'COBADEFFXXX', bankCountry: 'DE' };

describe('international payments', () => {
  it('checks IBANs and ABA routing numbers', () => {
    expect(ibanChecksumOk('DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(ibanChecksumOk('DE88 3704 0044 0532 0130 00')).toBe(false);
    expect(ibanChecksumOk('GB82WEST12345698765432')).toBe(true);
    expect(abaChecksumOk('021000021')).toBe(true);
    expect(abaChecksumOk('021000022')).toBe(false);
  });

  it('checks international bank details', () => {
    expect(internationalBankIssues(good)).toEqual([]);
    expect(internationalBankIssues({ ...good, accountNumber: 'DE88370400440532013000' })).toEqual(["The IBAN check digits are wrong; check it against the vendor's invoice or bank letter"]);
    expect(internationalBankIssues({ ...good, swiftBic: 'CHASUS33' })).toEqual(['The SWIFT/BIC code is for a bank in US, not DE']);
    expect(internationalBankIssues({ ...good, accountNumber: '12345678' })[0]).toMatch(/IBAN: 22 characters starting DE/);
    expect(internationalBankIssues({ ...good, bankCountry: 'IN', swiftBic: 'HDFCINBB' })).toContain('This bank is in your own country; use the domestic bank details instead');
    const us = { accountName: 'Acme Cloud Inc', accountNumber: '000123456789', swiftBic: 'CHASUS33', bankCountry: 'US' };
    expect(internationalBankIssues(us)).toEqual(['Banks in US also need the ABA routing number (for example 021000021)']);
    expect(internationalBankIssues({ ...us, routingCode: '021000021' })).toEqual([]);
    expect(internationalBankIssues({ ...us, routingCode: '021000022' })).toEqual(['The ABA routing number check digit is wrong']);
  });

  it('works out the Form 15CA part and whether a 15CB is needed', () => {
    const base = { homeCountry: 'IN', purposeCode: 'S0802', taxableInIndia: true, hasOrder: false, inrThisYear: '400000' };
    expect(form15Requirement(base)).toMatchObject({ part: 'A', needs15cb: false });
    expect(form15Requirement({ ...base, inrThisYear: '500000.01' })).toMatchObject({ part: 'C', needs15cb: true });
    expect(form15Requirement({ ...base, hasOrder: true, inrThisYear: '900000' })).toMatchObject({ part: 'B', needs15cb: false });
    expect(form15Requirement({ ...base, taxableInIndia: false })).toMatchObject({ part: 'D', needs15cb: false });
    expect(form15Requirement({ ...base, purposeCode: 'S0102', inrThisYear: '9000000' })).toMatchObject({ part: 'NONE', needs15cb: false });
    expect(form15Requirement({ ...base, homeCountry: 'GB' })).toMatchObject({ part: 'NONE' });
  });

  it('lists what stops a remittance being approved', () => {
    const r = { bank: { international: true, verified: true }, purposeCode: 'S0802', part: 'C' as const, needs15cb: true, form15caAck: null, form15cbNumber: null, currency: 'USD', items: [{ number: 'BILL-000001', currency: 'USD', status: 'POSTED', due: '100', amount: '120' }, { number: 'BILL-000002', currency: 'EUR', status: 'POSTED', due: '50', amount: '50' }] };
    expect(remittanceIssues(r)).toEqual([
      'BILL-000001 has 100.00 USD left to pay, less than the 120.00 in this payment',
      'BILL-000002 is in EUR, not USD',
      'Enter the acknowledgement number of Form 15CA Part C',
      'Enter the Form 15CB acknowledgement number from the chartered accountant',
    ]);
    expect(remittanceIssues({ ...r, bank: { international: false, verified: true }, purposeCode: 'x', part: 'NONE', needs15cb: false, items: [] })).toEqual([
      "The vendor's bank details are domestic; enter their international bank details",
      'Choose the purpose of the payment (an RBI purpose code such as S0802)',
      'Add at least one bill',
    ]);
  });

  it('writes the instruction as a CSV with formulas neutralised', () => {
    const csv = instructionCsv({
      reference: 'IP-0001', date: '2026-11-10', debitAccount: '1120 HDFC current', remitter: { name: 'Acme India', address: 'Pune', pan: 'AAACA1234A' },
      beneficiary: { name: '=HYPERLINK("x")', address: 'Berlin', country: 'DE', accountName: 'Müller', account: 'DE89370400440532013000', swift: 'COBADEFFXXX', bankName: 'Commerzbank', bankAddress: null, bankCountry: 'DE', routingCode: null, intermediarySwift: null },
      currency: 'EUR', amount: '1200.00', purposeCode: 'S1014', purpose: 'Engineering services', charges: 'OUR', invoices: ['BILL-000004 (MM-77)'], form15: { part: 'A', ack: '123456789012345', cb: null },
    });
    expect(csv.split('\r\n')[0]).toBe('Field,Value');
    expect(csv).toContain(`Beneficiary name,"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('Form 15CA,"Part A, acknowledgement 123456789012345"');
  });
});
