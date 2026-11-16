import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Unbilled revenue detection (AR-042) against the real API and database: each source found from
 * real records (milestone completed, contract period due, draft invoice waiting, order left
 * unbilled, pro forma expired, regular customer missed), dismissing with a reason (kept as
 * recorded), coming back when the amount grows, permissions and tenant isolation.
 */
const T = today();
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
const month = (by: number) => {
  const m = +T.slice(5, 7) - 1 + by + +T.slice(0, 4) * 12;
  return `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`;
};

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const c: Record<string, { id: string }> = {};
const ids: Record<string, string> = {};
const U = () => `${org.base}/sales/unbilled-revenue`;
const raw = (sql: string, ...args: unknown[]) =>
  ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
    return tx.$executeRawUnsafe(sql, ...args);
  });
const line = (unitPrice: string, quantity = '1') => ({ accountId: org.acc['4100'], description: 'Services', quantity, unitPrice });
const report = async () => (await ctx.http().get(U()).set(viewer.auth).expect(200)).body;
const find = (r: { findings: { source: string; refId: string }[] }, source: string, refId: string) => r.findings.find((f) => f.source === source && f.refId === refId) as Record<string, unknown> | undefined;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Billing Owner');
  viewer = await registerUser(ctx, 'Billing Viewer');
  outsider = await registerUser(ctx, 'Billing Outsider');
  org = await createOrg(ctx, owner, { name: 'Shivneri Consulting' });
  await createOrg(ctx, outsider, { name: 'Other Org' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  for (const n of ['Nair Logistics', 'Pawar Foods', 'Rao Textiles', 'Desai Retail', 'Monthly Client']) c[n] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: n, isCustomer: true }).expect(201)).body;

  // An order billed on delivery, 40 days old, 4 of 10 billed.
  const o = (await ctx.http().post(`${org.base}/sales/orders`).set(owner.auth).send({ contactId: c['Nair Logistics']!.id, orderDate: addDays(T, -40), lines: [line('1000.00', '10')] }).expect(201)).body;
  ids.order = o.id;
  const part = (await ctx.http().post(`${org.base}/sales/orders/${o.id}/invoices`).set(owner.auth).send({ issueDate: addDays(T, -35), lines: [{ orderLineId: o.lines[0].id, quantity: '4' }] }).expect(201)).body;
  await ctx.http().post(`${org.base}/sales/documents/${part.documentId}/post`).set(owner.auth).send({}).expect(200);
  // A fresh order is not flagged yet.
  ids.freshOrder = (await ctx.http().post(`${org.base}/sales/orders`).set(owner.auth).send({ contactId: c['Nair Logistics']!.id, orderDate: T, lines: [line('500.00')] }).expect(201)).body.id;

  // An order billed by milestones: the first completed, not invoiced.
  const m = (await ctx.http().post(`${org.base}/sales/orders`).set(owner.auth).send({ contactId: c['Pawar Foods']!.id, orderDate: T, lines: [line('200000.00')] }).expect(201)).body;
  await ctx.http().put(`${org.base}/sales/orders/${m.id}/billing-method`).set(owner.auth).send({ method: 'MILESTONES' }).expect(200);
  const ms = (await ctx.http().put(`${org.base}/sales/orders/${m.id}/milestones`).set(owner.auth).send({ milestones: [{ name: 'Design signed off', percent: '30' }, { name: 'Go-live', percent: '70' }] }).expect(200)).body.milestones;
  ids.milestone = ms[0].id;
  await ctx.http().post(`${org.base}/sales/orders/${m.id}/milestones/${ms[0].id}/complete`).set(owner.auth).send({ done: true }).expect(200);

  // A draft invoice dated 10 days ago, and one from today.
  ids.draft = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: c['Rao Textiles']!.id, issueDate: addDays(T, -10), lines: [line('7500.00')] }).expect(201)).body.id;
  await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: c['Rao Textiles']!.id, issueDate: T, lines: [line('100.00')] }).expect(201);

  // A pro forma issued, then run out without an invoice.
  const pf = (await ctx.http().post(`${org.base}/sales/pro-formas`).set(owner.auth).send({ contactId: c['Desai Retail']!.id, issueDate: addDays(T, -20), validUntil: addDays(T, 5), lines: [line('12000.00')] }).expect(201)).body;
  // Issued long ago: dated back while still a draft (an issued pro forma is fixed).
  await raw(`UPDATE pro_forma_invoices SET valid_until = $2::date WHERE id = $1::uuid`, pf.id, addDays(T, -2));
  await ctx.http().post(`${org.base}/sales/pro-formas/${pf.id}/issue`).set(owner.auth).expect(200);
  ids.proForma = pf.id;

  // An active monthly contract whose billing did not run: two periods due.
  ids.contract = randomUUID();
  await raw(
    `INSERT INTO sales_contracts (id, org_id, number, contact_id, title, status, frequency, timing, start_date, currency, subtotal, tax_total, total, created_by_id, updated_at, activated_at, last_error)
     VALUES ($1::uuid, $2::uuid, 1, $3::uuid, 'Support retainer', 'ACTIVE', 'MONTHLY', 'ADVANCE', $4::date, 'INR', 30000, 0, 30000, $5::uuid, now(), now(), 'Account 4100 is archived')`,
    ids.contract,
    org.orgId,
    c['Desai Retail']!.id,
    `${month(-1)}-01`,
    owner.id,
  );

  // A customer invoiced in each of the three months before last month, not last month.
  for (const k of [-4, -3, -2]) await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: c['Monthly Client']!.id, issueDate: `${month(k)}-05`, lines: [line('9000.00')], post: true }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('unbilled revenue', () => {
  it('finds each source from the real records', async () => {
    const r = await report();
    expect(r.asOf).toBe(T);
    expect(find(r, 'ORDER', ids.order!)).toMatchObject({ amount: '6000.00', currency: 'INR', confidence: 'LIKELY', customer: 'Nair Logistics', since: addDays(T, -40), ageDays: 40, path: `/sales/orders/${ids.order}` });
    expect(String(find(r, 'ORDER', ids.order!)!.detail)).toMatch(/is partly billed more than 30 days on/);
    expect(find(r, 'ORDER', ids.freshOrder!)).toBeUndefined();
    expect(find(r, 'MILESTONE', ids.milestone!)).toMatchObject({ amount: '60000.00', confidence: 'CERTAIN', customer: 'Pawar Foods', since: T });
    expect(find(r, 'DRAFT_INVOICE', ids.draft!)).toMatchObject({ amount: '7500.00', since: addDays(T, -10), path: `/sales/invoices/${ids.draft}` });
    expect(r.findings.filter((f: { source: string }) => f.source === 'DRAFT_INVOICE')).toHaveLength(1);
    expect(find(r, 'PRO_FORMA', ids.proForma!)).toMatchObject({ amount: '12000.00', label: 'PF-0001', path: `/sales/pro-formas/${ids.proForma}` });
    const ct = find(r, 'CONTRACT_PERIOD', ids.contract!)!;
    expect(ct).toMatchObject({ amount: '60000.00', since: `${month(-1)}-01`, label: 'CT-0001 Support retainer' });
    expect(String(ct.detail)).toMatch(/^2 periods .* were due for invoicing and have no invoice\. The last attempt failed: Account 4100 is archived$/);
    // Desai Retail is already flagged; the monthly client is not, and is missed last month.
    expect(find(r, 'REGULAR_CUSTOMER', c['Monthly Client']!.id)).toMatchObject({ amount: '9000.00', confidence: 'POSSIBLE', label: `No invoice in ${month(-1)}` });
    expect(r.findings.map((f: { source: string }) => f.source)).toEqual(['MILESTONE', 'CONTRACT_PERIOD', 'DRAFT_INVOICE', 'ORDER', 'PRO_FORMA', 'REGULAR_CUSTOMER']);
    expect(r.totals).toEqual([{ currency: 'INR', amount: '154500.00', count: 6, bySource: { MILESTONE: '60000.00', CONTRACT_PERIOD: '60000.00', DRAFT_INVOICE: '7500.00', ORDER: '6000.00', PRO_FORMA: '12000.00', REGULAR_CUSTOMER: '9000.00' } }]);
    expect(r.counts).toEqual({ open: 6, dismissed: 0 });
    await ctx.http().get(U()).set(outsider.auth).expect(404);
  });

  it('dismisses with a reason, keeps it as recorded, and brings it back when it grows', async () => {
    const D = `${U()}/dismissals`;
    const fp = `ORDER:${ids.order}`;
    await ctx.http().post(D).set(viewer.auth).send({ fingerprint: fp, action: 'DISMISS', reason: 'Rest is on hold' }).expect(403);
    await ctx.http().post(D).set(owner.auth).send({ fingerprint: fp, action: 'DISMISS', reason: 'no' }).expect(400);
    expect((await ctx.http().post(D).set(owner.auth).send({ fingerprint: `ORDER:${ids.freshOrder}`, action: 'DISMISS', reason: 'Not due' }).expect(404)).body.message).toMatch(/no longer there/);
    expect((await ctx.http().post(D).set(owner.auth).send({ fingerprint: fp, action: 'RESTORE', reason: 'Back' }).expect(409)).body.message).toBe('This finding is not dismissed');
    const r = (await ctx.http().post(D).set(owner.auth).send({ fingerprint: fp, action: 'DISMISS', reason: 'Remaining six cartons are on hold at the customer request' }).expect(200)).body;
    expect(find(r, 'ORDER', ids.order!)!.dismissed).toEqual({ reason: 'Remaining six cartons are on hold at the customer request', by: 'Billing Owner', at: T, amount: '6000.00' });
    expect(r.counts).toEqual({ open: 5, dismissed: 1 });
    expect(r.totals[0].amount).toBe('148500.00');
    expect((await ctx.http().post(D).set(owner.auth).send({ fingerprint: fp, action: 'DISMISS', reason: 'Again' }).expect(409)).body.message).toBe('This finding is already dismissed');
    await expect(raw(`UPDATE unbilled_revenue_dismissals SET reason = 'x' WHERE org_id = $1::uuid`, org.orgId)).rejects.toThrow(/kept as recorded/);
    await expect(raw(`DELETE FROM unbilled_revenue_dismissals WHERE org_id = $1::uuid`, org.orgId)).rejects.toThrow(/kept as recorded/);

    // The contract finding grows when another period falls due; a dismissal at the old amount no longer hides it.
    const cfp = `CONTRACT_PERIOD:${ids.contract}`;
    await ctx.http().post(D).set(owner.auth).send({ fingerprint: cfp, action: 'DISMISS', reason: 'Billing by hand this quarter' }).expect(200);
    await raw(`INSERT INTO unbilled_revenue_dismissals (org_id, fingerprint, action, amount, currency, reason, by_id) VALUES ($1::uuid, $2, 'DISMISS', 30000, 'INR', 'Dismissed when one period was due', $3::uuid)`, org.orgId, cfp, owner.id);
    expect(find(await report(), 'CONTRACT_PERIOD', ids.contract!)!.dismissed).toBeNull();

    const back = (await ctx.http().post(D).set(owner.auth).send({ fingerprint: fp, action: 'RESTORE', reason: 'Customer released the hold' }).expect(200)).body;
    expect(find(back, 'ORDER', ids.order!)!.dismissed).toBeNull();
    const audit = await ctx.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
      return tx.auditEvent.findMany({ where: { orgId: org.orgId, action: { startsWith: 'unbilled_revenue.' } }, orderBy: { createdAt: 'asc' } });
    });
    expect(audit.map((a) => a.action)).toEqual(['unbilled_revenue.dismissed', 'unbilled_revenue.dismissed', 'unbilled_revenue.restored']);
  });

  it('drops a finding once it is billed', async () => {
    await ctx.http().post(`${org.base}/sales/documents/${ids.draft}/post`).set(owner.auth).send({}).expect(200);
    expect(find(await report(), 'DRAFT_INVOICE', ids.draft!)).toBeUndefined();
  });
});
