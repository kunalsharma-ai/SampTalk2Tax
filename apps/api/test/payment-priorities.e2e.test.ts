import { addDays, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Payment prioritisation (AP-030) and early-payment discount offers (AP-029) against the real API
 * and database: open bills ranked against the bank balance less a buffer, urgent ones paid now by
 * score, later ones set aside for their due dates, what the cash cannot cover marked short, bills
 * of a vendor without verified bank details blocked, bills in a batch left alone; discount offers
 * only when everything is covered; validation and tenant isolation.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const v: Record<string, string> = {};
const b: Record<string, string> = {};

type Bill = { id: string; number: string; vendor: string; score: number; action: string; actionLabel: string; daysToDue: number; factors: { key: string; points: number; detail: string }[]; offer: { daysEarly: number; percent: string; discount: string; pay: string } | null };
type Res = { asOf: string; currency: string; rate: string; summary: Record<string, string | number>; bills: Bill[] };
const bill = async (vendor: string, issueAgo: number, dueIn: number, amount: string) =>
  (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: v[vendor], issueDate: addDays(T, -issueAgo), dueDate: addDays(T, dueIn), post: true, lines: [{ accountId: org.acc['6600'], quantity: '1', unitPrice: amount }] }).expect(201)).body.id as string;
const get = (q = '', user = owner) => ctx.http().get(`${org.base}/payment-priorities${q}`).set(user.auth);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Priority Owner');
  outsider = await registerUser(ctx, 'Priority Outsider');
  org = await createOrg(ctx, owner, { name: 'Priority Pay Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Priority Ltd' });
  await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fiscalYearForDate(T, 4) - 1 });
  await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: addDays(T, -90), post: true, memo: 'Capital', lines: [{ accountId: org.acc['1120'], debit: '80000.00' }, { accountId: org.acc['3100'], credit: '80000.00' }] }).expect(201);
  for (const name of ['Oak Metals', 'Pine Paper', 'Elm Freight', 'Ash Unverified']) {
    v[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, isVendor: true }).expect(201)).body.id;
    await ctx.http().put(`/v1/orgs/${org.orgId}/contacts/${v[name]}/bank-details`).set(owner.auth).send({ accountName: name, accountNumber: `5010001${Object.keys(v).length}2345`, ifsc: 'HDFC0001234' }).expect(200);
    // The owner is the only member, so may verify their own entry.
    if (name !== 'Ash Unverified') await ctx.http().post(`/v1/orgs/${org.orgId}/contacts/${v[name]}/bank-details/verify`).set(owner.auth).send({ note: 'Checked against a cancelled cheque' }).expect(200);
  }
  b.oak = await bill('Oak Metals', 70, -40, '30000');
  b.pine = await bill('Pine Paper', 20, 5, '20000');
  b.elm = await bill('Elm Freight', 5, 40, '36500');
  b.ash = await bill('Ash Unverified', 40, -10, '9000');
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('payment priorities', () => {
  it('ranks bills against the cash, with offers when everything is covered', async () => {
    const r = (await get().expect(200)).body as Res;
    expect(r).toMatchObject({ asOf: T, currency: 'INR', rate: '12' });
    const by = Object.fromEntries(r.bills.map((x) => [x.id, x]));
    expect(by[b.oak]).toMatchObject({ action: 'PAY_NOW', actionLabel: 'Pay now', daysToDue: -40 });
    expect(by[b.oak]!.factors[0]).toMatchObject({ key: 'URGENCY', points: 50, detail: '40 days past due' });
    expect(by[b.pine]).toMatchObject({ action: 'PAY_NOW', daysToDue: 5 });
    expect(by[b.ash]).toMatchObject({ action: 'BLOCKED', actionLabel: 'Blocked: bank details not verified' });
    // 80,000 pays 50,000 now; the 30,000 left does not cover 36,500 due later, so it is short and no offers are made.
    expect(by[b.elm]).toMatchObject({ action: 'CASH_SHORT', offer: null });
    expect(r.summary).toMatchObject({ cash: '80000.00', buffer: '0.00', available: '80000.00', payNow: '50000.00', short: '36500.00', blocked: '9000.00', leftOver: '30000.00', offers: 0 });
    expect(r.bills.map((x) => x.action)).toEqual(['PAY_NOW', 'PAY_NOW', 'CASH_SHORT', 'BLOCKED']);
  });

  it('offers early payment for a discount once the cash covers everything, and leaves batched bills alone', async () => {
    await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: T, post: true, memo: 'More capital', lines: [{ accountId: org.acc['1120'], debit: '20000.00' }, { accountId: org.acc['3100'], credit: '20000.00' }] }).expect(201);
    const r = (await get('?rate=10').expect(200)).body as Res;
    const elm = r.bills.find((x) => x.id === b.elm)!;
    // 36,500 × 10% × 40 / 365 = 400.00.
    expect(elm).toMatchObject({ action: 'PAY_ON_DUE', offer: { daysEarly: 40, percent: '1.09', discount: '400.00', pay: '36100.00' } });
    expect(r.summary).toMatchObject({ cash: '100000.00', payNow: '50000.00', onDue: '36500.00', short: '0.00', leftOver: '13500.00', offers: 1, offerSavings: '400.00', offerPay: '36100.00' });
    // A buffer takes cash out of play.
    const tight = (await get('?buffer=20000').expect(200)).body as Res;
    expect(tight.bills.find((x) => x.id === b.elm)!.action).toBe('CASH_SHORT');
    expect(tight.summary).toMatchObject({ buffer: '20000.00', available: '80000.00', offers: 0 });
    // Pine's bill put in a batch is left as it is, and its amount is kept aside.
    await ctx.http().post(`${org.base}/purchases/payment-batches`).set(owner.auth).send({ bankAccountId: org.acc['1120'], paymentDate: T, items: [{ documentId: b.pine }] }).expect(201);
    const batched = (await get().expect(200)).body as Res;
    expect(batched.bills.find((x) => x.id === b.pine)!.action).toBe('IN_BATCH');
    expect(batched.summary).toMatchObject({ inBatches: '20000.00', available: '80000.00', payNow: '30000.00' });
  });

  it('checks the query and keeps to the organisation', async () => {
    await get('?rate=101').expect(400);
    await get('?buffer=-5').expect(400);
    await get('?other=1').expect(400);
    await ctx.http().get(`${org.base}/payment-priorities`).set(outsider.auth).expect(404);
    const theirs = (await ctx.http().get(`${other.base}/payment-priorities`).set(outsider.auth).expect(200)).body as Res;
    expect(theirs).toMatchObject({ bills: [], summary: { payNow: '0.00', offers: 0 } });
  });
});
