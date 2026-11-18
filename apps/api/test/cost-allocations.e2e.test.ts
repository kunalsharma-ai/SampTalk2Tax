import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Cost allocation (GL-024) against the real API and database: a rule spreading untagged rent to
 * three departments by floor area, checked shares, a preview, the posted journal, profit by
 * department after it, one run per period, reversal and re-running, permissions and the audit trail.
 */
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const FROM = `${T.slice(0, 7)}-01`;

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let C: string;
const dept: Record<string, string> = {};
let ruleId: string;
let runId: string;

const rentByDept = async () => {
  const d = (await ctx.http().get(`${org.base}/dimensions/profit?type=DEPARTMENT&from=${FROM}&to=${T}`).set(viewer.auth).expect(200)).body;
  const row = d.sections[1].rows.find((r: { code: string }) => r.code === '6200');
  return Object.fromEntries(d.columns.map((c: { name: string }, i: number) => [c.name, row.amounts[i]]));
};

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Alloc Owner');
  viewer = await registerUser(ctx, 'Alloc Viewer');
  org = await createOrg(ctx, owner, { name: 'Allocations Pvt Ltd' });
  C = `${org.base}/cost-allocations`;
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  for (const [code, name] of [['SALES', 'Sales'], ['OPS', 'Operations'], ['ADMIN', 'Admin']]) dept[code] = (await ctx.http().post(`${org.base}/dimensions`).set(owner.auth).send({ type: 'DEPARTMENT', code, name }).expect(201)).body.id;
  await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: T, memo: 'Office rent', post: true, lines: [{ accountId: org.acc['6200'], debit: '60000.00' }, { accountId: org.acc['6200'], debit: '1000.00', departmentId: dept.SALES }, { accountId: org.acc['1120'], credit: '61000.00' }] }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('cost allocation', () => {
  it('defines a rule with shares that add up to 100', async () => {
    const body = { name: 'Rent by floor area', accountIds: [org.acc['6200']], sourceDepartmentId: null, targets: [{ departmentId: dept.SALES, percent: '50' }, { departmentId: dept.OPS, percent: '30' }, { departmentId: dept.ADMIN, percent: '10' }] };
    await ctx.http().post(`${C}/rules`).set(viewer.auth).send(body).expect(403);
    const bad = (await ctx.http().post(`${C}/rules`).set(owner.auth).send(body).expect(422)).body;
    expect(bad).toMatchObject({ error: 'RULE_INVALID', message: 'The shares add up to 90 percent, not 100' });
    expect((await ctx.http().post(`${C}/rules`).set(owner.auth).send({ ...body, accountIds: [org.acc['1120']], targets: [{ departmentId: dept.SALES, percent: '50' }, { departmentId: dept.OPS, percent: '50' }] }).expect(422)).body.message).toBe('Only postable expense accounts are allocated');
    body.targets[2]!.percent = '20';
    const r = (await ctx.http().post(`${C}/rules`).set(owner.auth).send(body).expect(201)).body;
    ruleId = r.id;
    expect(r).toMatchObject({ name: 'Rent by floor area', isActive: true, source: 'Costs with no department', targets: [{ name: 'SALES Sales', percent: '50' }, { name: 'OPS Operations', percent: '30' }, { name: 'ADMIN Admin', percent: '20' }] });
    expect((await ctx.http().post(`${C}/rules`).set(owner.auth).send(body).expect(409)).body.error).toBe('RULE_EXISTS');
  });

  it('previews and posts the allocation, which moves the cost to the departments', async () => {
    const p = (await ctx.http().get(`${C}/rules/${ruleId}/preview`).query({ from: FROM, to: T }).set(viewer.auth).expect(200)).body;
    expect(p).toMatchObject({ total: '60000.00', alreadyPostedRunId: null });
    expect(p.lines.map((l: { departmentId: string | null; debit?: string; credit?: string }) => [l.departmentId, l.debit ?? '', l.credit ?? ''])).toEqual([
      [null, '', '60000.00'],
      [dept.SALES, '30000.00', ''],
      [dept.OPS, '18000.00', ''],
      [dept.ADMIN, '12000.00', ''],
    ]);
    await ctx.http().post(`${C}/rules/${ruleId}/run`).set(viewer.auth).send({ from: FROM, to: T }).expect(403);
    const run = (await ctx.http().post(`${C}/rules/${ruleId}/run`).set(owner.auth).send({ from: FROM, to: T }).expect(201)).body;
    runId = run.id;
    const je = (await ctx.http().get(`${org.base}/journals/${run.journalEntryId}`).set(owner.auth).expect(200)).body;
    expect(je).toMatchObject({ status: 'POSTED', source: 'ALLOCATION', totalDebit: '60000.00' });
    expect(await rentByDept()).toEqual({ Sales: '31000.00', Operations: '18000.00', Admin: '12000.00', 'Not assigned': '0.00' });
  });

  it('posts once per period, and can be reversed and run again', async () => {
    expect((await ctx.http().post(`${C}/rules/${ruleId}/run`).set(owner.auth).send({ from: FROM, to: T }).expect(409)).body.error).toBe('ALREADY_RUN');
    const again = (await ctx.http().get(`${C}/rules/${ruleId}/preview`).query({ from: FROM, to: T }).set(owner.auth).expect(200)).body;
    expect(again).toMatchObject({ total: '0.00', alreadyPostedRunId: runId });
    await ctx.http().post(`${C}/runs/${runId}/reverse`).set(viewer.auth).expect(403);
    expect((await ctx.http().post(`${C}/runs/${runId}/reverse`).set(owner.auth).expect(201)).body.status).toBe('REVERSED');
    expect((await ctx.http().post(`${C}/runs/${runId}/reverse`).set(owner.auth).expect(409)).body.error).toBe('ALREADY_REVERSED');
    expect(await rentByDept()).toEqual({ Sales: '1000.00', Operations: '0.00', Admin: '0.00', 'Not assigned': '60000.00' });
    await ctx.http().post(`${C}/rules/${ruleId}/run`).set(owner.auth).send({ from: FROM, to: T }).expect(201);
    const list = (await ctx.http().get(C).set(viewer.auth).expect(200)).body;
    expect(list.runs.map((r: { status: string; total: string }) => [r.status, r.total])).toEqual([['POSTED', '60000.00'], ['REVERSED', '60000.00']]);
    expect(list.options.departments).toHaveLength(3);
  });

  it('stops a switched-off rule and records every step', async () => {
    await ctx.http().put(`${C}/rules/${ruleId}`).set(owner.auth).send({ name: 'Rent by floor area', accountIds: [org.acc['6200']], sourceDepartmentId: null, targets: [{ departmentId: dept.SALES, percent: '50' }, { departmentId: dept.OPS, percent: '50' }], isActive: false }).expect(200);
    expect((await ctx.http().post(`${C}/rules/${ruleId}/run`).set(owner.auth).send({ from: FROM, to: FROM }).expect(409)).body.error).toBe('RULE_INACTIVE');
    const other = await registerUser(ctx, 'Alloc Outsider');
    const theirs = await createOrg(ctx, other, { name: 'Other Alloc Ltd' });
    await ctx.http().get(`${theirs.base}/cost-allocations/rules/${ruleId}/preview`).query({ from: FROM, to: T }).set(other.auth).expect(404);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'cost_allocation' }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['cost_allocation_rule.created', 'cost_allocation.posted', 'cost_allocation.reversed', 'cost_allocation.posted', 'cost_allocation_rule.updated']);
  });
});
