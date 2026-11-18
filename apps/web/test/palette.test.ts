import { describe, expect, it } from 'vitest';
import { NAV } from '../src/lib/nav';
import { matchPages } from '../src/lib/palette';

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
