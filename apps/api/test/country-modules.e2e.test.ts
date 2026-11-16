import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/** Country modules and starter tax rates, against the real API and database. */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let uk: Awaited<ReturnType<typeof createOrg>>;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Country Owner');
  viewer = await registerUser(ctx, 'Country Viewer');
  uk = await createOrg(ctx, owner, { name: 'Country UK Ltd', countryCode: 'GB', functionalCurrency: 'GBP', fiscalYearStartMonth: 4 });
  await ctx.http().post(`${uk.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('the catalogue', () => {
  it('lists each country with its level, for anyone signed in', async () => {
    const list = (await ctx.http().get('/v1/country-modules').set(owner.auth).expect(200)).body as { code: string; level: string }[];
    expect(list.find((m) => m.code === 'IN')?.level).toBe('FULL');
    expect(list.find((m) => m.code === 'GB')?.level).toBe('STARTER');
    expect(list.find((m) => m.code === 'US')?.level).toBe('ACCOUNTING_ONLY');
    const gb = (await ctx.http().get('/v1/country-modules/gb').set(owner.auth).expect(200)).body;
    expect(gb.starterRates.map((r: { rate: string }) => r.rate)).toEqual(['20', '5', '0']);
    expect(gb.sources[0].url).toMatch(/^https:\/\/www\.gov\.uk/);
    // A country without a module says so instead of failing.
    expect((await ctx.http().get('/v1/country-modules/FR').set(owner.auth).expect(200)).body.level).toBe('ACCOUNTING_ONLY');
    await ctx.http().get('/v1/country-modules/GBR').set(owner.auth).expect(400);
    await ctx.http().get('/v1/country-modules').expect(401);
  });
});

describe("an organisation's module", () => {
  it('shows which starter rates exist and where they would post', async () => {
    const m = (await ctx.http().get(`${uk.base}/country-module`).set(viewer.auth).expect(200)).body;
    expect(m.countryCode).toBe('GB');
    expect(m.module.level).toBe('STARTER');
    expect(m.starterRates.every((r: { existing: unknown }) => r.existing === null)).toBe(true);
    expect(m.taxAccounts).toEqual({ sales: { code: '2300', name: expect.any(String) }, purchases: { code: '1450', name: expect.any(String) } });
  });

  it('adds starter rates for those who manage accounts, once, keeping rates the organisation made', async () => {
    await ctx.http().post(`${uk.base}/country-module/starter-rates`).set(viewer.auth).send({}).expect(403);
    // The organisation already made its own standard rate under the same name, at another rate.
    await ctx.http().post(`${uk.base}/tax-rates`).set(owner.auth).send({ name: 'VAT 20% (standard)', rate: '17.5', salesAccountId: uk.acc['2300'] }).expect(201);

    const res = (await ctx.http().post(`${uk.base}/country-module/starter-rates`).set(owner.auth).send({}).expect(201)).body;
    expect(res.created.map((c: { name: string }) => c.name)).toEqual(['VAT 5% (reduced)', 'VAT 0% (zero-rated)']);
    expect(res.skipped).toEqual([{ name: 'VAT 20% (standard)', reason: 'A tax rate with this name already exists' }]);

    const rates = (await ctx.http().get(`${uk.base}/tax-rates`).set(owner.auth).expect(200)).body as { name: string; rate: string; salesAccountId: string | null; purchaseAccountId: string | null }[];
    expect(rates.find((r) => r.name === 'VAT 20% (standard)')?.rate).toBe('17.5');
    expect(rates.find((r) => r.name === 'VAT 5% (reduced)')).toMatchObject({ rate: '5', salesAccountId: uk.acc['2300'], purchaseAccountId: uk.acc['1450'] });
    expect(rates.find((r) => r.name === 'VAT 0% (zero-rated)')).toMatchObject({ rate: '0', salesAccountId: null, purchaseAccountId: null });

    const m = (await ctx.http().get(`${uk.base}/country-module`).set(owner.auth).expect(200)).body;
    expect(m.starterRates.find((r: { name: string }) => r.name === 'VAT 20% (standard)').existing).toMatchObject({ rate: '17.5', sameRate: false });

    // Again: nothing more is created.
    const again = (await ctx.http().post(`${uk.base}/country-module/starter-rates`).set(owner.auth).send({}).expect(201)).body;
    expect(again.created).toEqual([]);
    expect(again.skipped).toHaveLength(3);

    const audit = await ctx.prisma.auditEvent.findFirst({ where: { orgId: uk.orgId, action: 'country_module.starter_rates_added' }, orderBy: { createdAt: 'asc' } });
    expect(audit?.data).toMatchObject({ countryCode: 'GB', created: ['VAT 5% (reduced)', 'VAT 0% (zero-rated)'] });
    expect(await ctx.prisma.auditEvent.count({ where: { orgId: uk.orgId, action: 'tax_rate.created' } })).toBe(3);
  });

  it('a chosen rate is used on an invoice like any other', async () => {
    const rates = (await ctx.http().get(`${uk.base}/tax-rates`).set(owner.auth).expect(200)).body as { id: string; name: string }[];
    const reduced = rates.find((r) => r.name === 'VAT 5% (reduced)')!;
    const customer = (await ctx.http().post(`${uk.base}/contacts`).set(owner.auth).send({ name: 'UK Buyer', isCustomer: true }).expect(201)).body;
    const day = today();
    const inv = (await ctx.http().post(`${uk.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: customer.id, issueDate: day, dueDate: day, post: true, lines: [{ accountId: uk.acc['4100'], quantity: '2', unitPrice: '100.00', taxRateId: reduced.id }] }).expect(201)).body;
    expect(inv.total).toBe('210.00');
  });

  it('refuses where the country has its own engine, no starter rates, or no tax accounts', async () => {
    const india = await createOrg(ctx, owner);
    const r1 = await ctx.http().post(`${india.base}/country-module/starter-rates`).set(owner.auth).send({}).expect(409);
    expect(r1.body).toMatchObject({ error: 'NO_STARTER_RATES' });
    expect(r1.body.message).toMatch(/own tax engine/);

    const us = await createOrg(ctx, owner, { name: 'US Inc', countryCode: 'US', functionalCurrency: 'USD', fiscalYearStartMonth: 1 });
    expect((await ctx.http().post(`${us.base}/country-module/starter-rates`).set(owner.auth).send({}).expect(409)).body.message).toMatch(/no starter rates/);

    const empty = await createOrg(ctx, owner, { name: 'Empty AE', countryCode: 'AE', functionalCurrency: 'AED', fiscalYearStartMonth: 1, chartTemplate: 'EMPTY' });
    const r3 = await ctx.http().post(`${empty.base}/country-module/starter-rates`).set(owner.auth).send({}).expect(409);
    expect(r3.body).toMatchObject({ error: 'TAX_ACCOUNT_REQUIRED' });
    expect(await ctx.prisma.taxRate.count({ where: { orgId: empty.orgId } })).toBe(0);
    // Only the zero rate needs no account.
    expect((await ctx.http().post(`${empty.base}/country-module/starter-rates`).set(owner.auth).send({ names: ['VAT 0% (zero-rated)'] }).expect(201)).body.created).toHaveLength(1);
    await ctx.http().post(`${empty.base}/country-module/starter-rates`).set(owner.auth).send({ names: [] }).expect(400);
  });
});
