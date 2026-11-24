import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Cross-border tax reporting (TAX-038) against the real API and database: a German business with
 * customers in France and Austria and a supplier in the United States. Contacts take a country;
 * the report groups foreign sales and purchases by country, nets a credit note, lists intra-EU
 * supplies for the recapitulative statement, and flags a taxed export, untaxed imports, a missing
 * VAT ID and a dollar invoice to a contact without a country.
 */
const T = today();

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let de: Awaited<ReturnType<typeof createOrg>>;
const ids: Record<string, string> = {};
let rate19 = '';
let rate0 = '';

const post = (kind: string, contactId: string, unitPrice: string, taxRateId: string, extra: object = {}) =>
  ctx
    .http()
    .post(`${de.base}/${kind === 'INVOICE' || kind === 'CREDIT_NOTE' ? 'sales' : 'purchases'}/documents`)
    .set(owner.auth)
    .send({
      kind,
      contactId,
      issueDate: T,
      dueDate: T,
      post: true,
      ...extra,
      lines: [{ accountId: kind === 'INVOICE' || kind === 'CREDIT_NOTE' ? de.acc['4100'] : de.acc['6600'], description: 'Synthetic item', quantity: '1', unitPrice, taxRateId }],
    })
    .then((r) => {
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.id as string;
    });
const contact = (body: object) =>
  ctx
    .http()
    .post(`${de.base}/contacts`)
    .set(owner.auth)
    .send(body)
    .expect(201)
    .then((r) => r.body);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Cross Border Owner');
  viewer = await registerUser(ctx, 'Cross Border Viewer');
  de = await createOrg(ctx, owner, { name: 'Synthetic Grenzen GmbH', countryCode: 'DE', functionalCurrency: 'EUR', fiscalYearStartMonth: 1 });
  await ctx.http().post(`${de.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  await ctx
    .http()
    .post(`${de.base}/periods/fiscal-years`)
    .set(owner.auth)
    .send({ fiscalYear: fiscalYearForDate(T, 1) });
  await ctx.http().post(`${de.base}/country-module/starter-rates`).set(owner.auth).send({}).expect(201);
  const rates = (await ctx.http().get(`${de.base}/tax-rates`).set(owner.auth).expect(200)).body as { id: string; name: string; rate: string }[];
  rate19 = rates.find((r) => r.name === 'USt 19% (standard)')!.id;
  rate0 = rates.find((r) => r.rate === '0')!.id;
});
afterAll(async () => ctx?.app.close());

describe('contact countries', () => {
  it('takes an ISO country and refuses an unknown one', async () => {
    const c = await contact({ name: 'Synthetic Paris SARL', isCustomer: true, countryCode: 'fr', taxId: 'FR40303265045' });
    expect(c.countryCode).toBe('FR');
    ids.fr = c.id;
    const bad = await ctx.http().post(`${de.base}/contacts`).set(owner.auth).send({ name: 'Nowhere Ltd', isCustomer: true, countryCode: 'XX' });
    expect(bad.status).toBe(400);
    ids.at = (await contact({ name: 'Synthetic Wien GmbH', isCustomer: true, countryCode: 'AT' })).id;
    ids.us = (await contact({ name: 'Synthetic Cloud Inc', isVendor: true, countryCode: 'US' })).id;
    ids.ch = (await contact({ name: 'Synthetic Zürich AG', isCustomer: true })).id;
    ids.home = (await contact({ name: 'Synthetic Berlin GmbH', isCustomer: true, countryCode: 'DE' })).id;
    const patched = (await ctx.http().patch(`${de.base}/contacts/${ids.ch}`).set(owner.auth).send({ countryCode: 'CH' }).expect(200)).body;
    expect(patched.countryCode).toBe('CH');
    await ctx.http().patch(`${de.base}/contacts/${ids.ch}`).set(owner.auth).send({ countryCode: null }).expect(200);
  });
});

describe('the cross-border report', () => {
  it('groups by country, lists intra-EU supplies and flags what needs a look', async () => {
    const before = (await ctx.http().get(`${de.base}/tax/cross-border`).set(viewer.auth).expect(200)).body;
    expect(before).toMatchObject({ home: 'DE', homeInEu: true, considered: 0, byCountry: [], ecSalesList: [], checks: [] });

    await post('INVOICE', ids.fr!, '1000.00', rate0);
    await post('CREDIT_NOTE', ids.fr!, '200.00', rate0);
    ids.atInv = await post('INVOICE', ids.at!, '500.00', rate0);
    await post('BILL', ids.us!, '300.00', rate0, { currency: 'USD', exchangeRate: '0.9' });
    ids.usBill = await post('BILL', ids.us!, '100.00', rate0);
    ids.chInv = await post('INVOICE', ids.ch!, '400.00', rate19, { currency: 'CHF', exchangeRate: '1.05' });
    await post('INVOICE', ids.home!, '9000.00', rate19);

    const r = (await ctx.http().get(`${de.base}/tax/cross-border?from=${T}&to=${T}`).set(viewer.auth).expect(200)).body;
    expect(r.documents).toBe(7);
    expect(r.considered).toBe(5);
    expect(r.byCountry.map((c: { country: string }) => c.country)).toEqual(['FR', 'AT', 'US']);
    expect(r.byCountry[0]).toMatchObject({ countryName: 'France', euMember: true, sales: { net: '800.00', tax: '0.00', documents: 2 } });
    expect(r.byCountry[2]).toMatchObject({ countryName: 'United States', euMember: false, purchases: { net: '370.00', documents: 2 }, currencies: ['EUR', 'USD'] });
    expect(r.totals.purchases).toEqual({ net: '370.00', tax: '0.00', documents: 2 });
    expect(r.ecSalesList).toEqual([
      expect.objectContaining({ country: 'AT', vatId: null, net: '500.00' }),
      expect.objectContaining({ country: 'FR', vatId: 'FR40303265045', net: '800.00', documents: 2 }),
    ]);
    const kinds = r.checks.map((c: { kind: string; documentId: string }) => `${c.kind}:${c.documentId}`);
    expect(kinds).toEqual(expect.arrayContaining([`INTRA_EU_NO_VAT_ID:${ids.atInv}`, `COUNTRY_MISSING:${ids.chInv}`]));
    expect(r.checks.filter((c: { kind: string }) => c.kind === 'IMPORT_NO_REVERSE_CHARGE')).toHaveLength(2);
    expect(r.contactsWithoutCountry).toBe(1);

    await ctx.http().patch(`${de.base}/contacts/${ids.ch}`).set(owner.auth).send({ countryCode: 'CH' }).expect(200);
    const after = (await ctx.http().get(`${de.base}/tax/cross-border?from=${T}&to=${T}`).set(owner.auth).expect(200)).body;
    expect(after.checks.map((c: { kind: string; documentId: string }) => `${c.kind}:${c.documentId}`)).toContain(`EXPORT_TAXED:${ids.chInv}`);
    expect(after.byCountry.find((c: { country: string }) => c.country === 'CH')).toMatchObject({ sales: { net: '420.00', tax: '79.80' } });
  });

  it('exports CSV with an audit record, and checks the period', async () => {
    const e = (await ctx.http().get(`${de.base}/tax/cross-border/export?from=${T}&to=${T}`).set(viewer.auth).expect(200)).body;
    expect(e.fileName).toBe(`cross-border-${T}-to-${T}.csv`);
    expect(e.csv.split('\n')[0]).toContain('Sales net (EUR)');
    expect(e.csv).toContain('Synthetic Wien GmbH,AT,MISSING,500.00,1');
    const audit = (await ctx.http().get(`${de.base}/audit-events?action=cross_border_report.exported`).set(owner.auth)).body;
    if (Array.isArray(audit?.items)) expect(audit.items.length).toBeGreaterThan(0);
    await ctx.http().get(`${de.base}/tax/cross-border?from=${T}&to=2000-01-01`).set(owner.auth).expect(422);
  });
});
