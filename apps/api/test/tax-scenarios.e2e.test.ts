import { taxYearOf } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Tax scenario simulations (TAX-049) against the real API and database: the year's advance tax
 * estimate as the baseline, the regimes compared, a scenario worked out without saving, saved
 * scenarios with the audit trail, validation, permissions, organisations outside India and tenants.
 */
const ty = taxYearOf(today());
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const S = () => `${org.base}/tax/scenarios`;
const growth = { revenueChange: '2000000', revenueGstRate: '18', expenseChange: '500000', expenseGstRate: '12', extraDepreciation: '300000', disallowed: '100000' };

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Scenario Owner');
  viewer = await registerUser(ctx, 'Scenario Viewer');
  outsider = await registerUser(ctx, 'Scenario Outsider');
  org = await createOrg(ctx, owner, { name: 'What If Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Scenarios Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  // The year's estimate: 50 lakh at 25%, with 2 lakh of credits.
  await ctx.http().put(`${org.base}/tax/advance-tax`).set(owner.auth).send({ taxYear: ty.label, regime: 'COMPANY_25', method: 'ESTIMATE', estimatedIncome: '5000000', adjustments: [], paidAccountId: null, tdsAccountId: null, otherCredits: '200000' }).expect(200);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('tax scenarios', () => {
  it('starts from the advance tax estimate and compares the regimes', async () => {
    const r = (await ctx.http().get(S()).set(viewer.auth).expect(200)).body;
    expect(r.baseline).toMatchObject({ taxYear: ty.label, method: 'ESTIMATE', regime: 'COMPANY_25', income: '5000000.00', tax: '1300000.00', credits: '200000.00', netLiability: '1100000.00' });
    expect(r.comparison).toEqual([
      { regime: 'COMPANY_22', label: 'Company, concessional rate (22%)', total: '1258400.00', current: false, saving: '41600.00' },
      { regime: 'COMPANY_25', label: 'Company, turnover up to ₹400 crore (25%)', total: '1300000.00', current: true, saving: '0.00' },
      { regime: 'COMPANY_30', label: 'Company, other (30%)', total: '1560000.00', current: false, saving: '-260000.00' },
    ]);
    expect(r.scenarios).toEqual([]);
    expect(r.gstRates).toContain('18');
  });

  it('works out a scenario without saving it', async () => {
    const r = (await ctx.http().post(`${S()}/simulate`).set(viewer.auth).send(growth).expect(200)).body.result;
    expect(r).toMatchObject({ regime: 'COMPANY_25', bookProfit: '6200000.00', taxableIncome: '6300000.00', taxChange: '338000.00', netPayable: '1438000.00', profitAfterTax: '4562000.00', effectiveRate: '26.4', cashEffect: '1162000.00' });
    expect(r.tax.total).toBe('1638000.00');
    expect(r.gst).toEqual({ output: '360000.00', input: '60000.00', net: '300000.00' });
    const lower = (await ctx.http().post(`${S()}/simulate`).set(owner.auth).send({ regime: 'COMPANY_22' }).expect(200)).body.result;
    expect(lower).toMatchObject({ taxChange: '-41600.00', cashEffect: '41600.00' });
    expect(lower.notes[1]).toMatch(/cannot be withdrawn/);
    expect((await ctx.http().get(S()).set(owner.auth).expect(200)).body.scenarios).toEqual([]);
  });

  it('saves named scenarios, worked out on every read, and deletes them', async () => {
    const saved = (await ctx.http().post(S()).set(owner.auth).send({ name: 'New plant', note: 'Second line from October', ...growth }).expect(201)).body;
    expect(saved).toMatchObject({ name: 'New plant', createdBy: 'Scenario Owner', result: { taxChange: '338000.00' } });
    await ctx.http().post(S()).set(owner.auth).send({ name: 'Concessional rate', regime: 'COMPANY_22' }).expect(201);
    expect((await ctx.http().post(S()).set(owner.auth).send({ name: 'new PLANT' }).expect(409)).body.error).toBe('NAME_TAKEN');
    const r = (await ctx.http().get(S()).set(viewer.auth).expect(200)).body;
    expect(r.scenarios.map((s: { name: string; result: { taxChange: string } }) => [s.name, s.result.taxChange])).toEqual([['New plant', '338000.00'], ['Concessional rate', '-41600.00']]);
    expect(r.scenarios[0]).toMatchObject({ note: 'Second line from October', input: { revenueChange: '2000000', expenseGstRate: '12', regime: null } });
    // A new estimate moves every saved scenario with it.
    await ctx.http().put(`${org.base}/tax/advance-tax`).set(owner.auth).send({ taxYear: ty.label, regime: 'COMPANY_25', method: 'ESTIMATE', estimatedIncome: '4000000', adjustments: [], paidAccountId: null, tdsAccountId: null, otherCredits: '200000' }).expect(200);
    const moved = (await ctx.http().get(S()).set(owner.auth).expect(200)).body.scenarios[0].result;
    expect(moved).toMatchObject({ taxableIncome: '5300000.00', taxChange: '338000.00' });
    await ctx.http().delete(`${S()}/${saved.id}`).set(viewer.auth).expect(403);
    await ctx.http().delete(`${S()}/${saved.id}`).set(owner.auth).expect(200);
    await ctx.http().delete(`${S()}/${saved.id}`).set(owner.auth).expect(404);
    expect((await ctx.http().get(S()).set(owner.auth).expect(200)).body.scenarios).toHaveLength(1);
    const events = await ctx.db.collection('audit_events').find({ orgId: org.orgId, entityType: 'tax_scenario' }).sort({ createdAt: 1 }).toArray();
    expect(events.map((e) => e.action)).toEqual(['tax_scenario.saved', 'tax_scenario.saved', 'tax_scenario.deleted']);
  });

  it('checks the input and permissions', async () => {
    await ctx.http().post(`${S()}/simulate`).set(owner.auth).send({ revenueChange: '1.234' }).expect(400);
    await ctx.http().post(`${S()}/simulate`).set(owner.auth).send({ extraDepreciation: '-5' }).expect(400);
    await ctx.http().post(`${S()}/simulate`).set(owner.auth).send({ revenueGstRate: '15' }).expect(400);
    await ctx.http().post(`${S()}/simulate`).set(owner.auth).send({ regime: 'INDIVIDUAL' }).expect(400);
    await ctx.http().post(S()).set(owner.auth).send({ name: ' ' }).expect(400);
    await ctx.http().post(S()).set(viewer.auth).send({ name: 'Viewer' }).expect(403);
    await ctx.http().get(`${S()}?taxYear=2026-28`).set(owner.auth).expect(400);
    await ctx.http().delete(`${S()}/not-an-id`).set(owner.auth).expect(400);
  });

  it('keeps scenarios to their organisation, and to Indian organisations', async () => {
    await ctx.http().get(S()).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/tax/scenarios`).set(outsider.auth).expect(200)).body.scenarios).toEqual([]);
    const mine = (await ctx.http().get(S()).set(owner.auth).expect(200)).body.scenarios[0].id;
    await ctx.http().delete(`${other.base}/tax/scenarios/${mine}`).set(outsider.auth).expect(404);
    const us = await createOrg(ctx, outsider, { name: 'US Scenarios Inc', countryCode: 'US', functionalCurrency: 'USD', fiscalYearStartMonth: 1 });
    expect((await ctx.http().get(`${us.base}/tax/scenarios`).set(outsider.auth).expect(422)).body.error).toBe('NOT_INDIA');
  });
});
