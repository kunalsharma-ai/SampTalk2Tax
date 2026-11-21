import { describe, expect, it } from 'vitest';
import { agentOnFor, canActivate, setupChecks, suggestSetup, type SetupFacts } from '../src/setup';

const facts = (over: Partial<SetupFacts> = {}): SetupFacts => ({
  countryCode: 'IN',
  profile: { industry: 'SOFTWARE', size: 'SMALL', framework: 'INDIAN_GAAP', aiPreference: 'ADVISE' },
  fiscalPeriods: 12,
  bankAccounts: 1,
  taxConfigured: true,
  openingBalancesPosted: false,
  customers: 0,
  vendors: 0,
  members: 1,
  approvalRules: 0,
  mailReady: false,
  ...over,
});

describe('setup checks', () => {
  it('can activate once every required step is done, whatever the optional ones say', () => {
    const checks = setupChecks(facts());
    expect(checks.filter((c) => c.required).every((c) => c.status === 'DONE')).toBe(true);
    expect(checks.filter((c) => !c.required).map((c) => [c.id, c.status])).toEqual([
      ['assistant', 'DONE'],
      ['opening', 'TODO'],
      ['contacts', 'TODO'],
      ['team', 'TODO'],
      ['approvals', 'TODO'],
      ['email', 'TODO'],
    ]);
    expect(canActivate(checks)).toEqual({ ok: true, missing: [] });
  });

  it('names the required steps still to do', () => {
    const checks = setupChecks(facts({ profile: { industry: null, size: 'SMALL', framework: null, aiPreference: null }, bankAccounts: 0, taxConfigured: false }));
    expect(canActivate(checks)).toEqual({ ok: false, missing: ['Business profile', 'Accounting framework', 'Bank account', 'GST registration', 'AI preferences'] });
    expect(checks.find((c) => c.id === 'tax')).toMatchObject({ link: '/settings/gst', required: true });
  });

  it('asks for tax rates outside India, without holding up activation', () => {
    const tax = setupChecks(facts({ countryCode: 'GB', taxConfigured: false })).find((c) => c.id === 'tax')!;
    expect(tax).toMatchObject({ title: 'Tax rates', status: 'TODO', required: false, link: '/settings/tax-rates' });
  });

  it('counts with the right plurals', () => {
    const c = setupChecks(facts({ customers: 1, vendors: 2, members: 3 }));
    expect(c.find((x) => x.id === 'contacts')!.detail).toBe('1 customer and 2 vendors.');
    expect(c.find((x) => x.id === 'team')!.detail).toBe('3 members.');
  });
});

describe('suggestions', () => {
  it('suggests a framework by country and size, for the accountant to confirm', () => {
    expect(suggestSetup('IN', { industry: 'RETAIL', size: 'SMALL' }).framework).toBe('INDIAN_GAAP');
    expect(suggestSetup('IN', { industry: 'RETAIL', size: 'LARGE' }).framework).toBe('IND_AS');
    expect(suggestSetup('US', { industry: null, size: null }).framework).toBe('US_GAAP');
    expect(suggestSetup('GB', { industry: null, size: 'MICRO' }).framework).toBe('FRS_105');
    expect(suggestSetup('IE', { industry: null, size: 'MICRO' }).framework).toBe('FRS_102');
    expect(suggestSetup('AE', { industry: null, size: 'MEDIUM' }).framework).toBe('IFRS');
    expect(suggestSetup('AE', { industry: null, size: 'SMALL' }).framework).toBe('IFRS_SME');
    expect(suggestSetup('IN', { industry: null, size: 'SMALL' }).reasons[0]).toMatch(/Confirm with your accountant/);
  });

  it('suggests more help from agents for the smallest teams', () => {
    expect(suggestSetup('IN', { industry: null, size: 'MICRO' }).aiPreference).toBe('PREPARE');
    expect(suggestSetup('IN', { industry: null, size: 'MEDIUM' }).aiPreference).toBe('ADVISE');
  });
});

it('maps an AI preference to the agents it turns on by action level', () => {
  expect([0, 1, 2].map((l) => agentOnFor('OFF', l))).toEqual([false, false, false]);
  expect([0, 1, 2].map((l) => agentOnFor('ADVISE', l))).toEqual([true, true, false]);
  expect([0, 1, 2].map((l) => agentOnFor('PREPARE', l))).toEqual([true, true, true]);
});
