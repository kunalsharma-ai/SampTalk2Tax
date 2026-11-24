import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Country-specific invoice formats (TAX-039) and e-invoicing requirements (TAX-040) against the
 * real API and database: a UK business's invoices checked against the simplified and full VAT
 * invoice rules, put right by adding the VAT number, an address on the template and the customer's
 * address; the VAT number and the tax in sterling printed on the invoice; Germany's e-invoicing
 * dates tested against turnover from the books and a typed figure; a US business told it is not covered.
 */
const T = today();
const Y = Number(T.slice(0, 4));

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let uk: Awaited<ReturnType<typeof createOrg>>;
let de: Awaited<ReturnType<typeof createOrg>>;
const rate: Record<string, string> = {};
const ids: Record<string, string> = {};

type Gap = { key: string; lines?: number[] };
type Row = { id: string; number: string | null; format: string; gaps: Gap[]; totalLocal: string };

const invoice = (o: typeof uk, contactId: string, lines: { description: string; unitPrice: string; taxRateId: string }[], extra: object = {}) =>
  ctx
    .http()
    .post(`${o.base}/sales/documents`)
    .set(owner.auth)
    .send({ kind: 'INVOICE', contactId, issueDate: T, dueDate: T, post: true, ...extra, lines: lines.map((l) => ({ accountId: o.acc['4100'], quantity: '1', ...l })) })
    .expect(201)
    .then((r) => r.body.id as string);
const check = async (o: typeof uk, auth = owner.auth) =>
  (await ctx.http().get(`${o.base}/invoice-requirements/check?from=${T}&to=${T}`).set(auth).expect(200)).body as {
    checked: number;
    complete: number;
    withGaps: number;
    byRequirement: { key: string; count: number }[];
    invoices: Row[];
    templateWarnings: unknown[];
  };

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Invoice Rules Owner');
  viewer = await registerUser(ctx, 'Invoice Rules Viewer');
  uk = await createOrg(ctx, owner, { name: 'Synthetic Invoice Rules Ltd', countryCode: 'GB', functionalCurrency: 'GBP', fiscalYearStartMonth: 4 });
  await ctx.http().post(`${uk.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  await ctx
    .http()
    .post(`${uk.base}/periods/fiscal-years`)
    .set(owner.auth)
    .send({ fiscalYear: fiscalYearForDate(T, 4) });
  await ctx.http().post(`${uk.base}/country-module/starter-rates`).set(owner.auth).send({}).expect(201);
  for (const r of (await ctx.http().get(`${uk.base}/tax-rates`).set(owner.auth).expect(200)).body as { id: string; name: string }[]) rate[r.name] = r.id;
  ids.customer = (await ctx.http().post(`${uk.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Harbour Buyers Ltd', isCustomer: true }).expect(201)).body.id;
});
afterAll(async () => ctx?.app.close());

describe('UK VAT invoice formats', () => {
  it('describes the simplified and full VAT invoice and the 2029 e-invoicing plan', async () => {
    const o = (await ctx.http().get(`${uk.base}/invoice-requirements`).set(viewer.auth).expect(200)).body;
    expect(o).toMatchObject({ country: 'GB', covered: true, seller: { taxNumber: null, address: false } });
    expect(o.format.tiers.map((t: { name: string }) => t.name)).toEqual(['Simplified VAT invoice', 'Full VAT invoice']);
    expect(o.format.source).toMatch(/700\/21/);
    expect(o.eInvoicing).toMatchObject({ status: 'ANNOUNCED', turnover: null, outlook: { verdict: 'WILL_HAVE_TO_ISSUE', nextFrom: '2029-04-01' } });
    expect(o.otherCountries.map((c: { country: string }) => c.country)).toEqual(expect.arrayContaining(['IN', 'DE', 'AE', 'SG']));
  });

  it('finds what each invoice is missing, by size of sale', async () => {
    ids.big = await invoice(uk, ids.customer!, [{ description: 'Synthetic consulting', unitPrice: '1000.00', taxRateId: rate['VAT 20% (standard)']! }]);
    ids.small = await invoice(uk, ids.customer!, [{ description: 'Synthetic parts', unitPrice: '50.00', taxRateId: rate['VAT 20% (standard)']! }]);
    ids.draft = (
      await ctx
        .http()
        .post(`${uk.base}/sales/documents`)
        .set(owner.auth)
        .send({
          kind: 'INVOICE',
          contactId: ids.customer,
          issueDate: T,
          dueDate: T,
          lines: [
            { accountId: uk.acc['4100'], quantity: '2', unitPrice: '400.00', description: 'Synthetic draft work' },
            { accountId: uk.acc['4100'], quantity: '1', unitPrice: '10.00', taxRateId: rate['VAT 20% (standard)'] },
          ],
        })
        .expect(201)
    ).body.id;
    const c = await check(uk, viewer.auth);
    expect(c.checked).toBe(3);
    const row = (id: string) => c.invoices.find((r) => r.id === id)!;
    expect(row(ids.big!)).toMatchObject({ format: 'Full VAT invoice', totalLocal: '1200.00' });
    expect(row(ids.big!).gaps.map((g) => g.key)).toEqual(['SELLER_ADDRESS', 'SELLER_TAX_NUMBER', 'BUYER_ADDRESS']);
    expect(row(ids.small!)).toMatchObject({ format: 'Simplified VAT invoice' });
    expect(row(ids.small!).gaps.map((g) => g.key)).toEqual(['SELLER_ADDRESS', 'SELLER_TAX_NUMBER']);
    const draft = row(ids.draft!);
    expect(draft.number).toBeNull();
    expect(draft.gaps).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'NUMBER' }), expect.objectContaining({ key: 'DESCRIPTIONS', lines: [2] }), expect.objectContaining({ key: 'TAX_RATES', lines: [1] })]),
    );
    expect(c.byRequirement.find((b) => b.key === 'SELLER_TAX_NUMBER')!.count).toBe(3);
    expect(c.withGaps).toBe(3);
  });

  it('is complete once the VAT number, the address on the template and the customer address are added', async () => {
    await ctx.http().put(`${uk.base}/tax/vat/settings`).set(owner.auth).send({ vrn: 'GB 123 4567 82', registeredFrom: T, stagger: 'QUARTERLY_MAR', untaxedTreatment: 'OUTSIDE_SCOPE', treatments: [] });
    const tpl = (await ctx.http().post(`${uk.base}/invoice-templates`).set(owner.auth).send({ name: 'UK VAT', presetId: 'GB_VAT' }).expect(201)).body;
    const full = (await ctx.http().get(`${uk.base}/invoice-templates/${tpl.id}`).set(owner.auth).expect(200)).body;
    full.layout.sections.find((s: { key: string }) => s.key === 'HEADER').text = '1 Synthetic Quay\nBristol BS1 1AA';
    await ctx.http().put(`${uk.base}/invoice-templates/${tpl.id}`).set(owner.auth).send({ name: 'UK VAT', engine: 'LAYOUT', layout: full.layout }).expect(200);
    await ctx.http().patch(`${uk.base}/contacts/${ids.customer}`).set(owner.auth).send({ address: '9 Synthetic Road, Leeds' }).expect(200);
    const o = (await ctx.http().get(`${uk.base}/invoice-requirements`).set(owner.auth).expect(200)).body;
    expect(o.seller).toMatchObject({ taxNumber: 'GB123456782', address: true, defaultTemplate: 'UK VAT' });
    const c = await check(uk);
    expect(c.invoices.find((r) => r.id === ids.big)!.gaps).toEqual([]);
    expect(c.invoices.find((r) => r.id === ids.small)!.gaps).toEqual([]);
    expect(c.complete).toBe(2);
    const one = (await ctx.http().get(`${uk.base}/invoice-requirements/documents/${ids.big}`).set(viewer.auth).expect(200)).body;
    expect(one).toMatchObject({ id: ids.big, format: 'Full VAT invoice', gaps: [], rule: { countryName: 'the United Kingdom' } });
    await ctx.http().get(`${uk.base}/invoice-requirements/documents/${uk.acc['4100']}`).set(owner.auth).expect(404);
  });

  it('prints the VAT number and the VAT in sterling on a dollar invoice', async () => {
    const usd = await invoice(uk, ids.customer!, [{ description: 'Synthetic export service', unitPrice: '500.00', taxRateId: rate['VAT 20% (standard)']! }], { currency: 'USD', exchangeRate: '0.8' });
    const p = (await ctx.http().get(`${uk.base}/invoice-print/${usd}`).set(owner.auth).expect(200)).body;
    expect(p.source.seller.taxId).toBe('GB123456782');
    expect(p.source.localTax).toEqual({ currency: 'GBP', exchangeRate: '0.8', taxTotal: '80.00' });
    const html = (await ctx.http().get(`${uk.base}/invoice-print/${usd}/html`).set(owner.auth).expect(200)).text;
    expect(html).toContain('VAT in GBP at 1 USD = 0.8 GBP');
    const gbp = (await ctx.http().get(`${uk.base}/invoice-print/${ids.big}`).set(owner.auth).expect(200)).body;
    expect(gbp.source.localTax).toBeNull();
  });

  it('rejects a bad turnover and a back-to-front period', async () => {
    await ctx.http().get(`${uk.base}/invoice-requirements?turnover=lots`).set(owner.auth).expect(400);
    await ctx.http().get(`${uk.base}/invoice-requirements/check?from=${T}&to=2000-01-01`).set(owner.auth).expect(422);
  });
});

describe('German e-invoicing dates', () => {
  it('tests the €800,000 threshold against last year in the books, or a typed figure', async () => {
    de = await createOrg(ctx, owner, { name: 'Synthetic Rechnung GmbH', countryCode: 'DE', functionalCurrency: 'EUR', fiscalYearStartMonth: 1 });
    await ctx
      .http()
      .post(`${de.base}/periods/fiscal-years`)
      .set(owner.auth)
      .send({ fiscalYear: Y - 1 });
    await ctx.http().post(`${de.base}/country-module/starter-rates`).set(owner.auth).send({}).expect(201);
    const rates = (await ctx.http().get(`${de.base}/tax-rates`).set(owner.auth).expect(200)).body as { id: string; name: string }[];
    const customer = (await ctx.http().post(`${de.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Kunde AG', isCustomer: true }).expect(201)).body.id;
    const before = (await ctx.http().get(`${de.base}/invoice-requirements`).set(owner.auth).expect(200)).body;
    expect(before.eInvoicing).toMatchObject({ status: 'PHASING_IN', turnover: { basis: 'CALENDAR_YEAR', source: 'NONE', amount: null }, outlook: { mustReceive: true } });
    const d = `${Y - 1}-06-15`;
    await ctx
      .http()
      .post(`${de.base}/sales/documents`)
      .set(owner.auth)
      .send({
        kind: 'INVOICE',
        contactId: customer,
        issueDate: d,
        dueDate: d,
        post: true,
        lines: [{ accountId: de.acc['4100'], quantity: '1', unitPrice: '900000.00', description: 'Synthetic Anlage', taxRateId: rates.find((r) => r.name === 'USt 19% (standard)')!.id }],
      })
      .expect(201);
    const books = (await ctx.http().get(`${de.base}/invoice-requirements`).set(owner.auth).expect(200)).body;
    expect(books.eInvoicing.turnover).toMatchObject({ source: 'BOOKS', amount: '900000.00', usedYear: String(Y - 1) });
    const m2027 = books.eInvoicing.outlook.milestones.find((m: { from: string }) => m.from === '2027-01-01');
    expect(m2027.fit).toBe('APPLIES');
    expect(books.eInvoicing.outlook.verdict).toBe(T < '2027-01-01' ? 'WILL_HAVE_TO_ISSUE' : 'MUST_ISSUE');
    const typed = (await ctx.http().get(`${de.base}/invoice-requirements?turnover=500000`).set(owner.auth).expect(200)).body;
    expect(typed.eInvoicing.turnover).toMatchObject({ source: 'ENTERED', amount: '500000.00' });
    expect(typed.eInvoicing.outlook.milestones.find((m: { from: string }) => m.from === '2027-01-01').fit).toBe('DOES_NOT_APPLY');
  });
});

describe('countries without rules', () => {
  it('says a US business is not covered rather than guess', async () => {
    const us = await createOrg(ctx, owner, { name: 'Synthetic US Rules Inc', countryCode: 'US', functionalCurrency: 'USD', fiscalYearStartMonth: 1 });
    const o = (await ctx.http().get(`${us.base}/invoice-requirements`).set(owner.auth).expect(200)).body;
    expect(o).toMatchObject({ country: 'US', covered: false, format: null, eInvoicing: null });
    const r = (await ctx.http().get(`${us.base}/invoice-requirements/check`).set(owner.auth).expect(422)).body;
    expect(r).toMatchObject({ error: 'NO_INVOICE_RULES', message: expect.stringContaining('the United Kingdom') });
  });
});
