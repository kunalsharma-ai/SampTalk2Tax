import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Tax audit support (TAX-026) against the real API and database, for the financial year 2026-27:
 * turnover of 1.2 crore with heavy cash spending needs a tax audit; two cash payments to one
 * supplier on one day go over 10,000; a cash receipt of 2.5 lakh breaches section 269ST; TDS on a
 * contractor's bill was deposited late, with interest; and bills split by the supplier's GST.
 */
let ctx: Ctx;
let owner: TestUser;
let employee: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const synthetic = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
type Report = {
  year: string;
  applicability: { required: boolean; limit: string; turnover: string; cashReceipts: string; totalReceipts: string; cashPayments: string; totalPayments: string; cashPaymentsShare: string; reasons: string[] };
  cashPayments: { days: { date: string; contactName: string; amount: string; count: number }[]; disallowed: string };
  cashReceipts: { days: { date: string; contactName: string; amount: string }[]; total: string };
  tds: { configured: boolean; deducted?: string; deposited?: string; late?: number; interest?: string; rows?: { months: number; interest: string; deposited: boolean; section: string }[] };
  expenditure: { total: string; registered: string; unregistered: string };
};

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Audit Owner');
  employee = await registerUser(ctx, 'Audit Employee');
  org = await createOrg(ctx, owner, { name: 'Tax Audit Traders Pvt Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: employee.email, role: 'EMPLOYEE' }).expect(201);
  await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: 2027 });
  for (const a of (await ctx.http().get(`${org.base}/accounts`).set(owner.auth).expect(200)).body as { code: string; id: string }[]) org.acc[a.code] = a.id;
  await ctx.http().put(`${org.base}/withholding/settings`).set(owner.auth).send({ tan: 'PNEZ12345B' }).expect(200);
  const section = (await ctx.http().post(`${org.base}/withholding/sections`).set(owner.auth).send({ template: '393(1)-6(i)' }).expect(201)).body as { id: string };
  const contact = async (body: Record<string, unknown>) => ((await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send(body).expect(201)).body as { id: string }).id;
  const customer = await contact({ name: 'Big Buyer Ltd', isCustomer: true });
  const builder = await contact({ name: 'Sharp Builders', isVendor: true, gstin: synthetic('27', 'ZZZCA0001Z'), withholdingSectionId: section.id });
  const kirana = await contact({ name: 'Local Kirana', isVendor: true });
  const doc = (path: string, body: Record<string, unknown>) => ctx.http().post(`${org.base}/${path}`).set(owner.auth).send({ post: true, ...body }).expect(201);
  await doc('sales/documents', { kind: 'INVOICE', contactId: customer, issueDate: '2026-05-05', dueDate: '2026-05-05', lines: [{ accountId: org.acc['4100'], description: 'Goods', quantity: '1', unitPrice: '12000000.00' }] });
  const bill = (await doc('purchases/documents', { kind: 'BILL', contactId: builder, issueDate: '2026-05-10', dueDate: '2026-06-10', withholdingSectionId: section.id, lines: [{ accountId: org.acc['6600'], description: 'Civil work', quantity: '1', unitPrice: '50000.00' }] })).body as { id: string };
  await doc('purchases/documents', { kind: 'BILL', contactId: kirana, issueDate: '2026-05-12', dueDate: '2026-05-12', lines: [{ accountId: org.acc['6600'], description: 'Supplies', quantity: '1', unitPrice: '20000.00' }] });
  const pay = (path: string, contactId: string, date: string, account: string, amount: string) => ctx.http().post(`${org.base}/${path}`).set(owner.auth).send({ contactId, date, bankAccountId: org.acc[account], amount, allocations: [] }).expect(201);
  await pay('sales/payments', customer, '2026-06-01', '1110', '250000.00');
  await pay('sales/payments', customer, '2026-06-02', '1120', '10000000.00');
  await pay('purchases/payments', kirana, '2026-06-03', '1110', '6000.00');
  await pay('purchases/payments', kirana, '2026-06-03', '1110', '5000.00');
  await pay('purchases/payments', builder, '2026-06-04', '1110', '9000.00');
  await pay('purchases/payments', builder, '2026-06-05', '1120', '100000.00');
  await ctx.http().post(`${org.base}/withholding/deposits`).set(owner.auth).send({ kind: 'TDS', depositDate: '2026-07-15', bankAccountId: org.acc['1120'], challanReference: 'CIN 0510001-15072026-00042', documentIds: [bill.id] }).expect(201);
});
afterAll(async () => ctx?.app.close());

describe('tax audit support', () => {
  it('prepares the Form 3CD working papers for the year', async () => {
    const r = (await ctx.http().get(`${org.base}/tax-audit`).query({ year: '2026-27' }).set(owner.auth).expect(200)).body as Report;
    expect(r.year).toBe('2026-27');
    expect(r.applicability).toMatchObject({ required: true, limit: '10000000', turnover: '12000000.00', cashReceipts: '250000.00', totalReceipts: '10250000.00', cashPayments: '20000.00', totalPayments: '120000.00', cashPaymentsShare: '16.67' });
    expect(r.applicability.reasons[1]).toBe('Cash is more than 5% of payments (16.67%), so the 1 crore limit applies');
    expect(r.cashPayments).toMatchObject({ disallowed: '11000.00', days: [{ date: '2026-06-03', contactName: 'Local Kirana', amount: '11000.00', count: 2 }] });
    expect(r.cashReceipts).toMatchObject({ total: '250000.00', days: [{ date: '2026-06-01', contactName: 'Big Buyer Ltd', amount: '250000.00' }] });
    // 2% of 50,000 deducted on 10 May, due 7 June, deposited 15 July: 3 months or part, 1.5% a month.
    expect(r.tds).toMatchObject({ configured: true, deducted: '1000.00', deposited: '1000.00', late: 1, interest: '45.00' });
    expect(r.tds.rows![0]).toMatchObject({ months: 3, interest: '45.00', deposited: true, section: '393(1)-6(i)' });
    expect(r.expenditure).toEqual({ total: '70000.00', registered: '50000.00', unregistered: '20000.00' });
  });

  it('defaults to the last financial year and checks the year, permission and country', async () => {
    const last = (await ctx.http().get(`${org.base}/tax-audit`).set(owner.auth).expect(200)).body as Report;
    expect(last.year).toMatch(/^\d{4}-\d{2}$/);
    expect(last.applicability.required).toBe(false);
    await ctx.http().get(`${org.base}/tax-audit`).query({ year: '2026-28' }).set(owner.auth).expect(400);
    await ctx.http().get(`${org.base}/tax-audit`).query({ year: '2026' }).set(owner.auth).expect(400);
    expect((await ctx.http().get(`${org.base}/tax-audit`).query({ year: '2099-00' }).set(owner.auth).expect(422)).body.error).toBe('FUTURE_YEAR');
    await ctx.http().get(`${org.base}/tax-audit`).set(employee.auth).expect(403);
    const uk = await createOrg(ctx, owner, { name: 'UK Audit Ltd', countryCode: 'GB', functionalCurrency: 'GBP', fiscalYearStartMonth: 4 });
    expect((await ctx.http().get(`${uk.base}/tax-audit`).set(owner.auth).expect(422)).body.error).toBe('NOT_INDIA');
  });
});
