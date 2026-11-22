/**
 * Invoice dispute classification (AR-037) against the real API and database: the likely reason
 * suggested for a dispute about to be raised, from what the customer said and the invoice (another
 * invoice for the same total, a disputed amount equal to the tax); recorded disputes whose reason
 * looks wrong are flagged in the list and on the dispute; permissions, validation and isolation.
 */
import { addDays, formatDateText } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const T = today();
const c: Record<string, string> = {};
const inv: Record<string, { id: string; number: string }> = {};
let gst: string;
const S = () => `${org.base}/sales/disputes`;
const classify = (body: Record<string, unknown>, user = owner, o = org) => ctx.http().post(`${o.base}/sales/disputes/classify`).set(user.auth).send(body);
const invoice = async (who: string, ago: number, amount: string, tax = false) =>
  (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: c[who], issueDate: addDays(T, -ago), dueDate: addDays(T, 15 - ago), post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount, ...(tax ? { taxRateId: gst } : {}) }] }).expect(201)).body as { id: string; number: string };

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Classify Owner');
  viewer = await registerUser(ctx, 'Classify Viewer');
  outsider = await registerUser(ctx, 'Classify Outsider');
  org = await createOrg(ctx, owner, { name: 'Dispute Reasons Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Reasons Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  gst = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'GST 18%', rate: '18', salesAccountId: org.acc['2300'], purchaseAccountId: org.acc['1450'] }).expect(201)).body.id;
  for (const name of ['Banyan Retail', 'Cedar Mart']) c[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, isCustomer: true }).expect(201)).body.id;
  inv.first = await invoice('Banyan Retail', 20, '10000');
  inv.again = await invoice('Banyan Retail', 5, '10000');
  inv.taxed = await invoice('Cedar Mart', 10, '5000', true);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('dispute classification', () => {
  it('suggests the reason from what the customer said', async () => {
    expect((await classify({ documentId: inv.first.id, description: 'Billed at 1,000 a unit; the agreed rate as per quotation was 750' }).expect(200)).body).toEqual({ reason: 'PRICE', label: 'Price or rate', confidence: 'HIGH', because: ['"agreed rate"', '"as per quotation"'] });
    expect((await classify({ documentId: inv.taxed.id, description: 'Customer is unhappy' }).expect(200)).body).toMatchObject({ reason: 'OTHER', confidence: 'LOW', because: [] });
  });

  it('uses the invoice: one billed again for the same total, and a disputed amount equal to the tax', async () => {
    expect((await classify({ documentId: inv.again.id, description: 'Please look into this invoice' }).expect(200)).body).toEqual({ reason: 'DUPLICATE', label: 'Billed twice', confidence: 'MEDIUM', because: [`${inv.first.number} of ${formatDateText(addDays(T, -20))} is for the same total`] });
    expect((await classify({ documentId: inv.taxed.id, description: 'They will not pay this part', amount: '900' }).expect(200)).body).toMatchObject({ reason: 'TAX', because: ["the amount in dispute is the invoice's tax"] });
  });

  it('flags a recorded dispute whose reason looks wrong', async () => {
    const wrong = (await ctx.http().post(S()).set(owner.auth).send({ documentId: inv.taxed.id, reason: 'OTHER', description: 'Three chairs arrived damaged and one is broken' }).expect(201)).body;
    expect(wrong).toMatchObject({ reason: 'OTHER', suggested: { reason: 'QUALITY', label: 'Quality or damage', confidence: 'HIGH' }, reasonDiffers: true });
    const right = (await ctx.http().post(S()).set(owner.auth).send({ documentId: inv.first.id, amount: '2500', reason: 'PRICE', description: 'The agreed rate was 750 a unit' }).expect(201)).body;
    expect(right).toMatchObject({ suggested: { reason: 'PRICE' }, reasonDiffers: false });
    let list = (await ctx.http().get(S()).set(viewer.auth).expect(200)).body;
    expect(list.reasonDiffers).toBe(1);
    expect(list.disputes.find((d: any) => d.id === wrong.id).reasonDiffers).toBe(true);
    // Correcting the reason clears the flag.
    await ctx.http().put(`${S()}/${wrong.id}`).set(owner.auth).send({ reason: 'QUALITY', description: wrong.description }).expect(200);
    list = (await ctx.http().get(S()).set(owner.auth).expect(200)).body;
    expect(list.reasonDiffers).toBe(0);
  });

  it('is read-only for viewers, checked, and kept to the organisation', async () => {
    await classify({ documentId: inv.first.id, description: 'Goods never arrived' }, viewer).expect(200);
    await classify({ documentId: inv.first.id, description: ' ' }).expect(400);
    await classify({ documentId: inv.first.id, description: 'x', extra: 1 }).expect(400);
    await classify({ documentId: inv.first.id, description: 'x' }, outsider).expect(404);
    await classify({ documentId: inv.first.id, description: 'x' }, outsider, other).expect(404);
  });
});
