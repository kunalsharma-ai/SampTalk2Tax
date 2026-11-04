import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';
import { todayIst } from '../src/cash-flow/cash-flow.service';

/**
 * The financial recovery planner against the real API and database: options worked out from
 * overdue invoices, supplier bills and cost lines, plans with owners, due dates and progress,
 * the forecast of a plan, copying a plan into a twin scenario, permissions, tenant isolation,
 * the audit trail, and proof that nothing is posted, paid or borrowed.
 */
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let outsider: TestUser;
type Org = Awaited<ReturnType<typeof createOrg>>;
let org: Org;
let other: Org;
let lastMonth: string;
let planId: string;
const actions: Record<string, string> = {};
let journalsBefore = 0;

const shift = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + m - 1 + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const journal = (debit: string, credit: string, amount: string, memo: string) =>
  ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: `${lastMonth}-15`, post: true, memo, lines: [{ accountId: org.acc[debit], debit: amount }, { accountId: org.acc[credit], credit: amount }] }).expect(201);
const journalCount = () => ctx.prisma.journalEntry.count({ where: { orgId: org.orgId } });

beforeAll(async () => {
  ctx = await bootApp();
  lastMonth = shift(todayIst().slice(0, 7), -1);
  owner = await registerUser(ctx, 'Recovery Owner');
  accountant = await registerUser(ctx, 'Recovery Accountant');
  viewer = await registerUser(ctx, 'Recovery Viewer');
  outsider = await registerUser(ctx, 'Recovery Outsider');
  org = await createOrg(ctx, owner, { name: 'Recovery Co' });
  other = await createOrg(ctx, outsider, { name: 'Other Recovery Co' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  const contact = async (name: string, kind: 'isCustomer' | 'isVendor') => (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, [kind]: true }).expect(201)).body.id as string;
  const acme = await contact('Acme Retail', 'isCustomer');
  const beta = await contact('Beta Stores', 'isCustomer');
  const parts = await contact('Granite Parts', 'isVendor');
  const invoice = (contactId: string, amount: string, due: string) =>
    ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId, issueDate: `${lastMonth}-01`, dueDate: due, post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] }).expect(201);
  await invoice(acme, '200000.00', `${lastMonth}-10`);
  await invoice(beta, '100000.00', `${lastMonth}-20`);
  await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: parts, issueDate: `${lastMonth}-05`, reference: 'GP-1', post: true, lines: [{ accountId: org.acc['5000'], quantity: '1', unitPrice: '120000.00' }] }).expect(201);
  await journal('1120', '3100', '500000.00', 'Capital');
  await journal('6100', '1120', '300000.00', 'Salaries');
  await journal('6200', '1120', '30000.00', 'Rent');
  await journal('6500', '1120', '20000.00', 'Marketing');
  journalsBefore = await journalCount();
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('recovery planner', () => {
  it('works out options from the books, each measured against taking no action', async () => {
    const r = (await ctx.http().get(`${org.base}/recovery/options?baselineMonths=3&horizonMonths=12`).set(viewer.auth).expect(200)).body;
    expect(r.currency).toBe('INR');
    expect(r.noAction.cashNegativeFrom).not.toBeNull();
    expect(Number(r.noAction.cashRequired)).toBeGreaterThan(0);
    const keys = r.options.map((o: { key: string }) => o.key);
    expect(keys).toEqual(expect.arrayContaining(['COLLECT_OVERDUE', 'EXTEND_SUPPLIER_TERMS', 'SUPPLIER_DISCOUNT', 'CUT_6200', 'CUT_6500', 'SPENDING_FREEZE', 'BRIDGE_LOAN', 'OWNER_FUNDING', 'PRICE_RISE', 'PAYROLL_REDUCTION']));
    const opt = (k: string) => r.options.find((o: { key: string }) => o.key === k);
    // Both invoices are overdue, the larger first.
    expect(opt('COLLECT_OVERDUE').targets.map((t: { name: string; amount: string }) => [t.name, t.amount])).toEqual([['Acme Retail', '200000.00'], ['Beta Stores', '100000.00']]);
    expect(Number(opt('COLLECT_OVERDUE').effect.minimumCash)).toBeGreaterThan(0);
    // The bill of 120,000 over three baseline months is 40,000 a month of purchases.
    expect(opt('EXTEND_SUPPLIER_TERMS').targets[0]).toMatchObject({ name: 'Granite Parts', amount: '40000.00' });
    // Rent of 30,000 over three months is 10,000 a month; a fifth of it is 2,000.
    expect(opt('CUT_6200').drivers[0]).toMatchObject({ kind: 'EXPENSE_CHANGE', monthlyAmount: '-2000.00' });
    expect(opt('CUT_6200').effect.netProfit).toBe('24000.00');
    expect(opt('BRIDGE_LOAN').effect.cashNegativeFrom).toBeNull();
    expect(opt('PAYROLL_REDUCTION').needsDecision).toBe(true);
    await ctx.http().get(`${org.base}/recovery/options?baselineMonths=4`).set(viewer.auth).expect(400);
  });

  it('builds a plan from options; only people who manage scenarios can change it', async () => {
    const body = { name: 'Get back above water', description: 'Q3 cash plan', baselineMonths: 3, horizonMonths: 12 };
    await ctx.http().post(`${org.base}/recovery/plans`).set(viewer.auth).send(body).expect(403);
    planId = (await ctx.http().post(`${org.base}/recovery/plans`).set(accountant.auth).send(body).expect(201)).body.id;
    await ctx.http().post(`${org.base}/recovery/plans`).set(owner.auth).send(body).expect(409);
    for (const k of ['COLLECT_OVERDUE', 'CUT_6500', 'BRIDGE_LOAN', 'PRICE_RISE']) {
      actions[k] = (await ctx.http().post(`${org.base}/recovery/plans/${planId}/actions`).set(accountant.auth).send({ optionKey: k }).expect(201)).body.id;
    }
    await ctx.http().post(`${org.base}/recovery/plans/${planId}/actions`).set(accountant.auth).send({ optionKey: 'CUT_6500' }).expect(409);
    expect((await ctx.http().post(`${org.base}/recovery/plans/${planId}/actions`).set(accountant.auth).send({ optionKey: 'CUT_9999' }).expect(422)).body.error).toBe('OPTION_NOT_AVAILABLE');
    await ctx.http().post(`${org.base}/recovery/plans/${planId}/actions`).set(viewer.auth).send({ optionKey: 'CUT_6200' }).expect(403);

    const d = (await ctx.http().get(`${org.base}/recovery/plans/${planId}`).set(viewer.auth).expect(200)).body;
    expect(d.plan).toMatchObject({ name: 'Get back above water', status: 'DRAFT' });
    expect(d.actions.map((a: { optionKey: string }) => a.optionKey)).toEqual(['COLLECT_OVERDUE', 'CUT_6500', 'BRIDGE_LOAN', 'PRICE_RISE']);
    expect(d.options.map((o: { key: string }) => o.key)).not.toContain('CUT_6500');
    expect(d.forecast.gapClosed).toBe(true);
    expect(d.forecast.withPlan.runwayMonths).toBeNull();
    expect(Number(d.forecast.effect.closingCash)).toBeGreaterThan(0);
    expect(d.forecast.noAction.cash).toHaveLength(12);
    expect(d.stale).toEqual([]);
  });

  it('tracks owners, due dates and progress; dropped actions leave the forecast', async () => {
    const a = actions.BRIDGE_LOAN!;
    const u = (await ctx.http().put(`${org.base}/recovery/plans/${planId}/actions/${a}`).set(accountant.auth).send({ ownerId: owner.id, dueDate: '2026-12-15', status: 'IN_PROGRESS', note: 'Talk to the bank' }).expect(200)).body;
    expect(u).toMatchObject({ ownerId: owner.id, dueDate: '2026-12-15', status: 'IN_PROGRESS', note: 'Talk to the bank' });
    await ctx.http().put(`${org.base}/recovery/plans/${planId}/actions/${a}`).set(accountant.auth).send({ ownerId: outsider.id }).expect(422);
    await ctx.http().put(`${org.base}/recovery/plans/${planId}/actions/${a}`).set(accountant.auth).send({ dueDate: '15/12/2026' }).expect(400);
    const before = (await ctx.http().get(`${org.base}/recovery/plans/${planId}`).set(viewer.auth).expect(200)).body;
    expect(before.owners[owner.id]).toBe('Recovery Owner');
    await ctx.http().put(`${org.base}/recovery/plans/${planId}/actions/${a}`).set(accountant.auth).send({ status: 'DROPPED' }).expect(200);
    const after = (await ctx.http().get(`${org.base}/recovery/plans/${planId}`).set(viewer.auth).expect(200)).body;
    expect(after.forecast.gapClosed).toBe(false);
    expect(Number(after.forecast.withPlan.closingCash)).toBeLessThan(Number(before.forecast.withPlan.closingCash));
    await ctx.http().put(`${org.base}/recovery/plans/${planId}/actions/${a}`).set(accountant.auth).send({ status: 'PLANNED' }).expect(200);
    await ctx.http().delete(`${org.base}/recovery/plans/${planId}/actions/${actions.PRICE_RISE}`).set(accountant.auth).expect(200);
    expect((await ctx.http().get(`${org.base}/recovery/plans`).set(viewer.auth).expect(200)).body.items[0].actions).toEqual({ planned: 3, inProgress: 0, done: 0, dropped: 0 });
  });

  it('activates, closes and reopens a plan; a closed plan cannot change and an active one cannot be deleted', async () => {
    await ctx.http().put(`${org.base}/recovery/plans/${planId}`).set(owner.auth).send({ status: 'ACTIVE' }).expect(200);
    expect((await ctx.http().delete(`${org.base}/recovery/plans/${planId}`).set(owner.auth).expect(409)).body.error).toBe('PLAN_IN_USE');
    const closed = (await ctx.http().put(`${org.base}/recovery/plans/${planId}`).set(owner.auth).send({ status: 'CLOSED' }).expect(200)).body;
    expect(closed.closedAt).not.toBeNull();
    expect((await ctx.http().put(`${org.base}/recovery/plans/${planId}/actions/${actions.CUT_6500}`).set(owner.auth).send({ status: 'DONE' }).expect(409)).body.error).toBe('PLAN_CLOSED');
    await ctx.http().post(`${org.base}/recovery/plans/${planId}/actions`).set(owner.auth).send({ optionKey: 'CUT_6200' }).expect(409);
    const reopened = (await ctx.http().put(`${org.base}/recovery/plans/${planId}`).set(owner.auth).send({ status: 'ACTIVE' }).expect(200)).body;
    expect(reopened).toMatchObject({ status: 'ACTIVE', closedAt: null });
    await ctx.http().put(`${org.base}/recovery/plans/${planId}/actions/${actions.CUT_6500}`).set(owner.auth).send({ status: 'DONE' }).expect(200);
  });

  it('copies a plan into a digital-twin scenario for the war room', async () => {
    const s = (await ctx.http().post(`${org.base}/recovery/plans/${planId}/scenario`).set(accountant.auth).expect(201)).body;
    expect(s.name).toBe('Recovery: Get back above water');
    const t = (await ctx.http().get(`${org.base}/twin/scenarios/${s.scenarioId}`).set(viewer.auth).expect(200)).body;
    expect(t.scenario.drivers.map((d: { kind: string }) => d.kind)).toEqual(['WORKING_CAPITAL', 'EXPENSE_CHANGE', 'NEW_DEBT']);
    expect(t.scenario.status).toBe('DRAFT');
    // A second copy gets its own name.
    expect((await ctx.http().post(`${org.base}/recovery/plans/${planId}/scenario`).set(accountant.auth).expect(201)).body.name).toBe('Recovery: Get back above water (2)');
  });

  it('never posts, pays or borrows, keeps plans to their organisation, and is audited', async () => {
    expect(await journalCount()).toBe(journalsBefore);
    expect(await ctx.prisma.payment.count({ where: { orgId: org.orgId } })).toBe(0);
    expect(await ctx.prisma.loan.count({ where: { orgId: org.orgId } })).toBe(0);
    await ctx.http().get(`${other.base}/recovery/plans/${planId}`).set(outsider.auth).expect(404);
    await ctx.http().put(`${other.base}/recovery/plans/${planId}/actions/${actions.CUT_6500}`).set(outsider.auth).send({ status: 'DONE' }).expect(404);
    expect((await ctx.http().get(`${other.base}/recovery/plans`).set(outsider.auth).expect(200)).body.items).toEqual([]);
    await ctx.http().get(`${org.base}/recovery/plans`).set(outsider.auth).expect(404);
    const draft = (await ctx.http().post(`${org.base}/recovery/plans`).set(owner.auth).send({ name: 'Scratch', baselineMonths: 6, horizonMonths: 6 }).expect(201)).body.id;
    await ctx.http().delete(`${org.base}/recovery/plans/${draft}`).set(owner.auth).expect(200);
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=recovery_plan&limit=100`).set(owner.auth).expect(200)).body;
    const names = (Array.isArray(audit) ? audit : audit.items).map((e: { action: string }) => e.action);
    expect(names).toEqual(expect.arrayContaining(['recovery_plan.created', 'recovery_action.added', 'recovery_action.updated', 'recovery_action.removed', 'recovery_plan.activated', 'recovery_plan.closed', 'recovery_plan.deleted']));
  });
});
