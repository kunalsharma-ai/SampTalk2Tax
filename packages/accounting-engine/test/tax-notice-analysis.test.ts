import { describe, expect, it } from 'vitest';
import { analyseNotice, noticeMonthsOrPart, NOTICE_TYPES, normaliseSection, recogniseNotice } from '../src';

const base = { status: 'OPEN' as const, receivedOn: '2026-05-04', responseDue: null, demand: null, chosenType: null, checked: [] };

describe('tax notice analysis', () => {
  it('recognises notices by authority and section, however the section is written', () => {
    expect(normaliseSection('u/s 143(1)(a)')).toBe('143(1)(a)');
    expect(normaliseSection('Section 74A')).toBe('74a');
    expect(normaliseSection(' sec. 61 ')).toBe('61');
    expect(recogniseNotice('GST', 'Section 61')!.key).toBe('GST_61');
    expect(recogniseNotice('GST', '74A')!.key).toBe('GST_74A');
    expect(recogniseNotice('INCOME_TAX', 'u/s 143(1)')!.key).toBe('IT_143_1A');
    expect(recogniseNotice('TDS', '200A')!.key).toBe('TDS_200A');
    expect(recogniseNotice('GST', 'ASMT-10')!.key).toBe('GST_61');
    expect(recogniseNotice('GST', 'GSTR 3A')!.key).toBe('GST_46');
    expect(recogniseNotice('GST', 'DRC-01')).toBeNull();
    expect(recogniseNotice('INCOME_TAX', '61')).toBeNull();
    expect(recogniseNotice('GST', null)).toBeNull();
    // Every type names its source, and checklist keys are unique within a type.
    for (const t of NOTICE_TYPES) {
      expect(t.source).toMatch(/Act/);
      expect(new Set(t.checklist.map((c) => c.key)).size).toBe(t.checklist.length);
    }
    expect(new Set(NOTICE_TYPES.map((t) => t.key)).size).toBe(NOTICE_TYPES.length);
  });

  it('works out the usual deadline and flags a later date entered', () => {
    const a = analyseNotice({ ...base, authority: 'GST', section: '61', checked: ['outward', 'itc'] }, '2026-05-10');
    expect(a).toMatchObject({ recognisedBy: 'SECTION', deadline: { date: '2026-06-03', source: 'RULE' }, usualDeadline: '2026-06-03', interest: null, progress: { done: 2, total: 5 } });
    expect(a.type!.title).toBe('Scrutiny of returns (ASMT-10)');
    expect(a.warnings).toEqual(['No reply date is entered; 2026-06-03 is 30 days from receipt. Enter the date on the notice if it differs.']);
    const late = analyseNotice({ ...base, authority: 'GST', section: '61', responseDue: '2026-06-20' }, '2026-05-10');
    expect(late.deadline).toEqual({ date: '2026-06-20', source: 'NOTICE' });
    expect(late.warnings[0]).toMatch(/later than the usual 30 days from receipt \(2026-06-03\)/);
    const own = analyseNotice({ ...base, authority: 'INCOME_TAX', section: '143(2)' }, '2026-05-10');
    expect(own.deadline).toBeNull();
    expect(own.warnings).toEqual(['This kind of notice sets its own date: enter the reply date from the notice.']);
  });

  it('estimates interest on an unpaid income-tax demand for each month or part', () => {
    expect(noticeMonthsOrPart('2026-06-04', '2026-06-03')).toBe(0);
    expect(noticeMonthsOrPart('2026-06-04', '2026-06-04')).toBe(1);
    expect(noticeMonthsOrPart('2026-06-04', '2026-07-03')).toBe(1);
    expect(noticeMonthsOrPart('2026-06-04', '2026-07-04')).toBe(2);
    expect(noticeMonthsOrPart('2026-01-31', '2026-03-01')).toBe(2);
    const a = analyseNotice({ ...base, authority: 'INCOME_TAX', section: '156', demand: '125000.00' }, '2026-08-10');
    // Due 30 days after receipt (2026-06-03); interest from 2026-06-04: Jun, Jul and part of Aug.
    expect(a.interest).toMatchObject({ from: '2026-06-04', months: 3, ratePerMonth: '1', amount: '3750.00' });
    expect(analyseNotice({ ...base, authority: 'INCOME_TAX', section: '156', demand: '125000.00' }, '2026-06-03').interest).toBeNull();
    expect(analyseNotice({ ...base, authority: 'INCOME_TAX', section: '156', demand: '125000.00', status: 'CLOSED' }, '2026-08-10').interest).toBeNull();
  });

  it('uses a chosen type and says when it differs from the section', () => {
    const a = analyseNotice({ ...base, authority: 'GST', section: '73', chosenType: 'GST_74A' }, '2026-05-10');
    expect(a).toMatchObject({ recognisedBy: 'CHOSEN', type: { key: 'GST_74A' } });
    expect(a.warnings).toContain('The section entered suggests "Show cause notice: tax not paid or short paid (not fraud)", but "Show cause notice for 2024-25 onwards" was chosen.');
    const unknown = analyseNotice({ ...base, authority: 'PF', section: '7A' }, '2026-05-10');
    expect(unknown).toMatchObject({ type: null, recognisedBy: null, deadline: null, checklist: [], progress: { done: 0, total: 0 } });
    expect(unknown.warnings[0]).toMatch(/Section 7A is not one this analysis knows/);
  });
});
