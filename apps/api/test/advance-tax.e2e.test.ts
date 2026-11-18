import { taxYearOf } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Advance tax (TAX-021) against the real API and database: the year's income from the books or
 * an estimate, adjustments, the tax with surcharge and cess, credits from the TDS account, and
 * the instalments against payments debited to the advance tax account.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const ty = taxYearOf(T);
const acct: Record<string, string> = {};
const journal = (date: string, debit: string, credit: string, amount: string) =>
  ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date, post: true, memo: 'Advance tax test', lines: [{ accountId: debit, debit: amount }, { accountId: credit, credit: amount }] }).expect(201);
const get = async (auth = owner.auth) => (await ctx.http().get(`${org.base}/tax/advance-tax`).set(auth).expect(200)).body;
const plan = (body: Record<string, unknown>) =>
  ctx.http().put(`${org.base}/tax/advance-tax`).set(owner.auth).send({ taxYear: ty.label, regime: 'COMPANY_22', method: 'ANNUALISE', estimatedIncome: null, adjustments: [], paidAccountId: null, tdsAccountId: null, otherCredits: '0', ...body });

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Tax Owner');
  viewer = await registerUser(ctx, 'Tax Viewer');
  org = await createOrg(ctx, owner);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  for (const [code, name] of [['1460', 'Advance Tax Paid'], ['1470', 'TDS Receivable']]) acct[code] = (await ctx.http().post(`${org.base}/accounts`).set(owner.auth).send({ code, name, type: 'ASSET', subtype: 'OTHER_CURRENT_ASSET' }).expect(201)).body.id;
  await journal(ty.from, org.acc['1120'], org.acc['4100'], '1000000.00');
  await journal(ty.from, org.acc['6200'], org.acc['1120'], '200000.00');
  await journal(ty.from, org.acc['8100'], org.acc['2300'], '50000.00');
  await journal(ty.from, acct['1470'], org.acc['4100'], '10000.00');
  await journal(ty.from, acct['1460'], org.acc['1120'], '60000.00');
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('advance tax', () => {
  it('works from the books before any plan is saved, leaving income tax expense out', async () => {
    const r = await get(viewer.auth);
    expect(r.taxYear).toBe(ty.label);
    expect(r.saved).toBeNull();
    expect(r.plan).toMatchObject({ regime: 'COMPANY_25', method: 'ANNUALISE' });
    expect(r.income.profitToDate).toBe('810000.00');
    expect(r.income.taxExpenseExcluded).toBe('50000.00');
    expect(Number(r.income.projected)).toBeGreaterThanOrEqual(810000);
    expect(r.payments).toEqual([]);
    expect(r.instalments).toHaveLength(4);
  });

  it('checks the plan', async () => {
    await ctx.http().put(`${org.base}/tax/advance-tax`).set(viewer.auth).send({}).expect(403);
    expect((await plan({ method: 'ESTIMATE' }).expect(422)).body.message).toBe('Enter the estimated profit for the year');
    expect((await plan({ paidAccountId: org.acc['6200'] }).expect(422)).body.message).toBe('The advance tax paid account must be a postable asset account');
    expect((await plan({ paidAccountId: acct['1460'], tdsAccountId: acct['1460'] }).expect(422)).body.message).toMatch(/different accounts/);
    await plan({ otherCredits: '-1' }).expect(400);
    await plan({ regime: 'INDIVIDUAL' }).expect(400);
    await plan({ taxYear: '2026-28' }).expect(400);
  });

  it('works out the tax, credits and instalments from a saved plan', async () => {
    const r = (
      await plan({
        method: 'ESTIMATE',
        estimatedIncome: '2000000',
        adjustments: [{ label: 'Penalties not allowed', amount: '100000' }, { label: 'Extra depreciation for tax', amount: '-50000' }],
        paidAccountId: acct['1460'],
        tdsAccountId: acct['1470'],
        otherCredits: '5000',
      }).expect(200)
    ).body;
    expect(r.saved.updatedBy).toBe('Tax Owner');
    expect(r.plan.paidAccount).toMatchObject({ code: '1460' });
    expect(r.income).toMatchObject({ projected: '2000000.00', adjustments: '50000.00', taxable: '2050000.00' });
    // 22% tax, 10% surcharge, 4% cess, rounded to tens.
    expect(r.tax).toMatchObject({ tax: '451000.00', surchargeRate: '10', surcharge: '45100.00', marginalRelief: '0.00', cess: '19844.00', total: '515940.00' });
    expect(r.credits).toEqual({ tds: '10000.00', other: '5000.00', total: '15000.00' });
    expect(r.netLiability).toBe('500940.00');
    expect(r.required).toBe(true);
    expect(r.payments).toEqual([{ date: ty.from, amount: '60000.00' }]);
    expect(r.paid).toBe('60000.00');
    expect(r.remaining).toBe('440940.00');
    expect(r.instalments.map((i: { required: string }) => i.required)).toEqual(['75141.00', '225423.00', '375705.00', '500940.00']);
    expect(r.instalments[0]).toMatchObject({ dueDate: `${ty.from.slice(0, 4)}-06-15`, paidByDue: '60000.00', toPay: '15141.00' });
    expect(['SHORT', 'UPCOMING']).toContain(r.instalments[0].status);
    expect(await get(viewer.auth)).toEqual(r);
  });

  it('needs no advance tax below ₹10,000 after credits', async () => {
    const r = (await plan({ method: 'ESTIMATE', estimatedIncome: '40000', tdsAccountId: acct['1470'] }).expect(200)).body;
    expect(r.tax.total).toBe('10070.00');
    expect(r.netLiability).toBe('70.00');
    expect(r.required).toBe(false);
    expect(r.instalments.every((i: { required: string }) => i.required === '0.00')).toBe(true);
  });

  it('is for Indian organisations only', async () => {
    const us = await createOrg(ctx, owner, { name: 'US Co', countryCode: 'US', functionalCurrency: 'USD', fiscalYearStartMonth: 1 });
    expect((await ctx.http().get(`${us.base}/tax/advance-tax`).set(owner.auth).expect(422)).body.error).toBe('NOT_INDIA');
  });
});
