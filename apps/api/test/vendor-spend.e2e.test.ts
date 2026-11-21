import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/** RPT-016: vendor spending from posted bills and vendor credits. */
let ctx: Ctx;
let owner: TestUser;
let employee: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const T = today();

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Owner');
  employee = await registerUser(ctx, 'Employee');
  // The fiscal year starts next month, so it began eleven months ago and every date below is open.
  org = await createOrg(ctx, owner, { fiscalYearStartMonth: (Number(T.slice(5, 7)) % 12) + 1 });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: employee.email, role: 'EMPLOYEE' }).expect(201);
  const vendor = async (name: string) => (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, isVendor: true }).expect(201)).body.id as string;
  const landlord = await vendor('Synthetic Landlord');
  const cloud = await vendor('Synthetic Cloud LLC');
  const bill = (contactId: string, issueDate: string, lines: [string, string][], extra: Record<string, unknown> = {}) =>
    ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId, issueDate, dueDate: issueDate, reference: `SYN-${Math.floor(Date.parse(issueDate) / 1000)}-${lines.length}-${contactId.slice(0, 4)}`, post: true, lines: lines.map(([code, unitPrice]) => ({ accountId: org.acc[code], quantity: '1', unitPrice })), ...extra }).expect(201);
  await bill(landlord, T, [['6200', '50000.00']]);
  await bill(landlord, addDays(T, -3), [['6200', '25000.00'], ['6300', '1234.50']]);
  await bill(cloud, addDays(T, -2), [['6400', '120.00']], { currency: 'USD', exchangeRate: '83.255' });
  await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'VENDOR_CREDIT', contactId: cloud, issueDate: T, post: true, currency: 'USD', exchangeRate: '83.255', lines: [{ accountId: org.acc['6400'], quantity: '1', unitPrice: '20.00' }] }).expect(201);
  await bill(landlord, addDays(T, -15), [['6200', '45000.00']]); // the period before
  await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: cloud, issueDate: T, dueDate: T, reference: 'SYN-DRAFT', lines: [{ accountId: org.acc['6400'], quantity: '1', unitPrice: '999.00' }] }).expect(201); // a draft: not spend
});
afterAll(async () => {
  await ctx.app.close();
});

describe('vendor spending', () => {
  it('totals posted bills before tax at their own rate, less credits, by vendor, account and month', async () => {
    const s = (await ctx.http().get(`${org.base}/reports/vendor-spend?from=${addDays(T, -9)}&to=${T}`).set(owner.auth).expect(200)).body;
    expect(s.currency).toBe('INR');
    // 120 USD at 83.255 = 9990.60; 20 USD back = 1665.10.
    expect(s.total).toBe('84560.00');
    expect(s.vendors.map((v: { name: string; amount: string; bills: number }) => [v.name, v.amount, v.bills])).toEqual([['Synthetic Landlord', '76234.50', 2], ['Synthetic Cloud LLC', '8325.50', 1]]);
    expect(s.vendors[0].share).toBe('0.9015');
    expect(s.accounts.map((a: { code: string; amount: string }) => [a.code, a.amount])).toEqual([['6200', '75000.00'], ['6400', '8325.50'], ['6300', '1234.50']]);
    const months = s.months.reduce((t: bigint, m: { amount: string }) => t + BigInt(m.amount.replace('.', '')), 0n);
    expect(months).toBe(8456000n);
    expect(s.vendorsFor80Percent).toBe(1);
  });

  it('compares with the same number of days just before', async () => {
    const s = (await ctx.http().get(`${org.base}/reports/vendor-spend?from=${addDays(T, -9)}&to=${T}`).set(owner.auth).expect(200)).body;
    expect(s.previous).toEqual({ from: addDays(T, -19), to: addDays(T, -10) });
    expect(s.previousTotal).toBe('45000.00');
    expect(s.change).toBe('39560.00');
    expect(s.vendors[0].previous).toBe('45000.00');
  });

  it('checks the dates, and needs reports and purchases access', async () => {
    await ctx.http().get(`${org.base}/reports/vendor-spend?from=${T}&to=${addDays(T, -1)}`).set(owner.auth).expect(400);
    await ctx.http().get(`${org.base}/reports/vendor-spend?from=${T}&to=${T}`).set(employee.auth).expect(403);
    const stranger = await registerUser(ctx, 'Stranger');
    await ctx.http().get(`${org.base}/reports/vendor-spend?from=${T}&to=${T}`).set(stranger.auth).expect(404);
  });
});
