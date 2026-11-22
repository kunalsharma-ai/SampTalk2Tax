import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Tax reports (RPT-009) against the real API and database: GST on invoices, a credit note and a
 * bill with TDS, by rate and month, inside a period and not before it; the tax accounts from the
 * ledger; the CSV export kept in the audit trail; validation, permissions and tenants.
 */
const synthetic = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
const T = today();
const monthOf = (iso: string, back: number) => {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - back);
  return d.toISOString().slice(0, 7);
};
const LAST = monthOf(T, 1);
const BEFORE = monthOf(T, 2);
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const c: Record<string, string> = {};
const rate: Record<string, string> = {};
let section: { id: string; code: string };
// TDS on a contractor that is not an individual: 2% of 40,000.
const tds = '800.00';
const R = () => `${org.base}/reports/tax`;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Tax Report Owner');
  viewer = await registerUser(ctx, 'Tax Report Viewer');
  employee = await registerUser(ctx, 'Tax Report Employee');
  outsider = await registerUser(ctx, 'Tax Report Outsider');
  org = await createOrg(ctx, owner, { name: 'Tax Reported Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Tax Reports Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: employee.email, role: 'EMPLOYEE' }).expect(201);
  for (const m of new Set([BEFORE, LAST, T.slice(0, 7)])) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fiscalYearForDate(`${m}-01`, 4) });
  await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: synthetic('29', 'ZZZTR0001Z'), legalName: 'Tax Reported Pvt Ltd', effectiveFrom: `${BEFORE}-01` }).expect(200);
  for (const a of (await ctx.http().get(`${org.base}/accounts`).set(owner.auth).expect(200)).body as { code: string; id: string }[]) org.acc[a.code] = a.id;
  for (const r of ['18', '5']) rate[r] = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: `GST ${r}%`, rate: r, kind: 'GST' }).expect(201)).body.id;
  await ctx.http().put(`${org.base}/withholding/settings`).set(owner.auth).send({ tan: 'PNEZ12345B' }).expect(200);
  section = (await ctx.http().post(`${org.base}/withholding/sections`).set(owner.auth).send({ template: '393(1)-6(i)' }).expect(201)).body;
  const mk = async (k: string, body: Record<string, unknown>) => (c[k] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send(body).expect(201)).body.id);
  await mk('ka', { name: 'Bengaluru Retail', isCustomer: true, gstin: synthetic('29', 'ZZZTR0002Z') });
  await mk('mh', { name: 'Pune Distributors', isCustomer: true, gstin: synthetic('27', 'ZZZTR0003Z') });
  await mk('tn', { name: 'Chennai Builders', isVendor: true, gstin: synthetic('33', 'ZZZTR0004Z'), withholdingSectionId: section.id });
  const doc = (path: string, kind: string, contact: string, date: string, amount: string, account: string, r: string, extra: Record<string, unknown> = {}) =>
    ctx.http().post(`${org.base}/${path}`).set(owner.auth).send({ kind, contactId: c[contact], issueDate: date, dueDate: date, post: true, ...extra, lines: [{ accountId: org.acc[account], description: 'Goods', quantity: '1', unitPrice: amount, taxRateId: rate[r], hsnCode: '8471' }] }).expect(201);
  await doc('sales/documents', 'INVOICE', 'ka', `${BEFORE}-10`, '999.00', '4100', '18'); // before the period
  await doc('sales/documents', 'INVOICE', 'ka', `${LAST}-10`, '100000.00', '4100', '18'); // CGST 9,000 + SGST 9,000
  await doc('sales/documents', 'INVOICE', 'mh', `${T.slice(0, 7)}-01`, '50000.00', '4100', '5'); // IGST 2,500
  await doc('sales/documents', 'CREDIT_NOTE', 'ka', `${T.slice(0, 7)}-01`, '10000.00', '4100', '18'); // less 1,800
  await doc('purchases/documents', 'BILL', 'tn', `${LAST}-12`, '40000.00', '6600', '18', { withholdingSectionId: section.id }); // IGST credit 7,200
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('tax report', () => {
  it('gives output and input tax by rate and month for the period, with TDS and the tax accounts', async () => {
    const r = (await ctx.http().get(R()).query({ from: `${LAST}-01`, to: T }).set(viewer.auth).expect(200)).body;
    expect(r).toMatchObject({ from: `${LAST}-01`, to: T, currency: 'INR', documents: 4 });
    expect(r.totals).toMatchObject({ outputTax: '18700.00', inputTax: '7200.00', net: '11500.00', tcs: '0.00', tds: tds });
    expect(r.byRate.map((x: { rate: string; sales: { taxable: string; tax: string }; purchases: { tax: string }; net: string }) => [x.rate, x.sales.taxable, x.sales.tax, x.purchases.tax, x.net])).toEqual([
      ['5', '50000.00', '2500.00', '0.00', '2500.00'],
      ['18', '90000.00', '16200.00', '7200.00', '9000.00'],
    ]);
    expect(r.totals.sales).toMatchObject({ cgst: '8100.00', sgst: '8100.00', igst: '2500.00' });
    expect(r.totals.purchases).toMatchObject({ igst: '7200.00' });
    expect(r.byMonth).toEqual([
      { month: LAST, outputTax: '18000.00', inputTax: '7200.00', net: '10800.00' },
      { month: T.slice(0, 7), outputTax: '700.00', inputTax: '0.00', net: '700.00' },
    ]);
    expect(r.withholding).toEqual([{ kind: 'TDS', section: section.code, base: '40000.00', amount: tds, documents: 1 }]);
    // The ledger's tax accounts move by the same tax: output tax credited, input credit debited.
    const sub = (s: string, f: 'debit' | 'credit') => r.accounts.filter((a: { subtype: string }) => a.subtype === s).reduce((t: number, a: Record<string, string>) => t + Number(a[f]), 0); // not money: test sum
    expect(sub('TAX_RECEIVABLE', 'debit')).toBe(7200);
    expect(r.accounts.every((a: { opening: string; debit: string; credit: string; closing: string }) => (Number(a.opening) + Number(a.debit) - Number(a.credit)).toFixed(2) === a.closing)).toBe(true);
  });

  it('starts at the beginning of the financial year by default', async () => {
    const r = (await ctx.http().get(R()).set(owner.auth).expect(200)).body;
    expect(r.to).toBe(T);
    expect(r.from).toMatch(/^\d{4}-04-01$/);
    const dated = [`${BEFORE}-10`, `${LAST}-10`, `${LAST}-12`, `${T.slice(0, 7)}-01`, `${T.slice(0, 7)}-01`];
    expect(r.documents).toBe(dated.filter((x) => x >= r.from).length);
  });

  it('exports the report as CSV and keeps the export in the audit trail', async () => {
    const x = (await ctx.http().get(`${R()}/export`).query({ from: `${LAST}-01`, to: T }).set(viewer.auth).expect(200)).body;
    expect(x.fileName).toBe(`tax-report-${LAST}-01-to-${T}.csv`);
    const rows = (x.csv as string).trim().split('\n');
    expect(rows[0]).toBe(`Tax report,${LAST}-01 to ${T},INR`);
    expect(rows).toContain('18,90000.00,16200.00,40000.00,7200.00,9000.00');
    expect(rows).toContain(`TDS,${section.code},40000.00,${tds},1`);
    const events = await ctx.db.collection('audit_events').find({ orgId: org.orgId, action: 'tax_report.exported' }).toArray();
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ from: `${LAST}-01`, to: T, documents: 4, net: '11500.00' });
  });

  it('checks the period, permissions and tenants', async () => {
    await ctx.http().get(R()).query({ from: T, to: `${LAST}-01` }).set(owner.auth).expect(422);
    await ctx.http().get(R()).query({ from: '2020-01-01', to: T }).set(owner.auth).expect(422);
    await ctx.http().get(R()).query({ from: 'yesterday' }).set(owner.auth).expect(400);
    await ctx.http().get(R()).set(employee.auth).expect(403);
    await ctx.http().get(R()).set(outsider.auth).expect(404);
    const theirs = (await ctx.http().get(`${other.base}/reports/tax`).set(outsider.auth).expect(200)).body;
    expect(theirs).toMatchObject({ documents: 0, byRate: [], withholding: [], totals: { net: '0.00' } });
  });
});
