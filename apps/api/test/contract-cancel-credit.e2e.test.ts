import { addMonthsAnchored, contractPeriod, D, proratedPrice, unusedShare } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * AR-011 against the real API and database: cancelling a contract part-way through a period it
 * billed in advance credits the unused days. The preview and the cancellation agree; each posted
 * invoice running past today gets its own draft credit note at the contract's prices; draft
 * invoices are listed, not credited; arrears contracts have nothing to credit; permissions,
 * tenant isolation and the audit trail.
 */
const T = today();
const months = (n: number) => addMonthsAnchored(T, n);

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let customer: { id: string };
let tax18: { id: string };

const contract = async (extra: Record<string, unknown> = {}) => {
  const c = (
    await ctx
      .http()
      .post(`${org.base}/sales/contracts`)
      .set(owner.auth)
      .send({
        contactId: customer.id,
        title: 'Managed payroll',
        frequency: 'MONTHLY',
        timing: 'ADVANCE',
        startDate: months(-1),
        endDate: null,
        autoRenew: false,
        noticeDays: 30,
        lines: [{ accountId: org.acc['4100'], description: 'Payroll service', quantity: '1', unitPrice: '30000.00', taxRateId: tax18.id }],
        ...extra,
      })
      .expect(201)
  ).body;
  return (await ctx.http().post(`${org.base}/sales/contracts/${c.id}/activate`).set(owner.auth).expect(200)).body;
};
const post = async (docId: string) => {
  const r = await ctx.http().post(`${org.base}/sales/documents/${docId}/post`).set(owner.auth).send({});
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Credit Owner');
  viewer = await registerUser(ctx, 'Credit Viewer');
  outsider = await registerUser(ctx, 'Credit Outsider');
  org = await createOrg(ctx, owner, { name: 'Unused Days Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Credit Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Iyer Foods', isCustomer: true }).expect(201)).body;
  tax18 = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'Standard 18%', rate: '18', salesAccountId: org.acc['2300'], purchaseAccountId: org.acc['1450'] }).expect(201)).body;
});
afterAll(async () => {
  await ctx.app.close();
});

describe('cancelling part-way through a period billed in advance', () => {
  it('previews and credits the unused days of the current period on its own credit note', async () => {
    const c = await contract();
    expect(c.periodsBilled).toBe(2);
    const current = c.periods.find((p: { periodNo: number }) => p.periodNo === 2);
    const past = c.periods.find((p: { periodNo: number }) => p.periodNo === 1);
    await post(current.invoice.id);
    await post(past.invoice.id);
    const invoiceNo = (await ctx.http().get(`${org.base}/sales/documents/${current.invoice.id}`).set(owner.auth).expect(200)).body.number;
    expect(invoiceNo).toBeTruthy();

    const share = unusedShare(contractPeriod(months(-1), 'MONTHLY', 2), T)!;
    const net = proratedPrice('30000.00', share);
    const gross = new D(net).plus(new D(net).times('0.18').toDecimalPlaces(2, D.ROUND_HALF_UP)).toFixed(2);

    const preview = (await ctx.http().get(`${org.base}/sales/contracts/${c.id}/cancel-credit`).set(viewer.auth).expect(200)).body;
    expect(preview).toMatchObject({ today: T, timing: 'ADVANCE', drafts: [], total: gross });
    expect(preview.periods).toHaveLength(1);
    expect(preview.periods[0]).toMatchObject({ periodNo: 2, from: share.from, days: share.days, of: share.of, subtotal: net, total: gross, invoice: { id: current.invoice.id } });
    expect(preview.periods[0].lines).toBeUndefined();

    const done = (await ctx.http().post(`${org.base}/sales/contracts/${c.id}/cancel`).set(owner.auth).send({ reason: 'Customer closed the Pune office', creditUnused: true }).expect(200)).body;
    expect(done).toMatchObject({ status: 'CANCELLED', cancelReason: 'Customer closed the Pune office' });
    expect(done.creditNotes).toHaveLength(1);
    expect(done.creditNotes[0]).toMatchObject({ total: gross, invoice: invoiceNo });
    expect(done.events[0].body).toContain(`a draft credit note for unused days, ${gross}`);

    const cn = (await ctx.http().get(`${org.base}/sales/documents/${done.creditNotes[0].id}`).set(owner.auth).expect(200)).body;
    expect(cn).toMatchObject({ kind: 'CREDIT_NOTE', status: 'DRAFT', issueDate: T, subtotal: net, total: gross });
    expect(cn.contact?.id ?? cn.contactId).toBe(customer.id);
    expect(cn.reference).toContain(`unused days of ${invoiceNo}`);
    expect(new D(cn.lines[0].unitPrice).eq(net)).toBe(true);
    expect(cn.lines[0].description).toContain(`unused ${share.days} of ${share.of} days`);
    // The credit note posts and settles against the invoice it reduces.
    await post(cn.id);

    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=sales_contract&entityId=${c.id}`).set(owner.auth).expect(200)).body;
    const cancelled = (audit.items ?? audit).find((e: { action: string }) => e.action === 'sales_contract.cancelled');
    expect(cancelled.data).toMatchObject({ creditNotes: [done.creditNotes[0].id], creditTotal: gross });
  });

  it('lists a draft invoice instead of crediting it, and refuses when there is nothing to credit', async () => {
    const c = await contract({ title: 'Draft-only billing' });
    const preview = (await ctx.http().get(`${org.base}/sales/contracts/${c.id}/cancel-credit`).set(owner.auth).expect(200)).body;
    expect(preview.periods).toEqual([]);
    expect(preview.total).toBe('0.00');
    expect(preview.drafts).toHaveLength(1);
    expect(preview.drafts[0]).toMatchObject({ periodNo: 2 });
    const bad = await ctx.http().post(`${org.base}/sales/contracts/${c.id}/cancel`).set(owner.auth).send({ reason: 'Stopped', creditUnused: true }).expect(422);
    expect(bad.body).toMatchObject({ error: 'CONTRACT_NOTHING_TO_CREDIT' });
    // Nothing changed: the contract is still active and can be cancelled without a credit.
    const plain = (await ctx.http().post(`${org.base}/sales/contracts/${c.id}/cancel`).set(owner.auth).send({ reason: 'Stopped' }).expect(200)).body;
    expect(plain).toMatchObject({ status: 'CANCELLED', creditNotes: [] });
  });

  it('has nothing to credit on a contract billed in arrears', async () => {
    const c = await contract({ title: 'Arrears billing', timing: 'ARREARS' });
    for (const p of c.periods) await post(p.invoice.id);
    expect((await ctx.http().get(`${org.base}/sales/contracts/${c.id}/cancel-credit`).set(owner.auth).expect(200)).body).toMatchObject({ timing: 'ARREARS', periods: [], total: '0.00' });
    const bad = await ctx.http().post(`${org.base}/sales/contracts/${c.id}/cancel`).set(owner.auth).send({ reason: 'Stopped', creditUnused: true }).expect(422);
    expect(bad.body.message).toContain('bills in arrears');
  });

  it('needs sales.manage to cancel, and stays inside the organisation', async () => {
    const c = await contract({ title: 'Access check' });
    await ctx.http().post(`${org.base}/sales/contracts/${c.id}/cancel`).set(viewer.auth).send({ reason: 'x', creditUnused: true }).expect(403);
    await ctx.http().get(`${other.base}/sales/contracts/${c.id}/cancel-credit`).set(outsider.auth).expect(404);
    await ctx.http().post(`${org.base}/sales/contracts/${c.id}/cancel`).set(owner.auth).send({ reason: 'x', creditUnused: 'yes' }).expect(400);
  });
});
