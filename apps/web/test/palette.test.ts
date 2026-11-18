import { describe, expect, it } from 'vitest';
import { NAV } from '../src/lib/nav';
import { can } from '../src/lib/types';
import { matchActions, matchPages, PALETTE_ACTIONS } from '../src/lib/palette';

describe('page search in the command palette', () => {
  it('finds pages by every word typed, names that start with the text first', () => {
    const out = matchPages(NAV, 'inv').map((h) => h.item.label);
    expect(out[0]).toBe('Invoices');
    expect(out).toContain('Invoice templates');
    expect(matchPages(NAV, 'bank accounts')[0]!.item.label).toBe('Bank accounts');
  });

  it('matches the group name too, and needs all the words', () => {
    expect(matchPages(NAV, 'payroll leave').map((h) => h.item.label)).toContain('Leave');
    expect(matchPages(NAV, 'invoices zzz')).toEqual([]);
    expect(matchPages(NAV, '   ')).toEqual([]);
  });

  it('leaves out pages the plan does not include', () => {
    const groups = [{ group: 'Overview', items: [{ href: '/copilot', label: 'Copilot', locked: true }, { href: '/alerts', label: 'Alerts' }] }];
    expect(matchPages(groups, 'co').map((h) => h.item.label)).toEqual([]);
    expect(matchPages(groups, 'al').map((h) => h.item.label)).toEqual(['Alerts']);
  });
});

describe('actions in the command palette', () => {
  const owner = (p: string) => can('OWNER', p);
  it('starts new records by name or by the words people use', () => {
    // A bill is a purchase invoice, so it comes second.
    expect(matchActions(NAV, 'new inv', owner).map((a) => a.label)).toEqual(['New invoice', 'New bill']);
    expect(matchActions(NAV, 'new', owner).length).toBe(5);
    expect(matchActions(NAV, 'vendor', owner).map((a) => a.label)).toEqual(['New bill', 'Record a payment']);
    expect(matchActions(NAV, 'je', owner).map((a) => a.label)).toEqual(['New journal entry']);
    expect(matchActions(NAV, '', owner)).toEqual([]);
  });

  it('offers only what the role may do, from pages in the menu', () => {
    expect(matchActions(NAV, 'new invoice', (p) => can('VIEWER', p))).toEqual([]);
    expect(matchActions(NAV, 'expense', (p) => can('EMPLOYEE', p)).map((a) => a.label)).toEqual(['New expense claim']);
    const groups = [{ group: 'Sales', items: [{ href: '/sales/invoices', label: 'Invoices', locked: true }] }];
    expect(matchActions(groups, 'new invoice', owner)).toEqual([]);
  });

  it('points every action at a page that exists, under its list page', async () => {
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const a of PALETTE_ACTIONS) {
      expect(existsSync(join(__dirname, '../src/app/orgs/[orgId]', a.href, 'page.tsx')), a.href).toBe(true);
      expect(a.href.startsWith(`${a.parent}/`), a.href).toBe(true);
    }
  });
});
