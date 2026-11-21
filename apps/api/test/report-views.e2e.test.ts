import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Saved report views (RPT-028, RPT-029, RPT-037) against the real API and database: a report's
 * filters saved under a name, private or shared with the organisation, opened with relative dates
 * resolved on the day, changed only by the person who saved it (or an owner or admin when
 * shared), audited, and kept apart between organisations.
 */
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let dept: string;
type View = { id: string; name: string; report: string; shared: boolean; mine: boolean; canChange: boolean; filters: Record<string, unknown>; opensWith: { from: string | null; to: string; departmentId: string | null; basis: string | null } };

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Views Owner');
  accountant = await registerUser(ctx, 'Views Accountant');
  viewer = await registerUser(ctx, 'Views Viewer');
  outsider = await registerUser(ctx, 'Views Outsider');
  org = await createOrg(ctx, owner, { name: 'Views Test Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Views Ltd' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  dept = (await ctx.http().post(`${org.base}/dimensions`).set(owner.auth).send({ type: 'DEPARTMENT', code: 'SALES', name: 'Sales' }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx?.app.close();
});

const V = () => `${org.base}/report-views`;
const list = async (who: TestUser, report?: string) => (await ctx.http().get(`${V()}${report ? `?report=${report}` : ''}`).set(who.auth).expect(200)).body as View[];

describe('saved report views', () => {
  let mine: View;
  let shared: View;

  it('saves a private view with a relative period and the report’s filters', async () => {
    mine = (await ctx.http().post(V()).set(accountant.auth).send({ name: 'Sales P&L last month', report: 'income-statement', filters: { dates: { preset: 'LAST_MONTH' }, departmentId: dept, basis: 'ACCRUAL' } }).expect(201)).body;
    expect(mine).toMatchObject({ shared: false, mine: true, canChange: true, filters: { dates: { preset: 'LAST_MONTH', from: null, to: null }, departmentId: dept, basis: 'ACCRUAL' } });
    expect(mine.opensWith.from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(mine.opensWith.to.slice(0, 7)).toBe(mine.opensWith.from!.slice(0, 7));
    expect(mine.opensWith.departmentId).toBe(dept);
    expect(await list(viewer)).toEqual([]);
  });

  it('refuses filters the report does not take and dates that do not make sense', async () => {
    const bad = async (body: object, error: string, status = 422) => expect((await ctx.http().post(V()).set(accountant.auth).send(body).expect(status)).body.error).toBe(error);
    await bad({ name: 'x', report: 'balance-sheet', filters: { dates: { preset: 'LAST_MONTH' } } }, 'VIEW_INVALID');
    await bad({ name: 'x', report: 'balance-sheet', filters: { dates: { preset: 'TODAY' }, departmentId: dept } }, 'VIEW_INVALID');
    await bad({ name: 'x', report: 'cash-flow-statement', filters: { dates: { preset: 'FIXED', from: '2026-07-01', to: '2026-06-30' } } }, 'VIEW_INVALID');
    await bad({ name: 'x', report: 'general-ledger', filters: { dates: { preset: 'TODAY' } } }, 'VALIDATION_FAILED', 400);
    await bad({ name: '', report: 'trial-balance', filters: { dates: { preset: 'FY_TO_DATE' } } }, 'VALIDATION_FAILED', 400);
  });

  it('shares a view with everyone who can read reports, and only its owner or an admin changes it', async () => {
    shared = (await ctx.http().post(V()).set(accountant.auth).send({ name: 'Balance sheet at year end', report: 'balance-sheet', filters: { dates: { preset: 'FIXED', to: '2026-03-31' } }, shared: true }).expect(201)).body;
    const seen = await list(viewer);
    expect(seen.map((v) => [v.name, v.mine, v.canChange])).toEqual([['Balance sheet at year end', false, false]]);
    expect(seen[0]!.opensWith).toMatchObject({ from: null, to: '2026-03-31' });
    expect((await list(owner)).find((v) => v.id === shared.id)!.canChange).toBe(true);

    await ctx.http().put(`${V()}/${shared.id}`).set(viewer.auth).send({ name: 'Mine now', report: 'balance-sheet', filters: { dates: { preset: 'TODAY' } }, shared: true }).expect(403);
    await ctx.http().delete(`${V()}/${shared.id}`).set(viewer.auth).expect(403);
    await ctx.http().put(`${V()}/${mine.id}`).set(owner.auth).send({ name: 'Peek', report: 'income-statement', filters: { dates: { preset: 'LAST_MONTH' } }, shared: false }).expect(404);
    const renamed = (await ctx.http().put(`${V()}/${shared.id}`).set(owner.auth).send({ name: 'Year-end balance sheet', report: 'balance-sheet', filters: { dates: { preset: 'END_OF_LAST_FY' } }, shared: true }).expect(200)).body as View;
    expect(renamed).toMatchObject({ name: 'Year-end balance sheet', filters: { dates: { preset: 'END_OF_LAST_FY', from: null, to: null } } });
    await ctx.http().put(`${V()}/${shared.id}`).set(owner.auth).send({ name: 'Moved', report: 'trial-balance', filters: { dates: { preset: 'TODAY' } }, shared: true }).expect(422);
  });

  it('filters the list by report and keeps organisations apart', async () => {
    expect((await list(accountant, 'income-statement')).map((v) => v.name)).toEqual(['Sales P&L last month']);
    expect((await list(accountant)).map((v) => v.name)).toEqual(['Sales P&L last month', 'Year-end balance sheet']);
    await ctx.http().get(V()).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/report-views`).set(outsider.auth).expect(200)).body).toEqual([]);
    await ctx.http().delete(`${other.base}/report-views/${mine.id}`).set(outsider.auth).expect(404);
  });

  it('deletes views and keeps every change in the audit trail', async () => {
    await ctx.http().delete(`${V()}/${mine.id}`).set(accountant.auth).expect(204);
    await ctx.http().delete(`${V()}/${shared.id}`).set(owner.auth).expect(204);
    expect(await list(accountant)).toEqual([]);
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=report_view`).set(owner.auth).expect(200)).body;
    const actions = ((audit.items ?? audit) as { action: string }[]).map((e) => e.action).sort();
    expect(actions).toEqual(['report_view.deleted', 'report_view.deleted', 'report_view.saved', 'report_view.saved', 'report_view.updated']);
  });
});
