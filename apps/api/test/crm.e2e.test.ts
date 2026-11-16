import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';
import { sqlWrite } from './sql-writes';

/**
 * CRM slice 1 against the real API and database: leads through their statuses, duplicates by
 * email, conversion into a new or existing customer with a deal, deals through the pipeline
 * stages (won, lost with a reason, reopened), the pipeline summary, the activity timeline,
 * permissions, tenant isolation and the database guards.
 */
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.parse(`${T}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let customerId: string;
let vendorId: string;

const raw = (sql: string, ...args: unknown[]) => sqlWrite(ctx, sql, args, { bypass: true });

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Pipeline Owner');
  accountant = await registerUser(ctx, 'Sales Accountant');
  viewer = await registerUser(ctx, 'Pipeline Viewer');
  outsider = await registerUser(ctx, 'Pipeline Outsider');
  org = await createOrg(ctx, owner, { name: 'Pipeline Traders Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Elsewhere Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: accountant.email, role: 'ACCOUNTANT' }).expect(201);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  customerId = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Existing Customer Ltd', email: 'accounts@existing.example', isCustomer: true }).expect(201)).body.id;
  vendorId = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Only A Vendor', isVendor: true }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx.app.close();
});

describe('leads', () => {
  let leadId: string;
  it('are created with an owner, numbered, and listed with counts', async () => {
    const r = await ctx.http().post(`${org.base}/crm/leads`).set(accountant.auth).send({ name: 'Priya Nair', company: 'Nair Logistics', email: ' Priya@Nair.example ', phone: '+91 98450 00000', source: 'REFERRAL', estimatedValue: '450000.00' }).expect(201);
    leadId = r.body.id;
    expect(r.body).toMatchObject({ reference: expect.stringMatching(/^LD-\d{4}$/), status: 'NEW', email: 'priya@nair.example', estimatedValue: '450000.00', owner: { id: accountant.id, name: 'Sales Accountant' } });
    expect(r.body.activities).toHaveLength(1);
    expect(r.body.activities[0]).toMatchObject({ kind: 'CREATED', actor: { name: 'Sales Accountant' } });
    const list = (await ctx.http().get(`${org.base}/crm/leads`).set(viewer.auth).expect(200)).body;
    expect(list.counts).toMatchObject({ NEW: 1, QUALIFIED: 0 });
    expect(list.openEstimatedValue).toBe('450000.00');
    expect(list.can.manage).toBe(false);
  });

  it('refuse bad input and owners who are not members', async () => {
    const bad = await ctx.http().post(`${org.base}/crm/leads`).set(owner.auth).send({ name: ' ', source: 'WEBSITE' }).expect(400);
    expect(JSON.stringify(bad.body)).toContain('Give the lead a name');
    const notMember = await ctx.http().post(`${org.base}/crm/leads`).set(owner.auth).send({ name: 'X', source: 'WEBSITE', ownerId: outsider.id }).expect(422);
    expect(notMember.body.error).toBe('CRM_OWNER_NOT_MEMBER');
    const cents = await ctx.http().post(`${org.base}/crm/leads`).set(owner.auth).send({ name: 'X', source: 'WEBSITE', estimatedValue: '10.123' }).expect(422);
    expect(cents.body.message).toContain('2 decimal places');
  });

  it('move through statuses; disqualifying needs a reason; converting needs qualification', async () => {
    const base = `${org.base}/crm/leads/${leadId}`;
    expect((await ctx.http().post(`${base}/convert`).set(owner.auth).send({}).expect(422)).body.error).toBe('LEAD_NOT_QUALIFIED');
    await ctx.http().post(`${base}/status`).set(owner.auth).send({ status: 'CONTACTED' }).expect(201);
    expect((await ctx.http().post(`${base}/status`).set(owner.auth).send({ status: 'DISQUALIFIED' }).expect(422)).body.error).toBe('LEAD_REASON_REQUIRED');
    const d = await ctx.http().post(`${base}/status`).set(owner.auth).send({ status: 'DISQUALIFIED', reason: 'No budget this year' }).expect(201);
    expect(d.body).toMatchObject({ status: 'DISQUALIFIED', disqualifiedReason: 'No budget this year' });
    expect((await ctx.http().post(`${base}/status`).set(owner.auth).send({ status: 'QUALIFIED' }).expect(422)).body.error).toBe('LEAD_REOPEN_FIRST');
    await ctx.http().post(`${base}/status`).set(owner.auth).send({ status: 'CONTACTED' }).expect(201);
    const q = await ctx.http().post(`${base}/status`).set(owner.auth).send({ status: 'QUALIFIED' }).expect(201);
    expect(q.body).toMatchObject({ status: 'QUALIFIED', disqualifiedReason: null });
    expect(q.body.activities.filter((a: { kind: string }) => a.kind === 'STATUS_CHANGED')).toHaveLength(4);
  });

  it('log activities and record what an edit changed', async () => {
    await ctx.http().post(`${org.base}/crm/activities`).set(owner.auth).send({ leadId, kind: 'CALL', body: 'Called Priya: wants a demo next week.' }).expect(201);
    expect((await ctx.http().post(`${org.base}/crm/activities`).set(owner.auth).send({ leadId, dealId: leadId, kind: 'NOTE', body: 'x' }).expect(422)).body.error).toBe('CRM_ACTIVITY_TARGET');
    const u = await ctx.http().put(`${org.base}/crm/leads/${leadId}`).set(owner.auth).send({ name: 'Priya Nair', company: 'Nair Logistics', email: 'priya@nair.example', phone: '+91 98450 00000', source: 'REFERRAL', ownerId: owner.id, estimatedValue: '500000' }).expect(200);
    expect(u.body.estimatedValue).toBe('500000.00');
    expect(u.body.activities[0]).toMatchObject({ kind: 'UPDATED', data: { fields: ['ownerId', 'estimatedValue'] } });
    expect(u.body.activities.find((a: { kind: string }) => a.kind === 'CALL').body).toContain('demo');
  });

  it('convert once into a new customer with a deal at qualification', async () => {
    const r = await ctx.http().post(`${org.base}/crm/leads/${leadId}/convert`).set(owner.auth).send({ deal: { name: 'Nair Logistics: annual books', amount: '480000.00', expectedCloseDate: plusDays(30) } }).expect(201);
    expect(r.body).toMatchObject({ status: 'CONVERTED', convertedContact: { name: 'Nair Logistics' }, convertedDeal: { stage: 'QUALIFICATION' } });
    // Its own new customer is not reported as a duplicate.
    expect(r.body.duplicates.contacts).toEqual([]);
    const c = (await ctx.http().get(`${org.base}/contacts/${r.body.convertedContact.id}`).set(owner.auth).expect(200)).body;
    expect(c).toMatchObject({ isCustomer: true, email: 'priya@nair.example' });
    const deal = (await ctx.http().get(`${org.base}/crm/deals/${r.body.convertedDeal.id}`).set(owner.auth).expect(200)).body;
    expect(deal).toMatchObject({ amount: '480000.00', probability: 25, weighted: '120000.00', owner: { id: owner.id }, lead: { reference: r.body.reference } });
    expect((await ctx.http().post(`${org.base}/crm/leads/${leadId}/convert`).set(owner.auth).send({}).expect(422)).body.error).toBe('LEAD_CONVERTED');
    expect((await ctx.http().put(`${org.base}/crm/leads/${leadId}`).set(owner.auth).send({ name: 'Changed', source: 'OTHER' }).expect(422)).body.error).toBe('LEAD_CONVERTED');
    // The timeline still grows after conversion.
    await ctx.http().post(`${org.base}/crm/activities`).set(owner.auth).send({ leadId, kind: 'NOTE', body: 'Handed over to the deal.' }).expect(201);
  });

  it('flag duplicates by email and convert into an existing contact, marking it a customer', async () => {
    const dup = (await ctx.http().post(`${org.base}/crm/leads`).set(owner.auth).send({ name: 'Accounts team', email: 'ACCOUNTS@existing.example', source: 'WEBSITE' }).expect(201)).body;
    expect(dup.duplicates.contacts).toEqual([expect.objectContaining({ id: customerId, name: 'Existing Customer Ltd' })]);
    const v = (await ctx.http().post(`${org.base}/crm/leads`).set(owner.auth).send({ name: 'Vendor turning customer', source: 'PARTNER' }).expect(201)).body;
    await ctx.http().post(`${org.base}/crm/leads/${v.id}/status`).set(owner.auth).send({ status: 'QUALIFIED' }).expect(201);
    const r = await ctx.http().post(`${org.base}/crm/leads/${v.id}/convert`).set(owner.auth).send({ contactId: vendorId }).expect(201);
    expect(r.body).toMatchObject({ status: 'CONVERTED', convertedContact: { id: vendorId }, convertedDeal: null });
    expect((await ctx.http().get(`${org.base}/contacts/${vendorId}`).set(owner.auth).expect(200)).body).toMatchObject({ isCustomer: true, isVendor: true });
  });
});

describe('deals', () => {
  let dealId: string;
  it('need a customer, start at an open stage and take its probability', async () => {
    expect((await ctx.http().post(`${org.base}/crm/deals`).set(owner.auth).send({ name: 'Wrong', contactId: other.orgId, amount: '1', expectedCloseDate: T }).expect(422)).body.error).toBe('CRM_CUSTOMER_NOT_FOUND');
    expect((await ctx.http().post(`${org.base}/crm/deals`).set(owner.auth).send({ name: 'Won already', contactId: customerId, amount: '1', expectedCloseDate: T, stage: 'WON' }).expect(422)).body.error).toBe('DEAL_STAGE');
    await ctx.http().post(`${org.base}/crm/deals`).set(owner.auth).send({ name: 'Bad date', contactId: customerId, amount: '1', expectedCloseDate: '2026-02-30' }).expect(400);
    const r = await ctx.http().post(`${org.base}/crm/deals`).set(accountant.auth).send({ name: 'Payroll outsourcing', contactId: customerId, amount: '200000.00', expectedCloseDate: plusDays(-3), stage: 'PROPOSAL' }).expect(201);
    dealId = r.body.id;
    expect(r.body).toMatchObject({ reference: expect.stringMatching(/^DL-\d{4}$/), stage: 'PROPOSAL', probability: 50, weighted: '100000.00', overdue: true, contact: { name: 'Existing Customer Ltd' }, owner: { id: accountant.id } });
  });

  it('summarise the pipeline by stage with weighted value and close months', async () => {
    const p = (await ctx.http().get(`${org.base}/crm/deals`).set(viewer.auth).expect(200)).body;
    expect(p.deals.map((d: { name: string }) => d.name).sort()).toEqual(['Nair Logistics: annual books', 'Payroll outsourcing']);
    expect(p.summary.open).toEqual({ count: 2, amount: '680000.00', weighted: '220000.00' });
    expect(p.summary.stages.find((s: { stage: string }) => s.stage === 'QUALIFICATION')).toMatchObject({ count: 1, weighted: '120000.00' });
    expect(p.summary.overdue).toEqual({ count: 1, amount: '200000.00' });
    expect(p.byCloseMonth.months).toHaveLength(6);
    expect(p.byCloseMonth.months[0].weighted).not.toBe('0.00');
  });

  it('move through stages, win at 100%, lose with a reason, and reopen', async () => {
    const base = `${org.base}/crm/deals/${dealId}`;
    const n = await ctx.http().post(`${base}/stage`).set(owner.auth).send({ stage: 'NEGOTIATION', probability: 80 }).expect(201);
    expect(n.body).toMatchObject({ stage: 'NEGOTIATION', probability: 80, weighted: '160000.00' });
    expect((await ctx.http().post(`${base}/stage`).set(owner.auth).send({ stage: 'NEGOTIATION', probability: 80 }).expect(422)).body.error).toBe('DEAL_SAME_STAGE');
    expect((await ctx.http().post(`${base}/stage`).set(owner.auth).send({ stage: 'NEGOTIATION', probability: 70 }).expect(201)).body.probability).toBe(70);
    expect((await ctx.http().post(`${base}/stage`).set(owner.auth).send({ stage: 'LOST' }).expect(422)).body.error).toBe('DEAL_REASON_REQUIRED');
    const lost = await ctx.http().post(`${base}/stage`).set(owner.auth).send({ stage: 'LOST', lostReason: 'Went with an in-house team' }).expect(201);
    expect(lost.body).toMatchObject({ stage: 'LOST', probability: 0, closedOn: T, lostReason: 'Went with an in-house team', overdue: false });
    expect((await ctx.http().put(base).set(owner.auth).send({ name: 'Payroll outsourcing', contactId: customerId, amount: '1.00', expectedCloseDate: plusDays(-3) }).expect(422)).body.error).toBe('DEAL_CLOSED');
    const re = await ctx.http().post(`${base}/stage`).set(owner.auth).send({ stage: 'NEGOTIATION' }).expect(201);
    expect(re.body).toMatchObject({ stage: 'NEGOTIATION', probability: 75, closedOn: null, lostReason: null });
    const u = await ctx.http().put(base).set(owner.auth).send({ name: 'Payroll outsourcing', contactId: customerId, amount: '240000.00', expectedCloseDate: plusDays(10), ownerId: owner.id }).expect(200);
    expect(u.body.activities[0]).toMatchObject({ kind: 'UPDATED', data: { amount: { from: '200000.00', to: '240000.00' } } });
    const won = await ctx.http().post(`${base}/stage`).set(owner.auth).send({ stage: 'WON' }).expect(201);
    expect(won.body).toMatchObject({ stage: 'WON', probability: 100, closedOn: T });
    const kinds = won.body.activities.map((a: { kind: string; data: { reopened?: boolean } }) => a.kind);
    expect(kinds.filter((k: string) => k === 'STAGE_CHANGED')).toHaveLength(5);
    expect(won.body.activities.some((a: { data: { reopened?: boolean } }) => a.data?.reopened)).toBe(true);
    const p = (await ctx.http().get(`${org.base}/crm/deals?view=all`).set(owner.auth).expect(200)).body;
    expect(p.summary.window).toMatchObject({ won: 1, lost: 0, wonAmount: '240000.00', winRate: 100 });
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=crm_deal&entityId=${dealId}`).set(owner.auth).expect(200)).body;
    const actions = (audit.items ?? audit).map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['crm.deal.created', 'crm.deal.lost', 'crm.deal.reopened', 'crm.deal.won', 'crm.deal.updated']));
  });

  it('list one customer’s deals', async () => {
    const p = (await ctx.http().get(`${org.base}/crm/deals?contactId=${customerId}&view=all`).set(owner.auth).expect(200)).body;
    expect(p.deals).toHaveLength(1);
    expect(p.deals[0].stage).toBe('WON');
  });
});

describe('access', () => {
  it('lets viewers read but not change, and keeps other organisations out', async () => {
    await ctx.http().post(`${org.base}/crm/leads`).set(viewer.auth).send({ name: 'Nope', source: 'OTHER' }).expect(403);
    await ctx.http().post(`${org.base}/crm/activities`).set(viewer.auth).send({ kind: 'NOTE', body: 'x', leadId: customerId }).expect(403);
    await ctx.http().get(`${org.base}/crm/leads`).set(outsider.auth).expect(404);
    const mine = (await ctx.http().get(`${org.base}/crm/deals?view=all`).set(owner.auth).expect(200)).body.deals[0];
    await ctx.http().get(`${other.base}/crm/deals/${mine.id}`).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/crm/deals?view=all`).set(outsider.auth).expect(200)).body.deals).toEqual([]);
    const owners = (await ctx.http().get(`${org.base}/crm/owners`).set(viewer.auth).expect(200)).body;
    expect(owners.map((o: { name: string }) => o.name)).toEqual(['Pipeline Owner', 'Sales Accountant', 'Pipeline Viewer']);
  });

  it('never deletes leads, deals or activities, and freezes converted leads', async () => {
    await expect(raw(`DELETE FROM crm_leads WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/never deleted/);
    await expect(raw(`DELETE FROM crm_deals WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/never deleted/);
    await expect(raw(`UPDATE crm_activities SET body = 'x' WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/append-only/);
    await expect(raw(`UPDATE crm_leads SET name = 'x' WHERE org_id = '${org.orgId}' AND status = 'CONVERTED'`)).rejects.toThrow(/converted lead/);
    await expect(raw(`UPDATE crm_deals SET probability = 50 WHERE org_id = '${org.orgId}' AND stage = 'WON'`)).rejects.toThrow(/crm_deals_chk/);
  });
});
