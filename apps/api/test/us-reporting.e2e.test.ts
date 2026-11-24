import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * US federal and state reporting (TAX-029) against the real API and database: a US business pays
 * its vendors from the bank, records what their W-9s say, and sees which 1099s it must file for the
 * year (a contractor, a corporate law firm, a landlord), who still owes a W-9, who is a corporation
 * or below the threshold, a voided payment left out, the CSV export audited without any taxpayer
 * digits, and its Texas quarterly sales tax returns with the tax charged in each quarter.
 */
const T = today();
const YEAR = Number(T.slice(0, 4));

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let us: Awaited<ReturnType<typeof createOrg>>;
const v: Record<string, string> = {};
const pay = (contactId: string, amount: string) =>
  ctx
    .http()
    .post(`${us.base}/purchases/payments`)
    .set(owner.auth)
    .send({ contactId, date: T, bankAccountId: us.acc['1120'], amount, reference: `SYN-${amount}` })
    .then((r) => {
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body as { id: string };
    });

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'US Reporting Owner');
  viewer = await registerUser(ctx, 'US Reporting Viewer');
  us = await createOrg(ctx, owner, { name: 'Synthetic Gadgets Inc', countryCode: 'US', functionalCurrency: 'USD', fiscalYearStartMonth: 1 });
  await ctx.http().post(`${us.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  await ctx
    .http()
    .post(`${us.base}/periods/fiscal-years`)
    .set(owner.auth)
    .send({ fiscalYear: fiscalYearForDate(T, 1) });
  for (const k of ['Contractor', 'Law Firm', 'Landlord', 'Designer', 'Supply Corp', 'Tiny Helper'])
    v[k] = (
      await ctx
        .http()
        .post(`${us.base}/contacts`)
        .set(owner.auth)
        .send({ name: `Synthetic ${k}`, isVendor: true, countryCode: 'US' })
        .expect(201)
    ).body.id;
  v.customer = (await ctx.http().post(`${us.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Texas Buyer', isCustomer: true, countryCode: 'US', regionCode: 'TX' }).expect(201)).body.id;
});
afterAll(async () => ctx?.app.close());

describe('US 1099 reporting', () => {
  it('records W-9 details with only the last four digits', async () => {
    const body = { classification: 'INDIVIDUAL', tinType: 'SSN', tinLast4: '4321', w9ReceivedOn: T, formKind: 'NEC' };
    await ctx.http().put(`${us.base}/tax/us-reporting/vendors/${v.Contractor}`).set(viewer.auth).send(body).expect(403);
    expect(
      (
        await ctx
          .http()
          .put(`${us.base}/tax/us-reporting/vendors/${v.Contractor}`)
          .set(owner.auth)
          .send({ ...body, tinLast4: '123-45-4321' })
          .expect(400)
      ).text,
    ).toContain('last four digits');
    await ctx.http().put(`${us.base}/tax/us-reporting/vendors/${v.customer}`).set(owner.auth).send(body).expect(422);
    await ctx.http().put(`${us.base}/tax/us-reporting/vendors/${v.Contractor}`).set(owner.auth).send(body).expect(200);
    await ctx
      .http()
      .put(`${us.base}/tax/us-reporting/vendors/${v['Law Firm']}`)
      .set(owner.auth)
      .send({ ...body, classification: 'C_CORPORATION', tinType: 'EIN', tinLast4: '7788', isAttorney: true })
      .expect(200);
    await ctx
      .http()
      .put(`${us.base}/tax/us-reporting/vendors/${v.Landlord}`)
      .set(owner.auth)
      .send({ ...body, tinLast4: '1111', formKind: 'MISC_RENT' })
      .expect(200);
    const o = (
      await ctx
        .http()
        .put(`${us.base}/tax/us-reporting/vendors/${v['Supply Corp']}`)
        .set(owner.auth)
        .send({ ...body, classification: 'LLC_C', tinType: 'EIN', tinLast4: '9900' })
        .expect(200)
    ).body;
    expect(o.vendors.find((x: { contactId: string }) => x.contactId === v.Landlord).profile).toEqual({
      classification: 'INDIVIDUAL',
      tinType: 'SSN',
      tinLast4: '1111',
      w9ReceivedOn: T,
      formKind: 'MISC_RENT',
      isAttorney: false,
    });
    const audit = await ctx.db
      .collection('audit_events')
      .find({ orgId: us.orgId, action: { $regex: '^us_vendor_tax_profile' } })
      .toArray();
    expect(audit).toHaveLength(4);
    expect(JSON.stringify(audit)).not.toContain('4321');
  });

  it('works out the 1099s due for the year', async () => {
    await pay(v.Contractor!, '1500.00');
    await pay(v.Contractor!, '900.00');
    const voided = await pay(v.Contractor!, '5000.00');
    await ctx.http().post(`${us.base}/purchases/payments/${voided.id}/void`).set(owner.auth).send({ reason: 'Sent twice' }).expect(200);
    await pay(v['Law Firm']!, '3000.00');
    await pay(v.Landlord!, '12000.00');
    await pay(v.Designer!, '2500.00');
    await pay(v['Supply Corp']!, '8000.00');
    await pay(v['Tiny Helper']!, '300.00');
    const o = (await ctx.http().get(`${us.base}/tax/us-reporting?year=${YEAR}`).set(viewer.auth).expect(200)).body;
    expect(o.federal.threshold).toBe(YEAR >= 2026 ? '2000' : '600');
    const by = Object.fromEntries(o.federal.rows.map((r: { name: string }) => [r.name.replace('Synthetic ', ''), r]));
    expect(by.Contractor).toMatchObject({ status: 'REPORTABLE', form: 'NEC', box: '1', reportable: '2400.00', payments: 2, tinLast4: '4321' });
    expect(by['Law Firm']).toMatchObject({ status: 'REPORTABLE', form: 'NEC', reportable: '3000.00' });
    expect(by.Landlord).toMatchObject({ status: 'REPORTABLE', form: 'MISC', box: '1', reportable: '12000.00' });
    expect(by.Designer).toMatchObject({ status: 'NEEDS_W9', form: null });
    expect(by['Supply Corp'].status).toBe('CORPORATION');
    expect(by['Tiny Helper'].status).toBe('BELOW_THRESHOLD');
    expect(o.federal.summary).toMatchObject({ nec: 2, misc: 1, needsW9: 1, reportableTotal: '19900.00', mustEfile: false });
    expect(o.federal.dueDates.necRecipientAndIrs.slice(0, 4)).toBe(String(YEAR + 1));
    const last = (
      await ctx
        .http()
        .get(`${us.base}/tax/us-reporting?year=${YEAR - 1}`)
        .set(owner.auth)
        .expect(200)
    ).body;
    expect(last.federal.rows).toEqual([]);
  });

  it('exports the 1099 rows as CSV and audits the export', async () => {
    const r = (await ctx.http().get(`${us.base}/tax/us-reporting/1099/export?year=${YEAR}`).set(viewer.auth).expect(200)).body;
    expect(r.fileName).toBe(`us-1099-${YEAR}.csv`);
    expect(r.csv).toContain('Synthetic Contractor,File a 1099,1099-NEC,1,2400.00,0.00,SSN,4321');
    expect(r.csv).toContain('Synthetic Designer,Get a W-9,,,2500.00');
    const ev = await ctx.db.collection('audit_events').findOne({ orgId: us.orgId, action: 'us_1099_report.exported' });
    expect(ev?.data).toMatchObject({ year: YEAR, nec: 2, misc: 1 });
  });

  it('lists the state sales tax returns for the year with tax per period', async () => {
    const rate = (
      await ctx.http().post(`${us.base}/tax-rates`).set(owner.auth).send({ name: 'Texas 8.25%', rate: '8.25', salesAccountId: us.acc['2300'], purchaseAccountId: us.acc['1450'] }).expect(201)
    ).body.id;
    await ctx
      .http()
      .put(`${us.base}/tax/us-sales-tax/registrations/TX`)
      .set(owner.auth)
      .send({ registeredFrom: `${YEAR}-01-01`, taxRateId: rate, filingFrequency: 'QUARTERLY' })
      .expect(200);
    await ctx
      .http()
      .post(`${us.base}/sales/documents`)
      .set(owner.auth)
      .send({
        kind: 'INVOICE',
        contactId: v.customer,
        issueDate: T,
        dueDate: T,
        post: true,
        lines: [{ accountId: us.acc['4100'], description: 'Synthetic gadget', quantity: '1', unitPrice: '2000.00', taxRateId: rate }],
      })
      .expect(201);
    const o = (await ctx.http().get(`${us.base}/tax/us-reporting?year=${YEAR}`).set(owner.auth).expect(200)).body;
    expect(o.state.periods.map((p: { label: string }) => p.label)).toEqual([1, 2, 3, 4].map((q) => `Q${q} ${YEAR}`));
    const current = o.state.periods.find((p: { timing: string }) => p.timing === 'CURRENT');
    expect(current).toMatchObject({ state: 'TX', stateName: 'Texas', netSales: '2000.00', tax: '165.00', invoices: 1 });
    expect(o.state.taxTotal).toBe('165.00');
  });

  it('removes W-9 details and refuses organisations outside the US', async () => {
    await ctx.http().delete(`${us.base}/tax/us-reporting/vendors/${v.Landlord}`).set(owner.auth).expect(200);
    await ctx.http().delete(`${us.base}/tax/us-reporting/vendors/${v.Landlord}`).set(owner.auth).expect(404);
    const o = (await ctx.http().get(`${us.base}/tax/us-reporting?year=${YEAR}`).set(owner.auth).expect(200)).body;
    expect(o.federal.rows.find((r: { contactId: string }) => r.contactId === v.Landlord).status).toBe('NEEDS_W9');
    const gb = await createOrg(ctx, owner, { name: 'Synthetic UK Ltd', countryCode: 'GB', functionalCurrency: 'GBP', fiscalYearStartMonth: 4 });
    expect((await ctx.http().get(`${gb.base}/tax/us-reporting`).set(owner.auth).expect(422)).body.error).toBe('NOT_US');
  });
});
