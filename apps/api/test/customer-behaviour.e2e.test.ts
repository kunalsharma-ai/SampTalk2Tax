import { addDays, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Customer financial behaviour analysis (AR-038) against the real API and database: a customer
 * paying slower than six months before, one buying more, one paying in parts and one who has
 * stopped buying, each with the profile and signals the books support; filtering to one customer,
 * the reports permission and tenant isolation.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const c: Record<string, string> = {};

const invoice = async (who: string, ago: number, amount = '1000.00') => {
  const issueDate = addDays(T, -ago);
  const r = await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: c[who], issueDate, dueDate: addDays(issueDate, 30), post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.id as string, dueDate: addDays(issueDate, 30) };
};
const receipt = (who: string, date: string, documentId: string, amount = '1000.00') =>
  ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: c[who], date, bankAccountId: org.acc['1120'], amount, allocations: [{ documentId, amount }] }).expect(201);
/** An invoice issued `ago` days before today, due 30 days later, paid `late` days after its due date. */
const paid = async (who: string, ago: number, late: number) => {
  const i = await invoice(who, ago);
  await receipt(who, addDays(i.dueDate, late), i.id);
};
type Row = { contactId: string; name: string; profile: string; profileLabel: string; paying: Record<string, unknown>; buying: Record<string, unknown>; signals: { code: string; tone: string; detail: string }[] };
type Res = { asOf: string; summary: { customers: number; profiles: Record<string, number>; signals: Record<string, number> }; customers: Row[] };

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Habit Owner');
  viewer = await registerUser(ctx, 'Habit Viewer');
  outsider = await registerUser(ctx, 'Habit Outsider');
  org = await createOrg(ctx, owner, { name: 'Habit Traders Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Habit Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  const fy = fiscalYearForDate(T, 4);
  await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy - 1 });
  await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy - 2 });
  for (const name of ['Slowpay Stores', 'Growing Goods', 'Parts Pvt', 'Gone Quiet Co']) c[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, isCustomer: true }).expect(201)).body.id;
  // Slowpay: two days late until six months ago, twenty days late since; a new invoice still open.
  for (const ago of [330, 300, 270, 240]) await paid('Slowpay Stores', ago, 2);
  for (const ago of [150, 120, 90]) await paid('Slowpay Stores', ago, 20);
  await invoice('Slowpay Stores', 20);
  // Growing: two invoices in the year before, four in the last year, all paid on the due date.
  for (const ago of [500, 450, 300, 240, 180, 120]) await paid('Growing Goods', ago, 0);
  // Parts: every invoice paid in two halves, on time; the latest still open.
  for (const ago of [330, 270, 200, 150]) {
    const i = await invoice('Parts Pvt', ago);
    await receipt('Parts Pvt', addDays(i.dueDate, -5), i.id, '500.00');
    await receipt('Parts Pvt', i.dueDate, i.id, '500.00');
  }
  await invoice('Parts Pvt', 40);
  // Gone quiet: an invoice a month, then nothing for 280 days.
  for (const ago of [400, 370, 340, 310, 280]) await paid('Gone Quiet Co', ago, 0);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('customer behaviour', () => {
  it('profiles each customer and raises the signals the books support', async () => {
    const r = (await ctx.http().get(`${org.base}/customer-behaviour`).set(viewer.auth).expect(200)).body as Res;
    expect(r.asOf).toBe(T);
    const by = Object.fromEntries(r.customers.map((x) => [x.name, x]));
    const codes = (n: string) => by[n]!.signals.map((s) => s.code);

    expect(by['Slowpay Stores']).toMatchObject({ profile: 'SLOW', profileLabel: 'Pays late, steadily', paying: { paidInvoices: 7, daysLateRecent: 20, daysLatePrior: 2, trend: 'SLOWER' } });
    expect(codes('Slowpay Stores')).toContain('PAYING_SLOWER');
    expect(by['Slowpay Stores']!.signals.find((s) => s.code === 'PAYING_SLOWER')!.detail).toBe('Paying 18 days later than six months before: 20 days late on average, was 2');

    expect(by['Growing Goods']).toMatchObject({ profile: 'PROMPT', buying: { last12: { invoices: 4, amount: '4000.00' }, prior12: { invoices: 2, amount: '2000.00' }, change: 100, trend: 'GROWING' } });
    expect(codes('Growing Goods')).toContain('BUYING_MORE');

    expect(by['Parts Pvt']).toMatchObject({ profile: 'PROMPT', paying: { paidInvoices: 4, partialShare: 100 } });
    expect(codes('Parts Pvt')).toContain('PARTIAL_PAYER');

    expect(by['Gone Quiet Co']).toMatchObject({ buying: { trend: 'LAPSED', daysSinceLast: 280, averageGap: 30 } });
    expect(by['Gone Quiet Co']!.signals[0]).toMatchObject({ code: 'LAPSED', tone: 'RISK', detail: 'No invoice for 280 days; usually one every 30 days' });

    // Customers with a risk signal come first.
    expect(r.customers.slice(0, 2).map((x) => x.name).sort()).toEqual(['Gone Quiet Co', 'Slowpay Stores']);
    expect(r.summary).toMatchObject({ customers: 4, signals: { PAYING_SLOWER: 1, LAPSED: 1, PARTIAL_PAYER: 1, BUYING_MORE: 1 }, profiles: { SLOW: 1 } });
  });

  it('filters to one customer and checks the query', async () => {
    const one = (await ctx.http().get(`${org.base}/customer-behaviour?contactId=${c['Parts Pvt']}`).set(owner.auth).expect(200)).body as Res;
    expect(one.customers.map((x) => x.name)).toEqual(['Parts Pvt']);
    await ctx.http().get(`${org.base}/customer-behaviour?contactId=nope`).set(owner.auth).expect(400);
    await ctx.http().get(`${org.base}/customer-behaviour?segment=x`).set(owner.auth).expect(400);
  });

  it('keeps organisations apart', async () => {
    await ctx.http().get(`${org.base}/customer-behaviour`).set(outsider.auth).expect(404);
    const theirs = (await ctx.http().get(`${other.base}/customer-behaviour`).set(outsider.auth).expect(200)).body as Res;
    expect(theirs).toMatchObject({ customers: [], summary: { customers: 0 } });
    const leaked = (await ctx.http().get(`${other.base}/customer-behaviour?contactId=${c['Parts Pvt']}`).set(outsider.auth).expect(200)).body as Res;
    expect(leaked.customers).toEqual([]);
  });
});
