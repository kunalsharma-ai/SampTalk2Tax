import { taxYearOf } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Income tax computation (TAX-019, TAX-020) against the real API and database, for the last
 * financial year: book profit with depreciation and income tax expense, cash payments over 10,000
 * in a day, TDS and advance tax from the advance tax plan's accounts, the preparer's depreciation
 * under section 32, brought forward loss and adjustments; saving, finalising and later postings;
 * validation, permissions and tenants. Every figure is worked out by hand below.
 */
const current = taxYearOf(today());
const P = Number(current.from.slice(0, 4)) - 1;
const LAST = taxYearOf(`${P}-04-01`);
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let us: Awaited<ReturnType<typeof createOrg>>;
const R = () => `${org.base}/tax/income-computation`;
const INPUT = {
  regime: 'COMPANY_22',
  taxDepreciation: '150000',
  broughtForwardLoss: '200000',
  adjustments: [{ label: 'Donations not deductible', section: '37(1)', kind: 'ADD', amount: '10000' }],
  otherCredits: '0',
};

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Computation Owner');
  accountant = await registerUser(ctx, 'Computation Accountant');
  viewer = await registerUser(ctx, 'Computation Viewer');
  org = await createOrg(ctx, owner, { name: 'Computed Traders Pvt Ltd' });
  us = await createOrg(ctx, owner, { name: 'US Books Inc', countryCode: 'US', functionalCurrency: 'USD', fiscalYearStartMonth: 1 });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: P + 1 });
  const journal = (date: string, debit: string, credit: string, amount: string) =>
    ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date, post: true, memo: 'Computation test', lines: [{ accountId: org.acc[debit], debit: amount }, { accountId: org.acc[credit], credit: amount }] }).expect(201);
  await journal(`${P}-05-05`, '1120', '4100', '2000000.00');
  await journal(`${P}-06-01`, '6600', '1120', '600000.00');
  await journal(`${P + 1}-03-31`, '6800', '1520', '120000.00');
  await journal(`${P + 1}-03-31`, '8100', '2300', '250000.00');
  await journal(`${P}-09-15`, '1400', '1120', '100000.00');
  await journal(`${P}-10-10`, '1450', '1120', '20000.00');
  const kirana = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Local Kirana', isVendor: true }).expect(201)).body.id;
  for (const amount of ['6000.00', '5000.00']) await ctx.http().post(`${org.base}/purchases/payments`).set(owner.auth).send({ contactId: kirana, date: `${P}-06-03`, bankAccountId: org.acc['1110'], amount, allocations: [] }).expect(201);
  await ctx.http().put(`${org.base}/tax/advance-tax`).set(owner.auth).send({ taxYear: LAST.label, regime: 'COMPANY_22', method: 'ANNUALISE', estimatedIncome: null, adjustments: [], paidAccountId: org.acc['1400'], tdsAccountId: org.acc['1450'], otherCredits: '0' }).expect(200);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('income tax computation', () => {
  it('starts from the books for the last financial year', async () => {
    const r = (await ctx.http().get(R()).set(viewer.auth).expect(200)).body;
    expect(r).toMatchObject({ taxYear: LAST.label, from: LAST.from, to: LAST.to, yearEnded: true, status: 'DRAFT', saved: false, taxInBooks: '250000.00', input: { regime: 'COMPANY_22', taxDepreciation: null, broughtForwardLoss: '0' } });
    expect(r.lines.map((l: { key: string; section: string | null; amount: string }) => [l.key, l.section, l.amount])).toEqual([
      ['PROFIT', null, '1280000.00'],
      ['BOOK_DEPRECIATION', '32', '120000.00'],
      ['CASH_PAYMENTS', '40A(3)', '11000.00'],
    ]);
    expect(r).toMatchObject({ businessIncome: '1411000.00', totalIncome: '1411000.00', credits: { tds: '20000.00', advanceTax: '100000.00', total: '120000.00' } });
    expect(r.warnings).toEqual(['Enter the depreciation allowed under section 32 from the block-of-assets working; until then none is deducted.']);
    expect(r.sources).toMatchObject({ cashPaymentDays: 1, tdsAccount: { code: '1450' }, advanceTaxAccount: { code: '1400' } });
  });

  it('saves the preparer\'s inputs and works out the tax payable', async () => {
    await ctx.http().put(`${R()}/${LAST.label}`).set(viewer.auth).send(INPUT).expect(403);
    const r = (await ctx.http().put(`${R()}/${LAST.label}`).set(accountant.auth).send(INPUT).expect(200)).body;
    expect(r).toMatchObject({ saved: true, status: 'DRAFT', updatedBy: 'Computation Accountant', warnings: [] });
    // 12,80,000 + 1,20,000 − 1,50,000 + 11,000 + 10,000 = 12,71,000; less 2,00,000 brought forward.
    expect(r).toMatchObject({ businessIncome: '1271000.00', lossSetOff: '200000.00', totalIncome: '1071000.00', roundedIncome: '1071000.00', lossCarriedForward: '0.00' });
    // 22% = 2,35,620; surcharge 10% = 23,562; cess 4% = 10,367.28; total rounded to 2,69,550.
    expect(r.tax).toEqual({ tax: '235620.00', surchargeRate: '10', surcharge: '23562.00', marginalRelief: '0.00', cess: '10367.28', total: '269550.00' });
    expect(r).toMatchObject({ payable: '149550.00', refund: '0.00' });
    expect(r.lines.find((l: { key: string }) => l.key === 'ADJUSTMENT_1')).toEqual({ key: 'ADJUSTMENT_1', label: 'Donations not deductible', section: '37(1)', kind: 'ADD', amount: '10000.00' });
  });

  it('finalises the computation and lists later postings against it', async () => {
    await ctx.http().post(`${R()}/${LAST.label}/finalise`).set(viewer.auth).expect(403);
    const f = (await ctx.http().post(`${R()}/${LAST.label}/finalise`).set(owner.auth).expect(200)).body;
    expect(f).toMatchObject({ status: 'FINAL', finalisedBy: 'Computation Owner', payable: '149550.00', changedSince: null });
    await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: `${P + 1}-02-01`, post: true, memo: 'Late sale', lines: [{ accountId: org.acc['1120'], debit: '50000.00' }, { accountId: org.acc['4100'], credit: '50000.00' }] }).expect(201);
    const after = (await ctx.http().get(`${R()}?year=${LAST.label}`).set(viewer.auth).expect(200)).body;
    expect(after).toMatchObject({ status: 'FINAL', payable: '149550.00', changedSince: { then: '1280000.00', now: '1330000.00' } });
    expect((await ctx.http().put(`${R()}/${LAST.label}`).set(owner.auth).send(INPUT).expect(409)).body.error).toBe('COMPUTATION_FINAL');
    expect((await ctx.http().post(`${R()}/${LAST.label}/finalise`).set(owner.auth).expect(409)).body.error).toBe('COMPUTATION_FINAL');
    const events = await ctx.db.collection('audit_events').find({ orgId: org.orgId, entityType: 'income_tax_computation' }).toArray();
    expect(events.map((e) => e.action)).toEqual(['income_tax_computation.saved', 'income_tax_computation.finalised']);
    expect(events[1]!.data).toMatchObject({ taxYear: LAST.label, totalIncome: '1071000.00', payable: '149550.00' });
  });

  it('keeps the current year open and checks the request', async () => {
    const now = (await ctx.http().get(`${R()}?year=${current.label}`).set(viewer.auth).expect(200)).body;
    expect(now).toMatchObject({ taxYear: current.label, yearEnded: false, status: 'DRAFT' });
    expect((await ctx.http().post(`${R()}/${current.label}/finalise`).set(owner.auth).expect(409)).body.error).toBe('YEAR_NOT_ENDED');
    const next = taxYearOf(`${Number(current.from.slice(0, 4)) + 1}-04-01`).label;
    expect((await ctx.http().get(`${R()}?year=${next}`).set(viewer.auth).expect(422)).body.error).toBe('FUTURE_YEAR');
    expect((await ctx.http().get(`${R()}?year=2025-27`).set(viewer.auth).expect(400)).body.error).toBe('INVALID_TAX_YEAR');
    expect((await ctx.http().post(`${R()}/${current.label}/finalise`).set(owner.auth).send({}).expect(409)).body.error).toBe('YEAR_NOT_ENDED');
    await ctx.http().put(`${R()}/${current.label}`).set(owner.auth).send({ ...INPUT, regime: 'PERSONAL' }).expect(400);
    await ctx.http().put(`${R()}/${current.label}`).set(owner.auth).send({ ...INPUT, broughtForwardLoss: '-5' }).expect(400);
    await ctx.http().put(`${R()}/${current.label}`).set(owner.auth).send({ ...INPUT, adjustments: [{ label: '', section: null, kind: 'ADD', amount: '1' }] }).expect(400);
    expect((await ctx.http().get(`${us.base}/tax/income-computation`).set(owner.auth).expect(422)).body.error).toBe('NOT_INDIA');
  });
});
