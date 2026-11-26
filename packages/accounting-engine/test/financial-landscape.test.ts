import { describe, expect, it } from 'vitest';
import { financialLandscape, type VisualAccount } from '../src';

const acc = (id: string, code: string, name: string, type: 'REVENUE' | 'EXPENSE'): VisualAccount => ({ id, code, name, type, subtype: null }) as VisualAccount;
const accounts = [acc('sales', '4100', 'Sales', 'REVENUE'), acc('svc', '4200', 'Services', 'REVENUE'), acc('rent', '6200', 'Rent', 'EXPENSE'), acc('pay', '6100', 'Salaries', 'EXPENSE'), acc('fuel', '6300', 'Fuel', 'EXPENSE'), acc('web', '6400', 'Software', 'EXPENSE')];
const months = ['2026-04', '2026-05', '2026-06'];

describe('Financial landscape (DASH-023)', () => {
  it('lays out spending by account and month, largest first', () => {
    const l = financialLandscape({
      accounts,
      months,
      view: 'EXPENSES',
      scale: 2,
      amounts: [
        { accountId: 'pay', month: '2026-04', amount: '90000' },
        { accountId: 'pay', month: '2026-05', amount: '90000' },
        { accountId: 'rent', month: '2026-05', amount: '30000' },
        { accountId: 'fuel', month: '2026-06', amount: '5000' },
        { accountId: 'fuel', month: '2026-06', amount: '-1000' },
        // Revenue and months outside the range are not spending here.
        { accountId: 'sales', month: '2026-05', amount: '300000' },
        { accountId: 'rent', month: '2026-07', amount: '30000' },
      ],
    });
    expect(l.rows.map((r) => [r.label, r.values, r.total])).toEqual([
      ['6100 Salaries', ['90000.00', '90000.00', '0.00'], '180000.00'],
      ['6200 Rent', ['0.00', '30000.00', '0.00'], '30000.00'],
      ['6300 Fuel', ['0.00', '0.00', '4000.00'], '4000.00'],
    ]);
    expect(l.monthTotals).toEqual(['90000.00', '120000.00', '4000.00']);
    expect(l.total).toBe('214000.00');
    expect(l.peak).toEqual({ row: '6100 Salaries', month: '2026-04', amount: '90000.00' });
    expect(l.busiestMonth).toBe('2026-05');
  });

  it('joins the smaller accounts into one row', () => {
    const l = financialLandscape({
      accounts,
      months,
      view: 'EXPENSES',
      scale: 2,
      top: 2,
      amounts: [
        { accountId: 'pay', month: '2026-04', amount: '100' },
        { accountId: 'rent', month: '2026-04', amount: '50' },
        { accountId: 'fuel', month: '2026-05', amount: '20' },
        { accountId: 'web', month: '2026-06', amount: '10' },
      ],
    });
    expect(l.rows.map((r) => [r.key, r.label, r.total, r.accountIds.length])).toEqual([
      ['pay', '6100 Salaries', '100.00', 1],
      ['others', '3 other accounts', '80.00', 3],
    ]);
    expect(l.rows[1].values).toEqual(['50.00', '20.00', '10.00']);
  });

  it('shows revenue the same way, and nothing for empty books', () => {
    const r = financialLandscape({ accounts, months, view: 'REVENUE', scale: 0, amounts: [{ accountId: 'svc', month: '2026-06', amount: '700' }, { accountId: 'pay', month: '2026-06', amount: '5' }] });
    expect(r.rows.map((x) => [x.label, x.values])).toEqual([['4200 Services', ['0', '0', '700']]]);
    const e = financialLandscape({ accounts, months, view: 'REVENUE', scale: 2, amounts: [] });
    expect(e).toEqual({ view: 'REVENUE', months, rows: [], monthTotals: ['0.00', '0.00', '0.00'], total: '0.00', peak: null, busiestMonth: null });
  });
});
