import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * AR-013 milestone billing and AR-014 progress billing of sales orders against the real API and
 * database: choosing the method, planning milestones, invoicing reached milestones (the last takes
 * exactly what is left), progress claims billed up to the percent complete, void invoices freeing
 * their share, locks, permissions, tenant isolation and the database guards.
 */
const T = today();

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let customer: { id: string };
let tax18: { id: string };

const raw = (sql: string) =>
  ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
    return tx.$executeRawUnsafe(sql);
  });
const newOrder = async () =>
  (
    await ctx
      .http()
      .post(`${org.base}/sales/orders`)
      .set(owner.auth)
      .send({
        contactId: customer.id,
        orderDate: T,
        lines: [
          { accountId: org.acc['4100'], description: 'Website build', quantity: '1', unitPrice: '100000.00', taxRateId: tax18.id },
          { accountId: org.acc['4200'], description: 'Content pages', quantity: '3', unitPrice: '3333.33' },
        ],
      })
      .expect(201)
  ).body;
const doc = async (id: string) => (await ctx.http().get(`${org.base}/sales/documents/${id}`).set(owner.auth).expect(200)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Project Owner');
  viewer = await registerUser(ctx, 'Project Viewer');
  outsider = await registerUser(ctx, 'Project Outsider');
  org = await createOrg(ctx, owner, { name: 'Project Billing Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Projects Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Kapoor Studios', isCustomer: true }).expect(201)).body;
  tax18 = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'Standard 18%', rate: '18', salesAccountId: org.acc['2300'], purchaseAccountId: org.acc['1450'] }).expect(201)).body;
});
afterAll(async () => {
  await ctx.app.close();
});

describe('milestone billing', () => {
  let o: { id: string; total: string };
  let ms: { id: string; name: string }[];
  it('is chosen per order and planned in shares of at most 100%', async () => {
    o = await newOrder();
    expect(o.total).toBe('127999.99');
    const fresh = (await ctx.http().get(`${org.base}/sales/orders/${o.id}`).set(owner.auth).expect(200)).body;
    expect(fresh).toMatchObject({ billingMethod: 'DELIVERY', milestones: [], progress: { claimed: '0', claims: [] } });
    expect((await ctx.http().put(`${org.base}/sales/orders/${o.id}/milestones`).set(owner.auth).send({ milestones: [{ name: 'Design', percent: '30' }] }).expect(422)).body.error).toBe('ORDER_BILLING_METHOD');
    await ctx.http().put(`${org.base}/sales/orders/${o.id}/billing-method`).set(viewer.auth).send({ method: 'MILESTONES' }).expect(403);
    const m = await ctx.http().put(`${org.base}/sales/orders/${o.id}/billing-method`).set(owner.auth).send({ method: 'MILESTONES' }).expect(200);
    expect(m.body.billingMethod).toBe('MILESTONES');
    const over = await ctx.http().put(`${org.base}/sales/orders/${o.id}/milestones`).set(owner.auth).send({ milestones: [{ name: 'Design', percent: '60' }, { name: 'Build', percent: '50' }] }).expect(422);
    expect(over.body.message).toBe('The milestones add up to 110%; they can be at most 100%');
    const p = await ctx
      .http()
      .put(`${org.base}/sales/orders/${o.id}/milestones`)
      .set(owner.auth)
      .send({ milestones: [{ name: 'Design signed off', percent: '30', dueDate: T }, { name: 'Site live', percent: '50' }, { name: 'Handover', percent: '20' }] })
      .expect(200);
    ms = p.body.milestones;
    expect(p.body.milestonesTotal).toBe('100');
    expect(ms.map((x: { percent: string; value: string }) => [x.percent, x.value])).toEqual([['30', '38400.00'], ['50', '64000.00'], ['20', '25600.00']]);
    // Delivery billing is refused while the order is billed by milestones.
    expect((await ctx.http().post(`${org.base}/sales/orders/${o.id}/invoices`).set(owner.auth).send({ issueDate: T }).expect(422)).body.error).toBe('ORDER_BILLING_METHOD');
  });

  it('invoices a reached milestone for its share of every line', async () => {
    expect((await ctx.http().post(`${org.base}/sales/orders/${o.id}/milestones/${ms[0]!.id}/invoice`).set(owner.auth).send({ issueDate: T }).expect(422)).body.error).toBe('MILESTONE_NOT_REACHED');
    await ctx.http().post(`${org.base}/sales/orders/${o.id}/milestones/${ms[0]!.id}/complete`).set(owner.auth).send({ done: true }).expect(200);
    const r = await ctx.http().post(`${org.base}/sales/orders/${o.id}/milestones/${ms[0]!.id}/invoice`).set(owner.auth).send({ issueDate: T }).expect(201);
    const d = await doc(r.body.documentId);
    expect(d.lines.map((l: { quantity: string }) => l.quantity)).toEqual(['0.3', '0.9']);
    expect(d.memo).toBe('Milestone: Design signed off (30%)');
    expect(r.body.order.milestones[0].invoice).toMatchObject({ id: r.body.documentId, status: 'DRAFT' });
    expect(r.body.order.milestonesInvoiced).toBe('30');
    expect((await ctx.http().post(`${org.base}/sales/orders/${o.id}/milestones/${ms[0]!.id}/invoice`).set(owner.auth).send({ issueDate: T }).expect(422)).body.error).toBe('MILESTONE_INVOICED');
    // An invoiced milestone keeps its name and share, cannot be removed or reopened; the method is locked.
    const keep = r.body.order.milestones.map((x: { id: string; name: string; percent: string }) => ({ id: x.id, name: x.name, percent: x.percent }));
    expect((await ctx.http().put(`${org.base}/sales/orders/${o.id}/milestones`).set(owner.auth).send({ milestones: [{ ...keep[0], percent: '25' }, keep[1], keep[2]] }).expect(422)).body.error).toBe('MILESTONE_INVOICED');
    expect((await ctx.http().put(`${org.base}/sales/orders/${o.id}/milestones`).set(owner.auth).send({ milestones: [keep[1], keep[2]] }).expect(422)).body.error).toBe('MILESTONE_INVOICED');
    expect((await ctx.http().post(`${org.base}/sales/orders/${o.id}/milestones/${ms[0]!.id}/complete`).set(owner.auth).send({ done: false }).expect(422)).body.error).toBe('MILESTONE_INVOICED');
    expect((await ctx.http().put(`${org.base}/sales/orders/${o.id}/billing-method`).set(owner.auth).send({ method: 'PROGRESS' }).expect(422)).body.error).toBe('ORDER_BILLING_METHOD_LOCKED');
    // The others can be reordered and re-shared.
    const re = await ctx.http().put(`${org.base}/sales/orders/${o.id}/milestones`).set(owner.auth).send({ milestones: [keep[0], { ...keep[2], percent: '25' }, { ...keep[1], percent: '45' }] }).expect(200);
    expect(re.body.milestones.map((x: { name: string; percent: string }) => `${x.name} ${x.percent}`)).toEqual(['Design signed off 30', 'Handover 25', 'Site live 45']);
    ms = re.body.milestones;
  });

  it('bills exactly the quantities left on the last milestone, and a void invoice frees its share', async () => {
    const a = (await ctx.http().post(`${org.base}/sales/documents/${(await ctx.http().get(`${org.base}/sales/orders/${o.id}`).set(owner.auth)).body.milestones[0].invoice.id}/post`).set(owner.auth).send({}).expect(200)).body;
    for (const m of [ms[2]!, ms[1]!]) await ctx.http().post(`${org.base}/sales/orders/${o.id}/milestones/${m.id}/complete`).set(owner.auth).send({ done: true }).expect(200);
    const live = await ctx.http().post(`${org.base}/sales/orders/${o.id}/milestones/${ms[2]!.id}/invoice`).set(owner.auth).send({ issueDate: T }).expect(201);
    expect((await doc(live.body.documentId)).lines.map((l: { quantity: string }) => l.quantity)).toEqual(['0.45', '1.35']);
    // Void it: the share is free again and invoicing it again bills the same.
    await ctx.http().post(`${org.base}/sales/documents/${live.body.documentId}/post`).set(owner.auth).send({}).expect(200);
    await ctx.http().post(`${org.base}/sales/documents/${live.body.documentId}/void`).set(owner.auth).send({ reason: 'Wrong date' }).expect(200);
    const after = (await ctx.http().get(`${org.base}/sales/orders/${o.id}`).set(owner.auth).expect(200)).body;
    expect(after.milestones[2]).toMatchObject({ invoice: null, voidInvoice: { status: 'VOID' } });
    expect(after.milestonesInvoiced).toBe('30');
    await ctx.http().post(`${org.base}/sales/orders/${o.id}/milestones/${ms[2]!.id}/invoice`).set(owner.auth).send({ issueDate: T }).expect(201);
    const last = await ctx.http().post(`${org.base}/sales/orders/${o.id}/milestones/${ms[1]!.id}/invoice`).set(owner.auth).send({ issueDate: T }).expect(201);
    expect((await doc(last.body.documentId)).lines.map((l: { quantity: string }) => l.quantity)).toEqual(['0.25', '0.75']);
    expect(last.body.order).toMatchObject({ billing: 'BILLED', milestonesInvoiced: '100', toBill: '0.00' });
    expect(a.status).toBe('POSTED');
    const totals = last.body.order.invoices.filter((i: { status: string }) => i.status !== 'VOID').reduce((t: number, i: { total: string }) => t + Math.round(Number(i.total) * 100), 0);
    // Each invoice rounds its own lines (0.9 x 3,333.33 is 3,000.00), so three partial invoices can
    // differ from the order's 1,27,999.99 by a paisa per line; the quantities themselves add up exactly.
    expect(Math.abs(totals - 12799999)).toBeLessThanOrEqual(3);
    expect(last.body.order.lines.map((l: { billed: string }) => l.billed)).toEqual(['1', '3']);
  });
});

describe('progress billing', () => {
  let o: { id: string };
  it('bills every line up to the percent complete, less earlier claims', async () => {
    o = await newOrder();
    await ctx.http().put(`${org.base}/sales/orders/${o.id}/billing-method`).set(owner.auth).send({ method: 'PROGRESS' }).expect(200);
    await ctx.http().post(`${org.base}/sales/orders/${o.id}/progress-claims`).set(viewer.auth).send({ percentComplete: '40', issueDate: T }).expect(403);
    const a = await ctx.http().post(`${org.base}/sales/orders/${o.id}/progress-claims`).set(owner.auth).send({ percentComplete: '40', issueDate: T, note: 'Foundations done' }).expect(201);
    const d = await doc(a.body.documentId);
    expect(d.lines.map((l: { quantity: string }) => l.quantity)).toEqual(['0.4', '1.2']);
    expect(d.memo).toBe('Progress claim: 40% complete (Foundations done)');
    expect(a.body.order.progress).toMatchObject({ claimed: '40', claims: [{ percentComplete: '40', note: 'Foundations done', void: false }] });
    const low = await ctx.http().post(`${org.base}/sales/orders/${o.id}/progress-claims`).set(owner.auth).send({ percentComplete: '40', issueDate: T }).expect(422);
    expect(low.body.message).toBe('Earlier claims already bill 40% complete; claim a higher percent');
    expect((await ctx.http().post(`${org.base}/sales/orders/${o.id}/progress-claims`).set(owner.auth).send({ percentComplete: '101', issueDate: T }).expect(422)).body.error).toBe('PROGRESS_INVALID');
    const b = await ctx.http().post(`${org.base}/sales/orders/${o.id}/progress-claims`).set(owner.auth).send({ percentComplete: '75.5', issueDate: T }).expect(201);
    expect((await doc(b.body.documentId)).lines.map((l: { quantity: string }) => l.quantity)).toEqual(['0.355', '1.065']);
  });

  it('frees a claim when its draft is deleted, and the final claim takes what is left', async () => {
    const cur = (await ctx.http().get(`${org.base}/sales/orders/${o.id}`).set(owner.auth).expect(200)).body;
    const second = cur.progress.claims[1].invoice.id;
    await ctx.http().delete(`${org.base}/sales/documents/${second}`).set(owner.auth).expect(204);
    const after = (await ctx.http().get(`${org.base}/sales/orders/${o.id}`).set(owner.auth).expect(200)).body;
    expect(after.progress.claims).toHaveLength(1);
    expect(after.progress.claimed).toBe('40');
    const fin = await ctx.http().post(`${org.base}/sales/orders/${o.id}/progress-claims`).set(owner.auth).send({ percentComplete: '100', issueDate: T }).expect(201);
    expect((await doc(fin.body.documentId)).lines.map((l: { quantity: string }) => l.quantity)).toEqual(['0.6', '1.8']);
    expect(fin.body.order.billing).toBe('BILLED');
    expect((await ctx.http().post(`${org.base}/sales/orders/${o.id}/progress-claims`).set(owner.auth).send({ percentComplete: '100', issueDate: T }).expect(422)).body.error).toBe('PROGRESS_INVALID');
    // The audit trail names each claim.
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=sales_order`).set(owner.auth).expect(200)).body;
    expect(JSON.stringify(audit)).toContain('"percentComplete":"100"');
  });
});

describe('isolation and guards', () => {
  it('keeps other organisations out', async () => {
    const o = await newOrder();
    await ctx.http().put(`${other.base}/sales/orders/${o.id}/billing-method`).set(outsider.auth).send({ method: 'PROGRESS' }).expect(404);
    await ctx.http().put(`${org.base}/sales/orders/${o.id}/billing-method`).set(outsider.auth).send({ method: 'PROGRESS' }).expect(404);
  });

  it('the database refuses changing an invoiced milestone or a progress claim', async () => {
    const [m] = await ctx.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
      return tx.$queryRawUnsafe<{ id: string }[]>(`SELECT m.id FROM sales_order_milestones m JOIN documents d ON d.id = m.document_id WHERE m.org_id = '${org.orgId}' AND d.status <> 'VOID' LIMIT 1`);
    });
    await expect(raw(`UPDATE sales_order_milestones SET percent = 1 WHERE id = '${m!.id}'`)).rejects.toThrow(/milestone is invoiced/);
    await expect(raw(`DELETE FROM sales_order_milestones WHERE id = '${m!.id}'`)).rejects.toThrow(/milestone is invoiced/);
    await expect(raw(`UPDATE sales_order_progress_claims SET percent_complete = 1 WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/progress claim cannot be changed/);
    await expect(raw(`UPDATE sales_orders SET billing_method = 'DELIVERY' WHERE org_id = '${org.orgId}' AND billing_method = 'PROGRESS'`)).rejects.toThrow(/billing method can no longer change/);
  });
});
