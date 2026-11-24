import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * RPT-001, the reporting studio, against the real API and database: every report in one
 * catalogue with what this member may open, saved views and schedules per report, designs and
 * the latest exports, and pins kept per person. Who may open it, and isolation.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const T = today();
type Studio = {
  reports: { key: string; available: boolean; favourite: boolean; views: number; schedules: number; savedViews: boolean; exports: string[] }[];
  favourites: string[];
  totals: { reports: number; available: number; savedViews: number; schedules: number; designs: number };
  recentExports: { report: string; name: string; format: string; by: string | null }[];
  categories: { key: string; name: string; reports: number }[];
};
const studio = async (auth = owner.auth, status = 200): Promise<Studio> => (await ctx.http().get(`${org.base}/reports/studio`).set(auth).expect(status)).body;
const of = (s: Studio, key: string) => s.reports.find((r) => r.key === key)!;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Studio Owner');
  viewer = await registerUser(ctx, 'Studio Viewer');
  employee = await registerUser(ctx, 'Studio Employee');
  outsider = await registerUser(ctx, 'Studio Outsider');
  org = await createOrg(ctx, owner, { name: 'Studio Reports Pvt Ltd' });
  for (const [u, role] of [
    [viewer, 'VIEWER'],
    [employee, 'EMPLOYEE'],
  ] as const)
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('reporting studio', () => {
  it('lists every report by category and what this member may open', async () => {
    const s = await studio(viewer.auth);
    expect(s.totals.reports).toBe(s.reports.length);
    expect(s.categories.reduce((n, c) => n + c.reports, 0)).toBe(s.reports.length);
    expect(s.categories.map((c) => c.name)).toContain('Financial statements');
    expect(of(s, 'income-statement')).toMatchObject({ available: true, savedViews: true, exports: ['PDF', 'XLSX', 'CSV'], favourite: false, views: 0 });
    // A viewer cannot read payroll or audit, so those reports are listed but closed.
    expect(of(s, 'payroll').available).toBe(false);
    expect(of(s, 'audit').available).toBe(false);
    expect(of(s, 'payroll')).toMatchObject({ key: 'payroll' });
    const own = await studio();
    expect(own.totals.available).toBe(own.totals.reports);
  });

  it('counts saved views, schedules and exports per report', async () => {
    await ctx
      .http()
      .post(`${org.base}/report-views`)
      .set(owner.auth)
      .send({ name: 'Monthly P&L', report: 'income-statement', filters: { dates: { preset: 'LAST_MONTH' } }, shared: true })
      .expect(201);
    await ctx
      .http()
      .post(`${org.base}/report-views`)
      .set(owner.auth)
      .send({ name: 'My vendor spend', report: 'vendor-spend', filters: { dates: { preset: 'THIS_MONTH' } } })
      .expect(201);
    await ctx.http().get(`${org.base}/reports/export/trial-balance?format=csv&asOf=${T}`).set(owner.auth).expect(200);
    const s = await studio();
    expect(of(s, 'income-statement').views).toBe(1);
    expect(of(s, 'vendor-spend').views).toBe(1);
    expect(s.totals.savedViews).toBe(2);
    expect(s.recentExports[0]).toMatchObject({ report: 'trial-balance', name: 'Trial balance', format: 'CSV', by: 'Studio Owner' });
    // The viewer sees the shared view, not the owner's own.
    const v = await studio(viewer.auth);
    expect(of(v, 'income-statement').views).toBe(1);
    expect(of(v, 'vendor-spend').views).toBe(0);
  });

  it('keeps pins per person, once each, and refuses unknown reports', async () => {
    await ctx.http().put(`${org.base}/reports/studio/favourites/balance-sheet`).set(viewer.auth).expect(200);
    const s = (await ctx.http().put(`${org.base}/reports/studio/favourites/balance-sheet`).set(viewer.auth).expect(200)).body as Studio;
    expect(s.favourites).toEqual(['balance-sheet']);
    expect(of(s, 'balance-sheet').favourite).toBe(true);
    expect((await studio()).favourites).toEqual([]);
    await ctx.http().put(`${org.base}/reports/studio/favourites/no-such-report`).set(viewer.auth).expect(404);
    await ctx.http().put(`${org.base}/reports/studio/favourites/Bad_Key`).set(viewer.auth).expect(400);
    const after = (await ctx.http().delete(`${org.base}/reports/studio/favourites/balance-sheet`).set(viewer.auth).expect(200)).body as Studio;
    expect(after.favourites).toEqual([]);
  });

  it('is for members who read reports', async () => {
    await studio(employee.auth, 403);
    await studio(outsider.auth, 404);
    await ctx.http().put(`${org.base}/reports/studio/favourites/balance-sheet`).set(outsider.auth).expect(404);
  });
});
