import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * US sales tax (TAX-028) against the real API and database: a US business records its Texas
 * permit with the 8.25% rate it charges, customers carry their state, and the page shows Washington
 * over the economic nexus threshold, California approaching it, tax by state for the month, and the
 * sales that look wrong (no tax in Texas, tax in Florida without a permit, a rate that differs, a
 * customer with no state). Non-US organisations are refused.
 */
const T = today();

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let us: Awaited<ReturnType<typeof createOrg>>;
const rate: Record<string, string> = {};
const c: Record<string, string> = {};
const inv = (contactId: string, unitPrice: string, taxRateId?: string) =>
  ctx
    .http()
    .post(`${us.base}/sales/documents`)
    .set(owner.auth)
    .send({
      kind: 'INVOICE',
      contactId,
      issueDate: T,
      dueDate: T,
      post: true,
      lines: [{ accountId: us.acc['4100'], description: 'Synthetic widget', quantity: '1', unitPrice, ...(taxRateId ? { taxRateId } : {}) }],
    })
    .then((r) => {
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body as { id: string; number: string };
    });

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'US Sales Tax Owner');
  viewer = await registerUser(ctx, 'US Sales Tax Viewer');
  us = await createOrg(ctx, owner, { name: 'Synthetic Widgets Inc', countryCode: 'US', functionalCurrency: 'USD', fiscalYearStartMonth: 1 });
  await ctx.http().post(`${us.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  await ctx
    .http()
    .post(`${us.base}/periods/fiscal-years`)
    .set(owner.auth)
    .send({ fiscalYear: fiscalYearForDate(T, 1) });
  for (const [name, r] of [
    ['Texas 8.25%', '8.25'],
    ['Florida 7%', '7'],
  ])
    rate[name] = (await ctx.http().post(`${us.base}/tax-rates`).set(owner.auth).send({ name, rate: r, salesAccountId: us.acc['2300'], purchaseAccountId: us.acc['1450'] }).expect(201)).body.id;
  for (const [k, region] of [
    ['tx', 'TX'],
    ['wa', 'WA'],
    ['ca', 'CA'],
    ['fl', 'FL'],
    ['none', null],
  ] as const)
    c[k] = (
      await ctx
        .http()
        .post(`${us.base}/contacts`)
        .set(owner.auth)
        .send({ name: `Synthetic ${k.toUpperCase()} Buyer`, isCustomer: true, countryCode: 'US', regionCode: region })
        .expect(201)
    ).body.id;
});
afterAll(async () => ctx?.app.close());

describe('US sales tax', () => {
  it('records a state permit with the rate charged there', async () => {
    const empty = (await ctx.http().get(`${us.base}/tax/us-sales-tax`).set(viewer.auth).expect(200)).body;
    expect(empty).toMatchObject({ registrations: [], nexus: [], states: [], customersWithoutState: 1 });
    expect(empty.stateList).toHaveLength(51);
    await ctx.http().put(`${us.base}/tax/us-sales-tax/registrations/TX`).set(viewer.auth).send({ registeredFrom: T, filingFrequency: 'MONTHLY' }).expect(403);
    expect((await ctx.http().put(`${us.base}/tax/us-sales-tax/registrations/OR`).set(owner.auth).send({ registeredFrom: T, filingFrequency: 'MONTHLY' }).expect(422)).body.message).toBe(
      'Oregon has no statewide sales tax',
    );
    const r = (
      await ctx
        .http()
        .put(`${us.base}/tax/us-sales-tax/registrations/tx`)
        .set(owner.auth)
        .send({ registeredFrom: T, permitNumber: '32000000000', taxRateId: rate['Texas 8.25%'], filingFrequency: 'MONTHLY' })
        .expect(200)
    ).body;
    expect(r.registrations).toEqual([expect.objectContaining({ state: 'TX', name: 'Texas', permitNumber: '32000000000', taxRate: { name: 'Texas 8.25%', rate: '8.25' } })]);
  });

  it('tracks nexus and reports tax by state with what looks wrong', async () => {
    await inv(c.tx!, '1000.00', rate['Texas 8.25%']);
    const untaxed = await inv(c.tx!, '500.00');
    await inv(c.wa!, '120000.00');
    await inv(c.ca!, '420000.00');
    const fl = await inv(c.fl!, '200.00', rate['Florida 7%']);
    const none = await inv(c.none!, '50.00');
    const o = (await ctx.http().get(`${us.base}/tax/us-sales-tax?from=${T}&to=${T}`).set(viewer.auth).expect(200)).body;
    const nexus = Object.fromEntries(o.nexus.map((n: { state: string; status: string }) => [n.state, n.status]));
    expect(nexus).toMatchObject({ WA: 'MUST_REGISTER', CA: 'APPROACHING', TX: 'REGISTERED', FL: 'BELOW' });
    expect(o.states.find((s: { state: string }) => s.state === 'TX')).toMatchObject({ registered: true, gross: '1500.00', taxable: '1000.00', nonTaxable: '500.00', tax: '82.50', documents: 2 });
    expect(o.totalTax).toBe('96.50');
    const issues = o.issues.map((i: { kind: string; documentId: string }) => `${i.kind}:${i.documentId}`);
    expect(issues).toEqual(expect.arrayContaining([`NO_TAX_IN_REGISTERED_STATE:${untaxed.id}`, `TAX_IN_UNREGISTERED_STATE:${fl.id}`, `STATE_MISSING:${none.id}`]));
    await ctx.http().patch(`${us.base}/contacts/${c.none}`).set(owner.auth).send({ regionCode: 'tx' }).expect(200);
    const after = (await ctx.http().get(`${us.base}/tax/us-sales-tax?from=${T}&to=${T}`).set(owner.auth).expect(200)).body;
    expect(after.customersWithoutState).toBe(0);
    expect(after.issues.map((i: { kind: string; documentId: string }) => `${i.kind}:${i.documentId}`)).toContain(`NO_TAX_IN_REGISTERED_STATE:${none.id}`);
  });

  it('removes a registration, and refuses other countries and bad codes', async () => {
    const r = (await ctx.http().delete(`${us.base}/tax/us-sales-tax/registrations/TX`).set(owner.auth).expect(200)).body;
    expect(r.registrations).toEqual([]);
    await ctx.http().delete(`${us.base}/tax/us-sales-tax/registrations/TX`).set(owner.auth).expect(404);
    await ctx.http().put(`${us.base}/tax/us-sales-tax/registrations/ZZ`).set(owner.auth).send({ registeredFrom: T, filingFrequency: 'MONTHLY' }).expect(422);
    await ctx.http().post(`${us.base}/contacts`).set(owner.auth).send({ name: 'Bad Region', isCustomer: true, regionCode: 'TEXAS' }).expect(400);
    const gb = await createOrg(ctx, owner, { name: 'Synthetic UK Ltd', countryCode: 'GB', functionalCurrency: 'GBP', fiscalYearStartMonth: 4 });
    expect((await ctx.http().get(`${gb.base}/tax/us-sales-tax`).set(owner.auth).expect(422)).body.error).toBe('NOT_US');
  });
});
