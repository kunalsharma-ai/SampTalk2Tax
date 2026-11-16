import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';
import { todayIst } from '../src/cash-flow/cash-flow.service';

/**
 * The scenario war room against the real API and database: measured impact of each change and
 * by department, suggested remedies, versions with restore, the approval flow (submit, withdraw,
 * approve, reject, reopen, no self-approval, frozen while waiting or approved), notes pinned to
 * a month or a change, permissions and tenant isolation.
 */
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let approver: TestUser;
let viewer: TestUser;
type Org = Awaited<ReturnType<typeof createOrg>>;
let org: Org;
let other: Org;
let lastMonth: string;
let sales: string;
let ops: string;
let id: string;
let noteId: string;

const shift = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + m - 1 + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const journal = (debit: string, credit: string, amount: string, memo: string) =>
  ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: `${lastMonth}-15`, post: true, memo, lines: [{ accountId: org.acc[debit], debit: amount }, { accountId: org.acc[credit], credit: amount }] }).expect(201);

beforeAll(async () => {
  ctx = await bootApp();
  lastMonth = shift(todayIst().slice(0, 7), -1);
  owner = await registerUser(ctx, 'War Owner');
  accountant = await registerUser(ctx, 'War Accountant');
  approver = await registerUser(ctx, 'War Approver');
  viewer = await registerUser(ctx, 'War Viewer');
  org = await createOrg(ctx, owner, { name: 'War Room Co' });
  other = await createOrg(ctx, viewer, { name: 'Elsewhere Co' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [approver, 'APPROVER'], [viewer, 'VIEWER']] as const) {
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  }
  await journal('1120', '3100', '200000.00', 'Capital');
  await journal('1120', '4100', '300000.00', 'Sales');
  await journal('5000', '1120', '120000.00', 'Stock sold');
  await journal('6100', '1120', '90000.00', 'Salaries');
  await journal('6200', '1120', '30000.00', 'Rent');
  sales = (await ctx.http().post(`${org.base}/dimensions`).set(owner.auth).send({ type: 'DEPARTMENT', code: 'SALES', name: 'Sales' }).expect(201)).body.id;
  ops = (await ctx.http().post(`${org.base}/dimensions`).set(owner.auth).send({ type: 'DEPARTMENT', code: 'OPS', name: 'Operations' }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx?.app.close();
});

const hire = () => ({ kind: 'HIRING', count: 2, monthlyCostPerHead: '50000', fromMonth: 2, departmentId: ops });
const growth = () => ({ kind: 'REVENUE_GROWTH', percentPerMonth: '5', fromMonth: 1, departmentId: sales });
const body = (drivers: unknown[], name = 'Hire and grow') => ({ name, baselineMonths: 3, horizonMonths: 12, drivers });

describe('scenario war room', () => {
  it('measures each change, groups the effect by department and suggests remedies', async () => {
    const r = (await ctx.http().post(`${org.base}/twin/simulate`).set(viewer.auth).send({ baselineMonths: 3, horizonMonths: 12, drivers: [hire(), growth()] }).expect(200)).body;
    const ins = r.insights;
    expect(ins.impacts.map((i: { kind: string; departmentId: string }) => [i.kind, i.departmentId])).toEqual([['HIRING', ops], ['REVENUE_GROWTH', sales]]);
    // Two people at 50,000 a month from month 2: 11 months of 100,000.
    // Totals are rounded separately, so a marginal impact can be a paisa off the exact cost.
    expect(Number(ins.impacts[0].netProfit)).toBeCloseTo(-1100000, 1);
    expect(Number(ins.impacts[1].netProfit)).toBeGreaterThan(0);
    expect(ins.departments.map((d: { departmentId: string }) => d.departmentId).sort()).toEqual([ops, sales].sort());
    // The hiring leaves the company short of cash, so the first remedy is to raise the gap.
    expect(r.projection.cashNegativeFrom).not.toBeNull();
    const codes = ins.suggestions.map((s: { code: string }) => s.code);
    expect(codes).toContain('FUND_GAP');
    const fund = ins.suggestions.find((s: { code: string }) => s.code === 'FUND_GAP');
    expect(fund.drivers[0]).toMatchObject({ kind: 'NEW_DEBT', annualRatePercent: '11', termMonths: 36 });
    expect(fund.effect.cashNegativeFrom).toBeNull();
    // Trying a suggestion is a normal simulation.
    await ctx.http().post(`${org.base}/twin/simulate`).set(viewer.auth).send({ baselineMonths: 3, horizonMonths: 12, drivers: [hire(), growth(), ...fund.drivers] }).expect(200);
    // A department from another organisation is refused in words.
    const theirs = (await ctx.http().post(`${other.base}/dimensions`).set(viewer.auth).send({ type: 'DEPARTMENT', code: 'X', name: 'Theirs' }).expect(201)).body.id;
    const bad = (await ctx.http().post(`${org.base}/twin/simulate`).set(viewer.auth).send({ baselineMonths: 3, horizonMonths: 12, drivers: [{ ...hire(), departmentId: theirs }] }).expect(422)).body;
    expect(bad.details.issues).toEqual(['Change 1: The department was not found']);
  });

  it('keeps every saved version and restores an earlier one as a new version', async () => {
    id = (await ctx.http().post(`${org.base}/twin/scenarios`).set(accountant.auth).send(body([hire()])).expect(201)).body.id;
    const u = (await ctx.http().put(`${org.base}/twin/scenarios/${id}`).set(accountant.auth).send(body([hire(), growth()])).expect(200)).body;
    expect(u).toMatchObject({ version: 2, status: 'DRAFT' });
    // Saving the same inputs again makes no new version.
    expect((await ctx.http().put(`${org.base}/twin/scenarios/${id}`).set(accountant.auth).send(body([hire(), growth()])).expect(200)).body.version).toBe(2);
    const r = (await ctx.http().post(`${org.base}/twin/scenarios/${id}/versions/1/restore`).set(accountant.auth).expect(200)).body;
    expect(r).toMatchObject({ version: 3 });
    expect(r.drivers).toHaveLength(1);
    await ctx.http().post(`${org.base}/twin/scenarios/${id}/versions/3/restore`).set(accountant.auth).expect(422);
    await ctx.http().post(`${org.base}/twin/scenarios/${id}/versions/9/restore`).set(accountant.auth).expect(404);
    await ctx.http().post(`${org.base}/twin/scenarios/${id}/versions/2/restore`).set(viewer.auth).expect(403);
    await ctx.http().put(`${org.base}/twin/scenarios/${id}`).set(accountant.auth).send(body([hire(), growth()])).expect(200);
    const d = (await ctx.http().get(`${org.base}/twin/scenarios/${id}`).set(viewer.auth).expect(200)).body;
    expect(d.versions.map((v: { version: number; reason: string }) => [v.version, v.reason])).toEqual([[4, 'EDITED'], [3, 'RESTORED_FROM_1'], [2, 'EDITED'], [1, 'CREATED']]);
    expect(d.people[accountant.id]).toBe('War Accountant');
    expect(d.result.insights.impacts).toHaveLength(2);
  });

  it('pins notes to a month or a change, and lets the author or a manager resolve them', async () => {
    noteId = (await ctx.http().post(`${org.base}/twin/scenarios/${id}/notes`).set(viewer.auth).send({ body: 'Is month 2 realistic for both hires?', month: 2, changeNumber: 1 }).expect(201)).body.id;
    await ctx.http().post(`${org.base}/twin/scenarios/${id}/notes`).set(viewer.auth).send({ body: 'Too far', month: 13 }).expect(422);
    await ctx.http().post(`${org.base}/twin/scenarios/${id}/notes`).set(viewer.auth).send({ body: 'No such change', changeNumber: 3 }).expect(422);
    await ctx.http().post(`${org.base}/twin/scenarios/${id}/notes`).set(viewer.auth).send({ body: '' }).expect(400);
    const second = (await ctx.http().post(`${org.base}/twin/scenarios/${id}/notes`).set(approver.auth).send({ body: 'Check the growth rate with sales' }).expect(201)).body;
    expect(second).toMatchObject({ version: 4, month: null, changeNumber: null, resolvedAt: null });
    expect((await ctx.http().get(`${org.base}/twin/scenarios`).set(viewer.auth).expect(200)).body.items.find((s: { id: string }) => s.id === id).openNotes).toBe(2);
    // Another reader cannot resolve someone else's note; a manager can; only the author deletes.
    await ctx.http().put(`${org.base}/twin/scenarios/${id}/notes/${second.id}`).set(viewer.auth).send({ resolved: true }).expect(403);
    const res = (await ctx.http().put(`${org.base}/twin/scenarios/${id}/notes/${noteId}`).set(accountant.auth).send({ resolved: true }).expect(200)).body;
    expect(res.resolvedById).toBe(accountant.id);
    await ctx.http().delete(`${org.base}/twin/scenarios/${id}/notes/${second.id}`).set(owner.auth).expect(403);
    await ctx.http().delete(`${org.base}/twin/scenarios/${id}/notes/${second.id}`).set(approver.auth).expect(200);
    expect((await ctx.http().get(`${org.base}/twin/scenarios`).set(viewer.auth).expect(200)).body.items.find((s: { id: string }) => s.id === id).openNotes).toBe(0);
  });

  it('runs the approval: submit, frozen while waiting, no self-approval, reject with a reason, approve, reopen', async () => {
    await ctx.http().post(`${org.base}/twin/scenarios/${id}/submit`).set(viewer.auth).expect(403);
    const s = (await ctx.http().post(`${org.base}/twin/scenarios/${id}/submit`).set(owner.auth).expect(200)).body;
    expect(s).toMatchObject({ status: 'SUBMITTED', submittedById: owner.id });
    await ctx.http().post(`${org.base}/twin/scenarios/${id}/submit`).set(owner.auth).expect(409);
    expect((await ctx.http().put(`${org.base}/twin/scenarios/${id}`).set(accountant.auth).send(body([hire()])).expect(409)).body.error).toBe('SCENARIO_LOCKED');
    await ctx.http().delete(`${org.base}/twin/scenarios/${id}`).set(owner.auth).expect(409);
    // The person who submitted cannot decide, even as owner; an accountant cannot approve at all.
    expect((await ctx.http().post(`${org.base}/twin/scenarios/${id}/approve`).set(owner.auth).send({}).expect(403)).body.error).toBe('SELF_APPROVAL');
    await ctx.http().post(`${org.base}/twin/scenarios/${id}/approve`).set(accountant.auth).send({}).expect(403);
    await ctx.http().post(`${org.base}/twin/scenarios/${id}/reject`).set(approver.auth).send({}).expect(422);
    const rej = (await ctx.http().post(`${org.base}/twin/scenarios/${id}/reject`).set(approver.auth).send({ note: 'Fund the gap first' }).expect(200)).body;
    expect(rej).toMatchObject({ status: 'REJECTED', decidedById: approver.id, decisionNote: 'Fund the gap first' });
    // Editing a rejected scenario returns it to draft with a new version.
    const fund = { kind: 'NEW_DEBT', amount: '1500000', annualRatePercent: '11', termMonths: 36, month: 1 };
    const e = (await ctx.http().put(`${org.base}/twin/scenarios/${id}`).set(accountant.auth).send(body([hire(), growth(), fund])).expect(200)).body;
    expect(e).toMatchObject({ status: 'DRAFT', version: 5, decisionNote: null });
    await ctx.http().post(`${org.base}/twin/scenarios/${id}/submit`).set(accountant.auth).expect(200);
    await ctx.http().post(`${org.base}/twin/scenarios/${id}/withdraw`).set(accountant.auth).expect(200);
    await ctx.http().post(`${org.base}/twin/scenarios/${id}/submit`).set(accountant.auth).expect(200);
    const ok = (await ctx.http().post(`${org.base}/twin/scenarios/${id}/approve`).set(owner.auth).send({ note: 'Go ahead' }).expect(200)).body;
    expect(ok).toMatchObject({ status: 'APPROVED', decidedById: owner.id, decisionNote: 'Go ahead', version: 5 });
    expect((await ctx.http().put(`${org.base}/twin/scenarios/${id}`).set(accountant.auth).send(body([hire()])).expect(409)).body.message).toMatch(/approved; reopen it/);
    await ctx.http().delete(`${org.base}/twin/scenarios/${id}`).set(owner.auth).expect(409);
    const cmp = (await ctx.http().get(`${org.base}/twin/compare?ids=${id}`).set(viewer.auth).expect(200)).body;
    expect(cmp.rows[1]).toMatchObject({ status: 'APPROVED' });
    expect(Array.isArray(cmp.rows[1].riskList)).toBe(true);
    const back = (await ctx.http().post(`${org.base}/twin/scenarios/${id}/reopen`).set(accountant.auth).expect(200)).body;
    expect(back).toMatchObject({ status: 'DRAFT', decidedById: null });
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=twin_scenario&limit=100`).set(owner.auth).expect(200)).body;
    const actions = (Array.isArray(audit) ? audit : audit.items).map((x: { action: string }) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['twin_scenario.submitted', 'twin_scenario.withdrawn', 'twin_scenario.rejected', 'twin_scenario.approved', 'twin_scenario.reopened', 'twin_scenario.note_added', 'twin_scenario.note_resolved', 'twin_scenario.note_deleted']));
  });

  it('keeps scenarios, versions and notes to their organisation', async () => {
    await ctx.http().post(`${other.base}/twin/scenarios/${id}/notes`).set(viewer.auth).send({ body: 'Peek' }).expect(404);
    await ctx.http().post(`${other.base}/twin/scenarios/${id}/submit`).set(viewer.auth).expect(404);
    await ctx.http().post(`${other.base}/twin/scenarios/${id}/versions/1/restore`).set(viewer.auth).expect(404);
    await ctx.http().put(`${other.base}/twin/scenarios/${id}/notes/${noteId}`).set(viewer.auth).send({ resolved: false }).expect(404);
  });
});
