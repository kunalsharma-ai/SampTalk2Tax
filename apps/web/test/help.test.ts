import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { helpRoute, PAGE_HELP, pageHelp, pageHelpKey, SECTION_HELP, sectionHelp } from '../src/lib/help';
import { EMPLOYEE_NAV, NAV } from '../src/lib/nav';

const APP = join(__dirname, '../src/app');
const SRC = join(__dirname, '../src');
const walk = (dir: string, keep: (f: string) => boolean): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p, keep) : keep(p) ? [p] : [];
  });

/** Every page's route key, as the app would look it up: `app/orgs/[orgId]/sales/contracts/[contractId]/page.tsx` → `sales/contracts/[id]`. */
const ROUTES = walk(APP, (f) => f.endsWith('page.tsx')).map((f) =>
  relative(APP, f)
    .replace(/\/?page\.tsx$/, '')
    .replace(/^orgs\/\[orgId\]\/?/, '')
    .replace(/^\(auth\)\//, '')
    .split('/')
    .map((s) => (s === '[month]' ? s : /^\[.+\]$/.test(s) ? '[id]' : s))
    .join('/'),
);

describe('help routes', () => {
  it('turns a path into its route key', () => {
    expect(helpRoute('/orgs/0b0f4a8e-6c1d-4f0a-9b51-2f0e7e9a1c33/sales/contracts/7e1c2a44-1b2d-4c3e-8f9a-0a1b2c3d4e5f/edit')).toBe('sales/contracts/[id]/edit');
    expect(helpRoute('/orgs/0b0f4a8e-6c1d-4f0a-9b51-2f0e7e9a1c33')).toBe('');
    expect(helpRoute('/orgs/0b0f4a8e-6c1d-4f0a-9b51-2f0e7e9a1c33/reports/management/2026-10?x=1')).toBe('reports/management/[month]');
    expect(helpRoute('/admin/organisations/0b0f4a8e-6c1d-4f0a-9b51-2f0e7e9a1c33')).toBe('admin/organisations/[id]');
    expect(helpRoute('/invite/abcdefghijklmnopqrstuv')).toBe('invite/[id]');
    expect(helpRoute('/orgs/0b0f4a8e-6c1d-4f0a-9b51-2f0e7e9a1c33/reports/profit-by-dimension')).toBe('reports/profit-by-dimension');
  });

  it('falls back to the nearest page above', () => {
    expect(pageHelpKey('sales/contracts/[id]/edit')).toBe('sales/contracts');
    expect(pageHelpKey('banking/[id]/reconcile')).toBe('banking/[id]/reconcile');
    expect(pageHelpKey('nowhere/at/all')).toBe('');
  });
});

describe('page help', () => {
  it('covers every page of the app with its own help or a page above it', () => {
    const uncovered = ROUTES.filter((r) => r !== '' && pageHelpKey(r) === '');
    expect(uncovered).toEqual([]);
    expect(ROUTES.length).toBeGreaterThan(180);
  });

  it('has its own help for every menu item', () => {
    const missing = [...NAV, ...EMPLOYEE_NAV].flatMap((g) => g.items).map((i) => i.href.replace(/^\//, '')).filter((k) => !PAGE_HELP[k]);
    expect(missing).toEqual([]);
  });

  it('only describes pages that exist', () => {
    const stale = Object.keys(PAGE_HELP).filter((k) => !ROUTES.includes(k));
    expect(stale).toEqual([]);
  });

  it('says what each page is for, how to use it and where it fits, in full sentences', () => {
    for (const [k, h] of Object.entries(PAGE_HELP)) {
      for (const text of [h.what, h.how, h.where]) expect(text, k).toMatch(/^[A-Z"'].{8,}[.?!)]$/s);
    }
  });
});

describe('section help', () => {
  /** Every section title written as text in the app's source. */
  const TITLES = [...new Set(walk(SRC, (f) => f.endsWith('.tsx')).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/<CardHeader title="([^"]+)"/g)].map((m) => m[1]!)))];

  it('has help for every section title in the app', () => {
    expect(TITLES.length).toBeGreaterThan(150);
    expect(TITLES.filter((t) => !SECTION_HELP[t])).toEqual([]);
  });

  it('uses a page\'s own wording where a title means something else there', () => {
    expect(sectionHelp('journals/new', 'Lines')?.what).toMatch(/debits and credits/);
    expect(sectionHelp('sales/invoices/[id]', 'Lines')?.what).toMatch(/one row per item/);
    expect(sectionHelp('settings/subscription', 'Invoices')?.what).toMatch(/subscription/);
    expect(sectionHelp('sales/orders/[id]', 'Invoices')?.what).toMatch(/raised from this record/);
    expect(sectionHelp('sales/orders/[id]', 'A title nobody uses')).toBeNull();
  });

  it('only keeps page-specific entries for pages that exist', () => {
    const keys = Object.keys(SECTION_HELP).filter((k) => k.includes(' > ')).map((k) => k.split(' > ')[0]!);
    expect(keys.filter((k) => !ROUTES.includes(k))).toEqual([]);
  });

  it('finds help for the menu pages through pageHelp', () => {
    expect(pageHelp('sales/revenue-forecast/[id]')?.what).toBeTruthy();
  });
});
