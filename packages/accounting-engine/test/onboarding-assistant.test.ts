import { describe, expect, it } from 'vitest';
import { canActivate, checkReading, readDescription, recommendFromReading, setupChecks, sizeForHeadcount } from '../src';

const ids = (list: { id: string }[]) => list.map((r) => r.id);

describe('onboarding assistant (UX-020 to UX-022)', () => {
  it('reads industry, size and signals from the owner’s words, quoting them', () => {
    const r = readDescription('We are a SaaS company in Pune with 14 employees. Customers pay a monthly subscription, some of them overseas in USD, and we pay a few freelancers.');
    expect(r.industry).toEqual({ value: 'SOFTWARE', quote: 'SaaS' });
    expect(r.size).toEqual({ value: 'SMALL', quote: 'with 14 employees' });
    expect(r.signals.map((s) => s.value)).toEqual(['EMPLOYEES', 'CONTRACTORS', 'FOREIGN_TRADE', 'RECURRING_BILLING']);
  });

  it('maps head counts onto the setup size bands', () => {
    expect([1, 10, 11, 50, 51, 250, 251].map(sizeForHeadcount)).toEqual(['MICRO', 'MICRO', 'SMALL', 'SMALL', 'MEDIUM', 'MEDIUM', 'LARGE']);
    expect(readDescription('Just me, a freelancer doing design').size?.value).toBe('MICRO');
    expect(readDescription('A bakery').size).toBeNull();
  });

  it('recommends the profile and the steps that fit, and says plainly what is not covered', () => {
    const r = readDescription('Manufacturing unit with 120 staff, machinery on a term loan, raw materials in stock, selling through a payment gateway.');
    const recs = recommendFromReading('IN', r);
    expect(ids(recs)).toEqual(['profile:industry', 'profile:size', 'profile:framework', 'profile:aiPreference', 'step:payroll', 'step:assets', 'step:loans', 'step:gateways', 'step:e-invoicing', 'note:inventory']);
    expect(recs.find((x) => x.id === 'profile:framework')!.value).toBe('INDIAN_GAAP');
    expect(recs.find((x) => x.id === 'profile:aiPreference')!.value).toBe('ADVISE');
    expect(recs.find((x) => x.id === 'step:payroll')).toMatchObject({ link: '/settings/payroll', reason: expect.stringContaining('"120 staff"') });
    expect(recs.find((x) => x.id === 'note:inventory')!.link).toBeNull();
  });

  it('recommends Ind AS for a listed Indian company, and no Indian steps elsewhere', () => {
    expect(recommendFromReading('IN', readDescription('A listed logistics company with 900 employees')).find((x) => x.id === 'profile:framework')!.value).toBe('IND_AS');
    const us = ids(recommendFromReading('US', readDescription('Consulting agency with 60 people paying contractors')));
    expect(us).not.toContain('step:tds');
    expect(us).not.toContain('step:e-invoicing');
  });

  it('keeps only AI findings that are on the lists and quote the owner’s words', () => {
    const d = 'We run two restaurants in Mumbai with about 30 staff.';
    const { reading, dropped } = checkReading(d, {
      industry: { value: 'HOSPITALITY', quote: 'restaurants' },
      size: { value: 'SMALL', quote: 'about 30   STAFF' },
      signals: [
        { value: 'EMPLOYEES', quote: '30 staff' },
        { value: 'LOCATIONS', quote: 'two restaurants' },
        { value: 'LOANS', quote: 'a bank loan' },
        { value: 'MAGIC', quote: 'restaurants' },
        { value: 'EMPLOYEES', quote: 'staff' },
      ],
    });
    expect(reading.industry).toEqual({ value: 'HOSPITALITY', quote: 'restaurants' });
    expect(reading.size?.value).toBe('SMALL');
    expect(reading.signals.map((s) => s.value)).toEqual(['EMPLOYEES', 'LOCATIONS']);
    expect(dropped).toEqual(['Has loans or borrowing: the words it quoted are not in the description', 'A signal: not one of the options']);
    expect(checkReading(d, 'nonsense')).toEqual({ reading: { industry: null, size: null, signals: [] }, dropped: [] });
  });

  it('holds activation while a recommendation is undecided, and not when the assistant was not used', () => {
    const facts = { countryCode: 'US', profile: { industry: 'SOFTWARE', size: 'SMALL', framework: 'US_GAAP', aiPreference: 'ADVISE' } as const, fiscalPeriods: 12, bankAccounts: 1, taxConfigured: false, openingBalancesPosted: false, customers: 0, vendors: 0, members: 1, approvalRules: 0, mailReady: false };
    expect(canActivate(setupChecks({ ...facts, pendingRecommendations: null }))).toEqual({ ok: true, missing: [] });
    expect(canActivate(setupChecks({ ...facts, pendingRecommendations: 2 }))).toEqual({ ok: false, missing: ['Assistant recommendations'] });
    expect(canActivate(setupChecks({ ...facts, pendingRecommendations: 0 })).ok).toBe(true);
    expect(setupChecks({ ...facts, pendingRecommendations: 2 }).find((c) => c.id === 'assistant')!.detail).toBe('2 recommendations from the setup assistant still to accept or dismiss.');
  });
});
