import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/** Local financial statements (Schedule III, UK formats, IAS 1) from the real books. */
let ctx: Ctx;
let owner: TestUser;
let employee: TestUser;
let india: Awaited<ReturnType<typeof createOrg>>;

const row = (rows: { key: string; amount: string | null; previous: string | null }[], key: string) => rows.find((r) => r.key === key)!;
const journal = (org: Awaited<ReturnType<typeof createOrg>>, date: string, debit: string, credit: string, amount: string) =>
  ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date, post: true, memo: 'Statutory test', lines: [{ accountId: org.acc[debit], debit: amount }, { accountId: org.acc[credit], credit: amount }] }).expect(201);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Statutory Owner');
  employee = await registerUser(ctx, 'Statutory Employee');
  india = await createOrg(ctx, owner);
  await ctx.http().post(`${india.base}/members`).set(owner.auth).send({ email: employee.email, role: 'EMPLOYEE' }).expect(201);
  const d = today();
  await journal(india, d, '1120', '3100', '500000.00');
  await journal(india, d, '1510', '1120', '120000.00');
  await journal(india, d, '1120', '4100', '300000.00');
  await journal(india, d, '5000', '2200', '90000.00');
  await journal(india, d, '6100', '1120', '60000.00');
  await journal(india, d, '6800', '1520', '10000.00');
  await journal(india, d, '1120', '2700', '200000.00');
});
afterAll(async () => {
  await ctx.app.close();
});

describe('statutory statements', () => {
  it('lists the formats and picks the country one', async () => {
    const f = (await ctx.http().get(`${india.base}/reports/statutory/formats`).set(owner.auth).expect(200)).body;
    expect(f.default).toBe('IN_SCHEDULE_III');
    expect(f.formats.map((x: { id: string }) => x.id)).toEqual(['IN_SCHEDULE_III', 'GB_COMPANIES_ACT', 'IFRS_IAS1']);
  });

  it('builds Schedule III that agrees with the balance sheet and profit and loss', async () => {
    const d = today();
    const from = `${d.slice(0, 4)}-01-01` > d ? d : `${Number(d.slice(0, 4)) - 1}-04-01`;
    const s = (await ctx.http().get(`${india.base}/reports/statutory?from=${from}&to=${d}`).set(owner.auth).expect(200)).body;
    expect(s.format).toMatchObject({ id: 'IN_SCHEDULE_III', isCountryDefault: true, balanceSheetTitle: 'Balance sheet', profitAndLossTitle: 'Statement of profit and loss' });
    expect(s.checks).toEqual({ balanced: true, profitAgrees: true, netProfit: '140000.00' });
    expect(row(s.profitAndLoss, 'REVENUE').amount).toBe('300000.00');
    expect(row(s.profitAndLoss, 'TOTAL_EXPENSES').amount).toBe('160000.00');
    expect(row(s.profitAndLoss, 'PROFIT').amount).toBe('140000.00');
    expect(row(s.balanceSheet, 'PPE').amount).toBe('110000.00');
    expect(row(s.balanceSheet, 'CASH').amount).toBe('820000.00');
    expect(row(s.balanceSheet, 'RESERVES').amount).toBe('140000.00');
    expect(row(s.balanceSheet, 'TOTAL_A').amount).toBe('930000.00');
    expect(row(s.balanceSheet, 'TOTAL_EL').amount).toBe('930000.00');
    // The year before had nothing.
    expect(row(s.balanceSheet, 'TOTAL_A').previous).toBe('0.00');
    expect(s.previous.to).toBe(`${Number(d.slice(0, 4)) - 1}${d.slice(4)}`.replace(/-02-29$/, '-02-28'));
    // Lines name the accounts behind them.
    expect(s.balanceSheet.find((r: { key: string }) => r.key === 'PPE').accounts.map((a: { code: string; amount: string }) => [a.code, a.amount])).toEqual([['1510', '120000.00'], ['1520', '-10000.00']]);
    // Same figures as the plain reports.
    const bs = (await ctx.http().get(`${india.base}/reports/balance-sheet?asOf=${d}`).set(owner.auth).expect(200)).body;
    expect(bs.totalAssets).toBe('930000.00');
  });

  it('lists accounts without a subtype, and can use another layout', async () => {
    const d = today();
    const acc = (await ctx.http().post(`${india.base}/accounts`).set(owner.auth).send({ code: '1990', name: 'Suspense advances', type: 'ASSET' }).expect(201)).body;
    await ctx.http().post(`${india.base}/journals`).set(owner.auth).send({ date: d, post: true, memo: 'Advance', lines: [{ accountId: acc.id, debit: '5000.00' }, { accountId: india.acc['1120'], credit: '5000.00' }] }).expect(201);
    const s = (await ctx.http().get(`${india.base}/reports/statutory?from=${d}&to=${d}&format=GB_COMPANIES_ACT&comparative=false`).set(owner.auth).expect(200)).body;
    expect(s.format).toMatchObject({ id: 'GB_COMPANIES_ACT', isCountryDefault: false });
    expect(s.previous).toBeNull();
    expect(row(s.balanceSheet, 'NET_ASSETS').previous).toBeNull();
    expect(s.unclassified).toEqual([expect.objectContaining({ code: '1990', type: 'ASSET', subtype: null, placedOn: 'DEBTORS' })]);
    expect(row(s.balanceSheet, 'NET_ASSETS').amount).toBe(row(s.balanceSheet, 'SHAREHOLDERS_FUNDS').amount);
    expect(s.checks.balanced).toBe(true);
  });

  it('checks the request and who may read it', async () => {
    const d = today();
    await ctx.http().get(`${india.base}/reports/statutory?from=${d}&to=${d}&format=US_GAAP`).set(owner.auth).expect(400);
    await ctx.http().get(`${india.base}/reports/statutory?from=${d}&to=2000-01-01`).set(owner.auth).expect(400);
    await ctx.http().get(`${india.base}/reports/statutory?from=${d}&to=${d}`).set(employee.auth).expect(403);
    const uk = await createOrg(ctx, owner, { name: 'Statutory UK Ltd', countryCode: 'GB', functionalCurrency: 'GBP', fiscalYearStartMonth: 4 });
    expect((await ctx.http().get(`${uk.base}/reports/statutory/formats`).set(owner.auth).expect(200)).body.default).toBe('GB_COMPANIES_ACT');
    const ae = await createOrg(ctx, owner, { name: 'Statutory AE', countryCode: 'AE', functionalCurrency: 'AED', fiscalYearStartMonth: 1 });
    expect((await ctx.http().get(`${ae.base}/reports/statutory?from=${d}&to=${d}`).set(owner.auth).expect(200)).body.format.id).toBe('IFRS_IAS1');
  });
});
