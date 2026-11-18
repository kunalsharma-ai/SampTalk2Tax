import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * TRS-002 cash by currency against the real API and database: the treasury overview gives each
 * bank account kept in another currency its balance in that currency next to what the books
 * carry, and totals cash by currency with each one's share; an organisation with only its own
 * currency has a single row; other organisations are not counted.
 */
let ctx: Ctx;
let owner: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let usd: string;

const day = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const journal = (lines: object[], memo: string) => ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: day(2), memo, post: true, lines }).expect(201);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Treasury Owner');
  outsider = await registerUser(ctx, 'Treasury Outsider');
  org = await createOrg(ctx, owner);
  other = await createOrg(ctx, outsider, { name: 'Other Treasury Ltd' });
  await ctx.http().put(`${org.base}/fx/rates`).set(owner.auth).send({ currency: 'USD', date: day(5), rate: '83.50' }).expect(200);
  usd = (await ctx.http().post(`${org.base}/accounts`).set(owner.auth).send({ code: '1130', name: 'USD Account', type: 'ASSET', subtype: 'BANK' }).expect(201)).body.id;
  await ctx.http().put(`${org.base}/banking/accounts/${usd}/currency`).set(owner.auth).send({ currency: 'USD' }).expect(200);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('cash by currency on the treasury overview', () => {
  it('has one row while every account is in the functional currency', async () => {
    await journal([{ accountId: org.acc['1120'], debit: '250000.00' }, { accountId: org.acc['3100'], credit: '250000.00' }], 'Capital');
    const t = (await ctx.http().get(`${org.base}/loans/treasury`).set(owner.auth).expect(200)).body;
    expect(t.cash).toMatchObject({ total: '250000.00', currency: 'INR' });
    expect(t.cash.byCurrency).toEqual([{ currency: 'INR', accounts: t.cash.accounts.length - 1, amount: '250000.00', functional: '250000.00', share: '100.0' }, { currency: 'USD', accounts: 1, amount: '0.00', functional: '0.00', share: '0.0' }]);
  });

  it('shows a USD account in dollars and in rupees, and totals each currency', async () => {
    await journal([{ accountId: usd, currency: 'USD', debit: '3000.00' }, { accountId: org.acc['3100'], currency: 'USD', credit: '3000.00' }], 'Dollar capital');
    const t = (await ctx.http().get(`${org.base}/loans/treasury`).set(owner.auth).expect(200)).body;
    const row = t.cash.accounts.find((a: { id: string }) => a.id === usd);
    expect(row).toMatchObject({ code: '1130', currency: 'USD', currencyBalance: '3000.00', balance: '250500.00' });
    const inr = t.cash.accounts.find((a: { code: string }) => a.code === '1120');
    expect(inr).toMatchObject({ currency: 'INR', currencyBalance: '250000.00', balance: '250000.00' });
    expect(t.cash.total).toBe('500500.00');
    const usdRow = t.cash.byCurrency.find((c: { currency: string }) => c.currency === 'USD');
    expect(usdRow).toEqual({ currency: 'USD', accounts: 1, amount: '3000.00', functional: '250500.00', share: '50.0' });
    expect(t.cash.byCurrency[0].currency).toBe('INR');
  });

  it('stays inside the organisation', async () => {
    const t = (await ctx.http().get(`${other.base}/loans/treasury`).set(outsider.auth).expect(200)).body;
    expect(t.cash.total).toBe('0.00');
    expect(t.cash.byCurrency.map((c: { currency: string }) => c.currency)).toEqual(['INR']);
  });
});
