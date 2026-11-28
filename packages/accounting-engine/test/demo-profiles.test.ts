import { describe, expect, it } from 'vitest';
import { DEMO_PROFILE_KEYS, DEMO_PROFILES, demoLabelIssues, demoPlan, demoProfile, isSyntheticName } from '../src/demo-profiles';
import { D } from '../src/money';

const TODAY = '2026-11-28';

describe('demonstration profiles', () => {
  it('has the six companies, each fully labelled synthetic', () => {
    expect(DEMO_PROFILES.map((p) => p.key)).toEqual([...DEMO_PROFILE_KEYS]);
    expect(DEMO_PROFILES.map((p) => p.title)).toEqual([
      'Indian consulting SME',
      'US professional services company',
      'UK trading business',
      'UAE multinational subsidiary',
      'Global manufacturing group',
      'Market research agency',
    ]);
    for (const p of DEMO_PROFILES) expect(demoLabelIssues(p), p.key).toEqual([]);
    expect(demoProfile('UK_TRADING')?.countryCode).toBe('GB');
    expect(demoProfile('NOPE')).toBeNull();
  });

  it('uses project and department codes the books accept, and customers that exist', () => {
    for (const p of DEMO_PROFILES) {
      for (const x of [...p.projects, ...p.departments]) expect(x.code, p.key).toMatch(/^[A-Z0-9_-]{1,20}$/);
      for (const x of p.projects) expect(p.customers[x.customer], `${p.key} ${x.code}`).toBeDefined();
      for (const s of p.staff)
        expect(
          p.departments.map((d) => d.code),
          `${p.key} ${s.name}`,
        ).toContain(s.department);
      for (const o of p.overheads) expect(p.departments.map((d) => d.code)).toContain(o.department);
      if (p.payroll) expect(p.countryCode).toBe('IN');
    }
  });

  it('refuses a profile whose names do not say they are synthetic', () => {
    const p = demoProfile('US_SERVICES')!;
    const bad = {
      ...p,
      orgName: 'Juniper Ridge Consulting LLC',
      customers: [{ ...p.customers[0]!, name: 'Bayside Medical Group' }, ...p.customers.slice(1)],
      staff: [{ ...p.staff[0]!, pan: 'ABCPK1234Q' }],
    };
    const issues = demoLabelIssues(bad);
    expect(issues).toContain('Organisation "Juniper Ridge Consulting LLC" must end with (SYNTHETIC DATA)');
    expect(issues).toContain('Customer "Bayside Medical Group" must say (synthetic)');
    expect(issues.some((i) => i.includes('made-up PAN'))).toBe(true);
    expect(isSyntheticName('Avon Wholesale Supplies (synthetic)')).toBe(true);
    expect(isSyntheticName('Falconcrest Group plc, UK parent (synthetic)')).toBe(true);
    expect(isSyntheticName('Avon Wholesale Supplies')).toBe(false);
  });
});

describe('demonstration plan', () => {
  it('is the same every time for the same profile, date and seed', () => {
    const p = demoProfile('IN_CONSULTING')!;
    expect(demoPlan(p, { today: TODAY })).toEqual(demoPlan(p, { today: TODAY }));
    expect(demoPlan(p, { today: TODAY, seed: 7 })).not.toEqual(demoPlan(p, { today: TODAY }));
  });

  it('covers six months to today, with the fiscal years the books need', () => {
    const india = demoPlan(demoProfile('IN_CONSULTING')!, { today: TODAY });
    expect(india.months).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    expect(india.fiscalYears).toEqual([2027]);
    const us = demoPlan(demoProfile('US_SERVICES')!, { today: '2027-02-10' });
    expect(us.months[0]).toBe('2026-09');
    expect(us.fiscalYears).toEqual([2026, 2027]);
    for (const plan of [india, us]) {
      const dates = [...plan.invoices.map((i) => i.date), ...plan.bills.map((b) => b.date), ...plan.journals.map((j) => j.date), ...plan.invoices.flatMap((i) => (i.settleOn ? [i.settleOn] : []))];
      expect(dates.every((d) => d >= plan.openingDate && d <= (plan === india ? TODAY : '2027-02-10'))).toBe(true);
    }
  });

  it('settles documents on their due date when it has come, leaving recent ones open', () => {
    const plan = demoPlan(demoProfile('UK_TRADING')!, { today: TODAY });
    const latest = plan.invoices.filter((i) => i.month === '2026-11');
    expect(latest.every((i) => i.settle === 'OPEN' && i.settleOn === null)).toBe(true);
    const old = plan.invoices.filter((i) => i.month === '2026-06');
    expect(old.filter((i) => i.customer === 1).every((i) => i.settle === 'PART')).toBe(true);
    expect(old.filter((i) => i.customer === 0).every((i) => i.settle === 'FULL' && i.settleOn === '2026-07-08')).toBe(true);
    // The occasional customer is invoiced every other month.
    expect(plan.invoices.filter((i) => i.customer === 3).map((i) => i.month)).toEqual(['2026-06', '2026-08', '2026-10']);
    expect(plan.invoices.filter((i) => i.customer === 3).every((i) => i.abroad)).toBe(true);
  });

  it('balances every journal and keeps money as two-decimal strings', () => {
    for (const p of DEMO_PROFILES) {
      const plan = demoPlan(p, { today: TODAY });
      for (const j of plan.journals) {
        const dr = j.lines.reduce((s, l) => s.plus(l.debit ?? 0), new D(0));
        const cr = j.lines.reduce((s, l) => s.plus(l.credit ?? 0), new D(0));
        expect(dr.eq(cr), `${p.key} ${j.memo}`).toBe(true);
        expect(dr.gt(0)).toBe(true);
      }
      for (const b of plan.bills) expect(b.amount).toMatch(/^\d+\.\d{2}$/);
      for (const i of plan.invoices) for (const l of i.lines) expect(l.unitPrice).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it('moves goods businesses’ cost of sales from inventory, and journals salaries outside India', () => {
    const uk = demoPlan(demoProfile('UK_TRADING')!, { today: TODAY });
    const cogs = uk.journals.find((j) => j.memo === 'Cost of goods sold 2026-06 (synthetic)')!;
    const sold = uk.invoices.filter((i) => i.month === '2026-06').reduce((s, i) => s.plus(i.lines.reduce((t, l) => t.plus(new D(l.quantity).times(l.unitPrice)), new D(0))), new D(0));
    expect(cogs.lines[0]).toEqual({ account: '5000', department: null, debit: sold.times('0.58').toDecimalPlaces(2).toFixed(2) });
    expect(uk.journals.filter((j) => j.memo.startsWith('Salaries')).map((j) => j.date)).toEqual(['2026-06-28', '2026-07-28', '2026-08-28', '2026-09-28', '2026-10-28', '2026-11-28']);
    expect(uk.payrollMonths).toEqual([]);
    const india = demoPlan(demoProfile('MARKET_RESEARCH')!, { today: TODAY });
    expect(india.journals.some((j) => j.memo.startsWith('Salaries'))).toBe(false);
    expect(india.payrollMonths).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(india.journals.some((j) => j.memo.startsWith('Cost of goods sold'))).toBe(false);
  });

  it('budgets the current fiscal year from the run rate, 8% higher, in thousands', () => {
    const plan = demoPlan(demoProfile('IN_CONSULTING')!, { today: TODAY });
    expect(plan.budget.fiscalYear).toBe(2027);
    const rent = plan.budget.lines.find((l) => l.account === '6200')!;
    // 85,000 a month, twelve months, 8% higher: 1,101,600 rounded to 1,102,000.
    expect(rent.annual).toBe('1102000.00');
    const pay = plan.budget.lines.find((l) => l.account === '6100')!;
    expect(pay.annual).toBe(new D(367000).times(12).times('1.08').dividedBy(1000).toDecimalPlaces(0).times(1000).toFixed(2));
    expect(plan.budget.lines.every((l) => /^[456]/.test(l.account))).toBe(true);
    expect(plan.budget.lines.some((l) => l.account === '4200')).toBe(true);
  });
});
