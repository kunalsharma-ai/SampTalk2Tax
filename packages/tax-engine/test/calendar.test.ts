import { describe, expect, it } from 'vitest';
import { complianceObligations, openStatus, statementDueDate } from '../src';

const keys = (xs: { key: string; dueDate: string }[]) => xs.map((x) => `${x.key}@${x.dueDate}`);

describe('compliance calendar', () => {
  it('gives monthly GST returns on the 11th and 20th and the annual return on 31 December', () => {
    const r = complianceObligations({ gst: { stateCode: '27', from: '2026-04-01', frequency: 'MONTHLY' } }, '2026-11-01', '2026-12-31');
    expect(keys(r)).toEqual(['GSTR1:2026-10@2026-11-11', 'GSTR3B:2026-10@2026-11-20', 'GSTR1:2026-11@2026-12-11', 'GSTR3B:2026-11@2026-12-20']);
    const annual = complianceObligations({ gst: { stateCode: '27', from: '2025-04-01', frequency: 'MONTHLY' } }, '2026-12-31', '2026-12-31');
    expect(keys(annual)).toEqual(['GSTR9:2025-26@2026-12-31']);
  });

  it('gives QRMP dates: PMT-06 on the 25th, quarterly GSTR-1 on the 13th and GSTR-3B on the 22nd or 24th by state', () => {
    const mh = complianceObligations({ gst: { stateCode: '27', from: '2026-04-01', frequency: 'QUARTERLY' } }, '2026-10-01', '2026-11-30');
    expect(keys(mh)).toEqual(['GSTR1:Q2 2026-27@2026-10-13', 'GSTR3B:Q2 2026-27@2026-10-22', 'GST_PMT06:2026-10@2026-11-25']);
    const dl = complianceObligations({ gst: { stateCode: '07', from: '2026-04-01', frequency: 'QUARTERLY' } }, '2026-10-01', '2026-10-31');
    expect(keys(dl)).toContain('GSTR3B:Q2 2026-27@2026-10-24');
  });

  it('gives TDS and TCS deposits on the 7th (30 April for March) and quarterly statements', () => {
    const r = complianceObligations({ withholding: { from: '2026-04-01' } }, '2027-04-01', '2027-05-31');
    expect(keys(r)).toEqual(['TDS_DEPOSIT:2027-03@2027-04-30', 'TCS_DEPOSIT:2027-03@2027-04-30', 'TDS_DEPOSIT:2027-04@2027-05-07', 'TCS_DEPOSIT:2027-04@2027-05-07', 'TDS_STATEMENT:Q4 2026-27@2027-05-31', 'TCS_STATEMENT:Q4 2026-27@2027-05-31']);
    expect([1, 2, 3, 4].map((q) => statementDueDate(q as 1 | 2 | 3 | 4, ['2026-06-30', '2026-09-30', '2026-12-31', '2027-03-31'][q - 1]))).toEqual(['2026-07-31', '2026-10-31', '2027-01-31', '2027-05-31']);
  });

  it('gives payroll dues, with professional tax only for Maharashtra, and the salary TDS statement', () => {
    const r = complianceObligations({ payroll: { from: '2026-04-01', ptStates: ['27'] } }, '2026-10-01', '2026-10-31');
    expect(keys(r)).toEqual(['TDS_DEPOSIT:2026-09@2026-10-07', 'PF:2026-09@2026-10-15', 'ESI:2026-09@2026-10-15', 'TDS_STATEMENT_SALARY:Q2 2026-27@2026-10-31', 'PT:2026-09@2026-10-31']);
    // With a TAN as well, the monthly TDS deposit appears once.
    const both = complianceObligations({ payroll: { from: '2026-04-01', ptStates: ['27'] }, withholding: { from: '2026-04-01' } }, '2026-10-07', '2026-10-07');
    expect(keys(both)).toEqual(['TDS_DEPOSIT:2026-09@2026-10-07', 'TCS_DEPOSIT:2026-09@2026-10-07']);
    const ka = complianceObligations({ payroll: { from: '2026-04-01', ptStates: ['29'] } }, '2026-10-01', '2026-10-31');
    expect(ka.some((o) => o.kind === 'PT')).toBe(false);
  });

  it('never gives obligations for periods before an area applies', () => {
    const r = complianceObligations({ gst: { stateCode: '27', from: '2026-10-15', frequency: 'MONTHLY' } }, '2026-10-01', '2026-11-30');
    expect(keys(r)).toEqual(['GSTR1:2026-10@2026-11-11', 'GSTR3B:2026-10@2026-11-20']);
  });

  it('gives advance tax instalments on the 15th', () => {
    const r = complianceObligations({ advanceTax: { from: '2026-04-01' } }, '2026-04-01', '2027-03-31');
    expect(r.map((o) => [o.dueDate, o.note])).toEqual([
      ['2026-06-15', '15% of the tax for the year paid by this date'],
      ['2026-09-15', '45% of the tax for the year paid by this date'],
      ['2026-12-15', '75% of the tax for the year paid by this date'],
      ['2027-03-15', '100% of the tax for the year paid by this date'],
    ]);
  });

  it('works out the status of an open obligation', () => {
    expect(openStatus('2026-10-31', '2026-11-01')).toBe('OVERDUE');
    expect(openStatus('2026-11-07', '2026-11-01')).toBe('DUE_SOON');
    expect(openStatus('2026-11-09', '2026-11-01')).toBe('UPCOMING');
    expect(() => complianceObligations({}, '2026-12-01', '2026-11-01')).toThrow();
  });
});
