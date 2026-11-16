import { describe, expect, it } from 'vitest';
import { navFor } from '../src/lib/nav';

const hrefs = (org: Parameters<typeof navFor>[0]) => navFor(org).flatMap((g) => g.items.map((i) => i.href));

describe('navigation by country', () => {
  it('shows the India tax and payroll pages only in India', () => {
    const india = hrefs({ role: 'OWNER', countryCode: 'IN' });
    expect(india).toEqual(expect.arrayContaining(['/tax/gst-returns', '/tax/e-invoices', '/tax/tds-tcs', '/payroll/runs', '/settings/country-module']));
    const uk = hrefs({ role: 'OWNER', countryCode: 'GB' });
    for (const h of ['/tax/gst-returns', '/tax/e-invoices', '/tax/e-way-bills', '/tax/tds-tcs', '/tax/compliance', '/settings/gst', '/payroll/runs']) expect(uk).not.toContain(h);
    expect(uk).toEqual(expect.arrayContaining(['/settings/tax-rates', '/settings/country-module', '/sales/invoices']));
    expect(navFor({ role: 'OWNER', countryCode: 'GB' }).map((g) => g.group)).not.toContain('Payroll');
  });

  it('keeps role rules', () => {
    expect(hrefs({ role: 'EMPLOYEE', countryCode: 'IN' })).toEqual(['/expenses', '/support']);
    expect(hrefs({ role: 'VIEWER', countryCode: 'IN' })).not.toContain('/automations');
  });
});

describe('feature flags in the menu', () => {
  const flagged = (flags?: Record<string, boolean>) => navFor({ role: 'OWNER', countryCode: 'IN' }, flags).flatMap((g) => g.items.map((i) => i.href));
  it('show a flagged module once its flag is known to be on', () => {
    expect(flagged()).not.toContain('/benchmarking');
    expect(flagged({ benchmarking: true, 'forecast-lab': true, 'disaster-simulation': true, opportunities: true })).toContain('/benchmarking');
  });
  it('hide it while the flag is off, leaving the rest of the group', () => {
    const items = flagged({ benchmarking: false, 'forecast-lab': true, 'disaster-simulation': true, opportunities: true });
    expect(items).not.toContain('/benchmarking');
    expect(items).toContain('/planning/forecast-lab');
    expect(items).toContain('/planning/budgets');
  });
});
