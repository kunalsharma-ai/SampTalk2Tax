import { describe, expect, it } from 'vitest';
import { monthlyRunRate, platformAttention, type PlatformFacts } from '../src/platform-dashboard';

const calm: PlatformFacts = {
  securityAlertsOpen: 0,
  highSecurityEvents24h: 0,
  errorGroupsOpen: 0,
  errorsLastHour: 0,
  backupProblems: [],
  supportOverdue: 0,
  supportOpen: 0,
  planRequests: 0,
  trialsEndingSoon: 0,
  readOnly: 0,
  atLimit: 0,
  suspended: 0,
};

describe('monthly run-rate', () => {
  it('counts paying subscriptions only, annual prices as a twelfth, by currency', () => {
    expect(
      monthlyRunRate([
        { currency: 'INR', price: '999.00', billingInterval: 'MONTHLY', paying: true },
        { currency: 'INR', price: '9990.00', billingInterval: 'ANNUAL', paying: true },
        { currency: 'USD', price: '29.00', billingInterval: 'MONTHLY', paying: true },
        { currency: 'INR', price: '999.00', billingInterval: 'MONTHLY', paying: false },
        { currency: 'INR', price: null, billingInterval: null, paying: true },
      ]),
    ).toEqual([
      { currency: 'INR', monthly: '1831.50', annual: '21978.00', subscriptions: 2 },
      { currency: 'USD', monthly: '29.00', annual: '348.00', subscriptions: 1 },
    ]);
    expect(monthlyRunRate([])).toEqual([]);
  });
});

describe('platform attention', () => {
  it('is empty when nothing needs the team', () => {
    expect(platformAttention(calm)).toEqual([]);
  });

  it('ranks security, backups and late tickets first and links each to its page', () => {
    const items = platformAttention({
      ...calm,
      securityAlertsOpen: 2,
      backupProblems: ['No backup has been recorded'],
      supportOverdue: 1,
      supportOpen: 3,
      errorGroupsOpen: 4,
      errorsLastHour: 3,
      planRequests: 1,
      trialsEndingSoon: 2,
      readOnly: 1,
      atLimit: 1,
      suspended: 1,
    });
    expect(items.map((i) => `${i.level} ${i.title} ${i.href}`)).toEqual([
      'HIGH Backups need attention /admin/backups',
      'HIGH Security alerts open /admin/security',
      'HIGH Support tickets past their target /admin/support',
      'MEDIUM Organisations at a plan limit /admin/usage',
      'MEDIUM Plan requests waiting /admin/subscriptions',
      'MEDIUM Server errors in the last hour /admin/errors',
      'LOW Organisations read-only /admin/subscriptions',
      'LOW Suspended organisations /admin/organisations',
      'LOW Trials ending this week /admin/subscriptions',
    ]);
    expect(items[1]!.detail).toBe('2 alerts are not yet acknowledged.');
  });

  it('raises many errors to high and treats quiet open groups as low', () => {
    expect(platformAttention({ ...calm, errorsLastHour: 12, errorGroupsOpen: 1 })[0]).toMatchObject({ level: 'HIGH', title: 'Server errors in the last hour' });
    expect(platformAttention({ ...calm, errorGroupsOpen: 1 })).toEqual([{ title: 'Error groups not resolved', detail: '1 group is still open.', level: 'LOW', href: '/admin/errors' }]);
    expect(platformAttention({ ...calm, supportOpen: 1 })[0]!.detail).toBe('1 ticket is open or waiting, all within target.');
  });
});
