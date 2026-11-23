import { addDays, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * UK VAT return (TAX-030) against the real API and database: the registration and rate
 * treatments, the nine boxes from invoices, credit notes, bills and an expense claim, other
 * entries on the VAT accounts, recording a submission, a back-dated invoice carried to the next
 * return as a correction, a void taken off in the period it happens, and refusals.
 */
const T = today();
const monthEnd = (ym: string) => lastDay(ym);
function lastDay(ym: string) {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}
const shiftMonth = (ym: string, by: number) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + m - 1 + by;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const NOW = T.slice(0, 7);
const M1 = shiftMonth(NOW, -2);
const M2 = shiftMonth(NOW, -1);
const E1 = monthEnd(M1);
const E2 = monthEnd(M2);
const E3 = monthEnd(NOW);

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let employee: TestUser;
let approver: TestUser;
let uk: Awaited<ReturnType<typeof createOrg>>;
const rate: Record<string, string> = {};
const ids: Record<string, string> = {};

const doc = (side: 'sales' | 'purchases', kind: string, contactId: string, date: string, lines: [string, string, string | null][]) =>
  ctx
    .http()
    .post(`${uk.base}/${side}/documents`)
    .set(owner.auth)
    .send({ kind, contactId, issueDate: date, dueDate: date, post: true, lines: lines.map(([description, unitPrice, taxRateId]) => ({ accountId: side === 'sales' ? uk.acc['4100'] : uk.acc['6600'], description, quantity: '1', unitPrice, taxRateId })) })
    .expect(201)
    .then((r) => r.body.id as string);
const vat = (end: string, auth = owner.auth) => ctx.http().get(`${uk.base}/tax/vat/return?periodEnd=${end}`).set(auth);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'VAT Owner');
  viewer = await registerUser(ctx, 'VAT Viewer');
  employee = await registerUser(ctx, 'VAT Employee');
  approver = await registerUser(ctx, 'VAT Approver');
  uk = await createOrg(ctx, owner, { name: 'Synthetic VAT Traders Ltd', countryCode: 'GB', functionalCurrency: 'GBP', fiscalYearStartMonth: 4 });
  for (const [u, role] of [[viewer, 'VIEWER'], [employee, 'EMPLOYEE'], [approver, 'APPROVER']] as const) await ctx.http().post(`${uk.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  for (const fy of new Set([`${M1}-01`, T].map((d) => fiscalYearForDate(d, 4)))) await ctx.http().post(`${uk.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy });
  await ctx.http().post(`${uk.base}/country-module/starter-rates`).set(owner.auth).send({}).expect(201);
  await ctx.http().post(`${uk.base}/tax-rates`).set(owner.auth).send({ name: 'Exempt insurance', rate: '0' }).expect(201);
  await ctx.http().post(`${uk.base}/tax-rates`).set(owner.auth).send({ name: 'Old rate', rate: '12.5', salesAccountId: uk.acc['2300'], purchaseAccountId: uk.acc['1450'] }).expect(201);
  for (const r of (await ctx.http().get(`${uk.base}/tax-rates`).set(owner.auth).expect(200)).body as { id: string; name: string }[]) rate[r.name] = r.id;
  ids.customer = (await ctx.http().post(`${uk.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Retail Ltd', isCustomer: true }).expect(201)).body.id;
  ids.vendor = (await ctx.http().post(`${uk.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Wholesale Ltd', isVendor: true }).expect(201)).body.id;
});
afterAll(async () => ctx?.app.close());

describe('VAT registration', () => {
  it('is for UK organisations keeping books in pounds', async () => {
    const india = await createOrg(ctx, owner, { name: 'Not UK Pvt Ltd' });
    expect((await ctx.http().get(`${india.base}/tax/vat/settings`).set(owner.auth).expect(422)).body.error).toBe('NOT_UK');
    expect((await vat(E1).expect(422)).body.error).toBe('VAT_NOT_SET_UP');
    const s = (await ctx.http().get(`${uk.base}/tax/vat/settings`).set(viewer.auth).expect(200)).body;
    expect(s.settings).toBeNull();
    expect(s.rates.find((r: { name: string }) => r.name === 'VAT 20% (standard)')).toMatchObject({ treatment: null, suggested: 'STANDARD' });
    expect(s.rates.find((r: { name: string }) => r.name === 'Exempt insurance').suggested).toBe('EXEMPT');
    expect(s.rates.find((r: { name: string }) => r.name === 'Old rate').suggested).toBeNull();
  });

  it('checks the VAT number and is set by those who manage accounts', async () => {
    const body = { vrn: 'GB 123 4567 82', registeredFrom: `${M1}-01`, stagger: 'MONTHLY', untaxedTreatment: 'OUTSIDE_SCOPE', treatments: [] };
    await ctx.http().put(`${uk.base}/tax/vat/settings`).set(viewer.auth).send(body).expect(403);
    expect((await ctx.http().put(`${uk.base}/tax/vat/settings`).set(owner.auth).send({ ...body, vrn: '123456783' }).expect(422)).body.error).toBe('INVALID_VRN');
    expect((await ctx.http().put(`${uk.base}/tax/vat/settings`).set(owner.auth).send({ ...body, treatments: [{ taxRateId: '00000000-0000-4000-8000-000000000000', treatment: 'ZERO' }] }).expect(422)).body.error).toBe('UNKNOWN_TAX_RATE');
    const s = (await ctx.http().put(`${uk.base}/tax/vat/settings`).set(owner.auth).send(body).expect(200)).body;
    expect(s.settings).toMatchObject({ vrn: 'GB123456782', stagger: 'MONTHLY', updatedBy: 'VAT Owner' });
    expect((await vat(`${M1}-15`).expect(422)).body.error).toBe('NOT_A_PERIOD');
    expect((await vat(monthEnd(shiftMonth(M1, -1))).expect(422)).body.error).toBe('BEFORE_REGISTRATION');
    expect((await ctx.http().put(`${uk.base}/tax/vat/settings`).set(owner.auth).send({ ...body, registeredFrom: addDays(T, 1) }).expect(422)).body.message).toBe('The registration date cannot be in the future');
  });
});

describe('the return', () => {
  it('adds up the boxes from the books, listing other entries on the VAT accounts', async () => {
    const d = `${M1}-10`;
    ids.inv = await doc('sales', 'INVOICE', ids.customer!, d, [['Synthetic goods', '1000.00', rate['VAT 20% (standard)']!], ['Synthetic energy', '200.00', rate['VAT 5% (reduced)']!]]);
    await doc('sales', 'INVOICE', ids.customer!, d, [['Synthetic exports', '300.00', rate['VAT 0% (zero-rated)']!], ['Synthetic cover', '50.00', rate['Exempt insurance']!]]);
    await doc('sales', 'CREDIT_NOTE', ids.customer!, d, [['Synthetic return', '100.00', rate['VAT 20% (standard)']!]]);
    ids.bill = await doc('purchases', 'BILL', ids.vendor!, d, [['Synthetic stock', '400.00', rate['VAT 20% (standard)']!]]);
    // An employee's claim, approved in the period: £120 including VAT at 20%.
    const c = (await ctx.http().post(`${uk.base}/expense-claims`).set(employee.auth).send({ title: 'Synthetic travel', lines: [{ date: d, accountId: uk.acc['6700'], merchant: 'Synthetic Rail', amount: '120.00', taxRateId: rate['VAT 20% (standard)'] }] }).expect(201)).body;
    await ctx.http().post(`${uk.base}/expense-claims/${c.id}/submit`).set(employee.auth).send({}).expect(200);
    await ctx.http().post(`${uk.base}/expense-claims/${c.id}/approve`).set(approver.auth).send({ date: `${M1}-12` }).expect(200);
    // VAT paid to HMRC is on the VAT account but not on the return.
    await ctx.http().post(`${uk.base}/journals`).set(owner.auth).send({ date: `${M1}-20`, post: true, memo: 'Synthetic VAT payment', lines: [{ accountId: uk.acc['2300'], debit: '75.00' }, { accountId: uk.acc['1120'], credit: '75.00' }] }).expect(201);

    const r = (await vat(E1, viewer.auth).expect(200)).body;
    expect(r.period).toEqual({ start: `${M1}-01`, end: E1, due: addDays(monthEnd(M2), 7) });
    // Box 1: 200 + 10 - 20; box 4: 80 + 20; box 6: 1000 + 200 + 300 + 50 - 100; box 7: 400 + 100.
    expect(r.boxes).toEqual({ box1: '190.00', box2: '0.00', box3: '190.00', box4: '100.00', box5: '90.00', box6: '1450', box7: '500', box8: '0', box9: '0' });
    expect(r.direction).toBe('PAY');
    expect(r.issues).toEqual([]);
    expect(['DUE', 'OVERDUE']).toContain(r.status);
    expect(r.breakdown.find((b: { side: string; treatment: string }) => b.side === 'SALES' && b.treatment === 'EXEMPT')).toMatchObject({ net: '50.00', vat: '0.00' });
    expect(r.entries.filter((e: { source: string }) => e.source === 'EXPENSE_CLAIM')).toEqual([expect.objectContaining({ net: '100.00', vat: '20.00', date: `${M1}-12`, treatment: 'STANDARD' })]);
    expect(r.otherVatEntries).toEqual([expect.objectContaining({ memo: 'Synthetic VAT payment', debit: '75.00', credit: '0.00' })]);
  });

  it('holds back a rate with no VAT treatment until one is chosen', async () => {
    await doc('purchases', 'BILL', ids.vendor!, `${M2}-05`, [['Synthetic old stock', '100.00', rate['Old rate']!]]);
    const r = (await vat(E2).expect(200)).body;
    expect(r.issues).toEqual(['Choose the VAT treatment of Old rate (12.5%, 1 line)']);
    expect((await ctx.http().post(`${uk.base}/tax/vat/returns`).set(owner.auth).send({ periodEnd: E2, submittedOn: T }).expect(422)).body.error).toBe('RETURN_NOT_READY');
    await ctx.http().put(`${uk.base}/tax/vat/settings`).set(owner.auth).send({ vrn: 'GB123456782', registeredFrom: `${M1}-01`, stagger: 'MONTHLY', untaxedTreatment: 'OUTSIDE_SCOPE', treatments: [{ taxRateId: rate['Old rate'], treatment: 'STANDARD' }] }).expect(200);
    const again = (await vat(E2).expect(200)).body;
    expect(again.issues).toEqual([]);
    expect(again.warnings).toEqual(['Old rate is 12.5% but set as standard rate, which is 20% in the UK']);
    expect(again.boxes).toMatchObject({ box4: '12.50', box7: '100' });
  });

  it('records the submission, keeping the boxes as submitted', async () => {
    const send = (b: object, auth = owner.auth) => ctx.http().post(`${uk.base}/tax/vat/returns`).set(auth).send({ periodEnd: E1, ...b });
    await send({ submittedOn: T }, viewer.auth).expect(403);
    await send({ submittedOn: E1 }).expect(422);
    await send({ submittedOn: addDays(T, 1) }).expect(422);
    expect((await send({ submittedOn: T, box5: '91.00' }).expect(409)).body.error).toBe('FIGURES_CHANGED');
    const r = (await send({ submittedOn: T, reference: 'SYN-HMRC-1', box5: '90.00' }).expect(201)).body;
    expect(r.status).toBe('SUBMITTED');
    expect(r.submitted).toMatchObject({ submittedOn: T, reference: 'SYN-HMRC-1', recordedBy: 'VAT Owner', changedSince: null });
    expect((await send({ submittedOn: T }).expect(409)).body.error).toBe('ALREADY_RECORDED');
    const p = (await ctx.http().get(`${uk.base}/tax/vat/periods`).set(viewer.auth).expect(200)).body;
    expect(p.periods.find((x: { end: string }) => x.end === E1)).toMatchObject({ status: 'SUBMITTED', box5: '90.00', direction: 'PAY' });
    expect(p.periods.find((x: { end: string }) => x.end === E3)).toMatchObject({ status: 'OPEN' });
    // Nothing before the registration.
    expect(p.periods.map((x: { end: string }) => x.end)).toEqual([E3, E2, E1]);
    const audit = await ctx.prisma.auditEvent.findFirst({ where: { orgId: uk.orgId, action: 'vat_return.recorded' } });
    expect(audit?.data).toMatchObject({ periodEnd: E1, reference: 'SYN-HMRC-1', boxes: { box5: '90.00' } });
  });

  it('carries a later change to a submitted period to the next return', async () => {
    // A back-dated invoice in the submitted period.
    await doc('sales', 'INVOICE', ids.customer!, `${M1}-25`, [['Synthetic late sale', '100.00', rate['VAT 20% (standard)']!]]);
    const first = (await vat(E1).expect(200)).body;
    expect(first.boxes.box1).toBe('190.00');
    expect(first.prepared.box1).toBe('210.00');
    expect(first.submitted.changedSince).toEqual({ box1: '20.00', box4: '0.00', net: '20.00' });

    const next = (await vat(E2).expect(200)).body;
    expect(next.corrections).toMatchObject({ included: true, pending: [{ periodEnd: E1, box1: '20.00', box4: '0.00', net: '20.00' }], allowance: { net: '20.00', limit: '10000.00', allowed: true } });
    expect(next.boxes).toMatchObject({ box1: '20.00', box4: '12.50', box5: '7.50' });
    await ctx.http().post(`${uk.base}/tax/vat/returns`).set(owner.auth).send({ periodEnd: E2, submittedOn: T, box5: '7.50' }).expect(201);
    // Corrected once: not offered again, and the first return no longer shows a change.
    expect((await vat(E3).expect(200)).body.corrections.pending).toEqual([]);
    expect((await vat(E1).expect(200)).body.submitted.changedSince).toBeNull();
  });

  it('takes a void off in the period it happens, leaving the submitted period alone', async () => {
    await ctx.http().post(`${uk.base}/purchases/documents/${ids.bill}/void`).set(owner.auth).send({ date: T, reason: 'Synthetic duplicate' }).expect(200);
    const open = (await vat(E3).expect(200)).body;
    expect(open.status).toBe('OPEN');
    expect(open.issues).toEqual([`The period ends on ${E3}; record the return once it has ended`]);
    expect(open.entries).toEqual([expect.objectContaining({ source: 'BILL', reversal: true, date: T, vat: '80.00' })]);
    expect(open.boxes).toMatchObject({ box4: '-80.00', box5: '80.00', box7: '-400' });
    expect(open.direction).toBe('PAY');
    expect((await vat(E1).expect(200)).body.submitted.changedSince).toBeNull();
  });

  it('exports the return as CSV, kept in the audit trail', async () => {
    const x = (await ctx.http().get(`${uk.base}/tax/vat/return/export?periodEnd=${E1}`).set(viewer.auth).expect(200)).body;
    expect(x.fileName).toBe(`vat-return-${M1}-01-to-${E1}.csv`);
    expect(x.csv).toContain('5,Net VAT to pay to HMRC or reclaim,90.00');
    expect(await ctx.prisma.auditEvent.count({ where: { orgId: uk.orgId, action: 'vat_return.exported' } })).toBe(1);
    expect(await ctx.prisma.auditEvent.count({ where: { orgId: uk.orgId, action: 'vat_settings.updated' } })).toBe(2);
  });
});
