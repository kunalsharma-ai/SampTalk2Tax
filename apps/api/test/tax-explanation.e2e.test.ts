import { addDays, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Source-backed tax explanations (TAX-052) against the real API and database: an intra-state
 * invoice whose rate changed before it was issued, an inter-state invoice, and a reverse-charge
 * bill with TDS, each explained point by point with the record or provision it comes from; and
 * permissions and tenants.
 */
const synthetic = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
const T = today();
const CHANGED = addDays(T, -10);
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let employee: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const c: Record<string, string> = {};
const d: Record<string, { id: string; number: string }> = {};
const explain = async (ledger: 'sales' | 'purchases', key: string, who = viewer) => (await ctx.http().get(`${org.base}/${ledger}/documents/${d[key]!.id}/tax-explanation`).set(who.auth).expect(200)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Explain Owner');
  viewer = await registerUser(ctx, 'Explain Viewer');
  employee = await registerUser(ctx, 'Explain Employee');
  org = await createOrg(ctx, owner, { name: 'Explained Traders Pvt Ltd' });
  for (const [u, role] of [[viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fiscalYearForDate(T, 4) });
  await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: synthetic('27', 'ZZZTE0001Z'), legalName: 'Explained Traders Pvt Ltd', effectiveFrom: addDays(T, -60) }).expect(200);
  await ctx.http().put(`${org.base}/withholding/settings`).set(owner.auth).send({ tan: 'pnez12345b' }).expect(200);
  for (const a of (await ctx.http().get(`${org.base}/accounts`).set(owner.auth).expect(200)).body as { code: string; id: string }[]) org.acc[a.code] = a.id;
  const professional = (await ctx.http().post(`${org.base}/withholding/sections`).set(owner.auth).send({ template: '393(1)-6(iii)(b)' }).expect(201)).body;
  const rate = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'GST standard', rate: '12', kind: 'GST' }).expect(201)).body.id;
  await ctx.http().post(`${org.base}/tax-rates/${rate}/versions`).set(owner.auth).send({ rate: '18', effectiveFrom: CHANGED, reason: 'Synthetic rate change' }).expect(201);
  const mk = async (k: string, body: Record<string, unknown>) => (c[k] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send(body).expect(201)).body.id);
  await mk('pune', { name: 'Pune Buyers', isCustomer: true, gstin: synthetic('27', 'ZZZTE0002Z') });
  await mk('bengaluru', { name: 'Bengaluru Buyers', isCustomer: true, gstin: synthetic('29', 'ZZZTE0003Z') });
  await mk('advocate', { name: 'Adv. Synthetic Iyer', isVendor: true, stateCode: '27', pan: 'ZZZPT0004Z' });
  const post = async (k: string, path: string, body: Record<string, unknown>) => {
    const r = (await ctx.http().post(`${org.base}/${path}/documents`).set(owner.auth).send({ issueDate: T, dueDate: T, post: true, ...body }).expect(201)).body;
    d[k] = { id: r.id, number: r.number };
  };
  const line = (account: string, amount: string, hsnCode: string) => ({ accountId: org.acc[account], description: 'Synthetic supply', quantity: '1', unitPrice: amount, taxRateId: rate, hsnCode });
  await post('intra', 'sales', { kind: 'INVOICE', contactId: c.pune, lines: [line('4100', '10000.00', '8471')] });
  await post('inter', 'sales', { kind: 'INVOICE', contactId: c.bengaluru, lines: [line('4100', '5000.00', '8471')] });
  await post('legal', 'purchases', { kind: 'BILL', contactId: c.advocate, reverseCharge: true, withholdingSectionId: professional.id, lines: [line('6600', '60000.00', '998211')] });
});
afterAll(async () => ctx?.app.close());

describe('tax explanations', () => {
  it('explains an intra-state invoice, including the rate change before it, with sources', async () => {
    const e = await explain('sales', 'intra');
    expect(e).toMatchObject({ documentId: d.intra!.id, number: d.intra!.number, kind: 'INVOICE', summary: 'Tax on this invoice: GST INR 1800.00.', checks: [] });
    expect(e.points.map((p: { key: string }) => p.key)).toEqual(['place_of_supply', 'nature']);
    expect(e.points[0].text).toMatch(/^The place of supply is Maharashtra \(27\)[\s\S]*defaults to Pune Buyers's state/);
    expect(e.points[1].title).toBe('Intra-state: CGST and SGST');
    expect(e.lines[0].text).toBe(`INR 10000.00 at 18% = CGST 9% INR 900.00 and SGST 9% INR 900.00, each rounded on its own so the halves are equal. "GST standard" was 12% when it was set up; 18% has been in force since ${CHANGED}, which covers ${T}.`);
    expect(e.lines[0].sources).toEqual(expect.arrayContaining([{ kind: 'BOOKS', label: 'Tax rate "GST standard"' }, { kind: 'LAW', label: 'CGST Act, 2017, s.9(1) and the state GST Act' }, { kind: 'BOOKS', label: 'Rate versions of "GST standard"' }, { kind: 'BOOKS', label: 'HSN/SAC 8471' }]));
    expect(e.basis).toMatch(/no AI model is used/);
  });

  it('explains an inter-state invoice', async () => {
    const e = await explain('sales', 'inter');
    expect(e.points[1]).toMatchObject({ title: 'Inter-state: IGST', sources: [{ kind: 'LAW', label: 'IGST Act, 2017, s.7 (inter-state supply) and s.5(1)' }] });
    expect(e.lines[0].text).toMatch(/^INR 5000\.00 at 18% = IGST INR 900\.00\./);
  });

  it('explains a reverse-charge bill with TDS', async () => {
    const e = await explain('purchases', 'legal');
    expect(e.summary).toMatch(/^Tax on this bill: GST INR 10800\.00 payable by you under reverse charge; TDS INR \d+\.\d{2}\.$/);
    const rc = e.points.find((p: { key: string }) => p.key === 'reverse_charge');
    expect(rc.text).toMatch(/You, not Adv\. Synthetic Iyer, pay the GST on this bill because it is legal services by an advocate, a notified category[\s\S]*issue a self-invoice within 30 days/);
    const tds = e.points.find((p: { key: string }) => p.key === 'withholding');
    expect(tds.text).toMatch(/^You deduct INR [\d.]+ of income tax from what you pay Adv\. Synthetic Iyer: 10% on INR 60000\.00 under section 393\(1\)-6\(iii\)\(b\)/);
    expect(tds.sources[0]).toMatchObject({ kind: 'LAW', label: expect.stringMatching(/^Income-tax Act 2025, s\.393\(1\) Table/) });
    expect(tds.sources[1]).toEqual({ kind: 'BOOKS', label: 'PAN ZZZPT0004Z' });
  });

  it('needs read access to the ledger and is kept to its organisation', async () => {
    await ctx.http().get(`${org.base}/sales/documents/${d.intra!.id}/tax-explanation`).set(employee.auth).expect(403);
    await ctx.http().get(`${org.base}/purchases/documents/${d.intra!.id}/tax-explanation`).set(owner.auth).expect(404);
    await ctx.http().get(`${org.base}/sales/documents/not-a-uuid/tax-explanation`).set(owner.auth).expect(400);
    const outsider = await registerUser(ctx, 'Explain Outsider');
    await ctx.http().get(`${org.base}/sales/documents/${d.intra!.id}/tax-explanation`).set(outsider.auth).expect(404);
    const other = await createOrg(ctx, owner, { name: 'Other Explained Ltd' });
    await ctx.http().get(`${other.base}/sales/documents/${d.intra!.id}/tax-explanation`).set(owner.auth).expect(404);
  });
});
