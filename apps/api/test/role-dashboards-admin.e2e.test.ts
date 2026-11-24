import { addDays, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * DASH-058/043 against the real API and database: the project finance manager's revenue, cost and
 * margin by project with how far through each is and what no project carries; the organisation
 * administrator's members and roles, two-step sign-in, invitations, single sign-on, integrations,
 * the plan's use and what to look at first. Who may open each, and isolation.
 */
const T = today();
const FY = fiscalYearForDate(T, 4);
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const project: Record<string, string> = {};
const brief = async (role: string, auth = owner.auth, status = 200) => (await ctx.http().get(`${org.base}/reports/role-dashboards/${role}`).set(auth).expect(status)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Project Owner');
  accountant = await registerUser(ctx, 'Project Accountant');
  viewer = await registerUser(ctx, 'Project Viewer');
  employee = await registerUser(ctx, 'Project Employee');
  outsider = await registerUser(ctx, 'Project Outsider');
  org = await createOrg(ctx, owner, { name: 'Project Dashboards Pvt Ltd' });
  for (const [u, role] of [
    [accountant, 'ACCOUNTANT'],
    [viewer, 'VIEWER'],
    [employee, 'EMPLOYEE'],
  ] as const)
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  for (const fy of [FY - 1, FY]) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy });
  for (const [code, name, startDate, endDate] of [
    ['P01', 'Website build', addDays(T, -60), addDays(T, 20)],
    ['P02', 'Data migration', null, null],
    ['P03', 'Support retainer', null, null],
    ['P04', 'Idle pilot', null, null],
  ] as const)
    project[name] = (
      await ctx
        .http()
        .post(`${org.base}/dimensions`)
        .set(owner.auth)
        .send({ type: 'PROJECT', code, name, customer: code === 'P01' ? 'Asha Traders' : null, startDate, endDate })
        .expect(201)
    ).body.id;
  const a = org.acc;
  const journal = (lines: object[]) => ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: T, post: true, memo: 'Project test', lines }).expect(201);
  const sale = (amount: string, projectId?: string) =>
    journal([
      { accountId: a['1120'], debit: amount },
      { accountId: a['4100'], credit: amount, ...(projectId ? { projectId } : {}) },
    ]);
  const cost = (account: string, amount: string, projectId?: string) =>
    journal([
      { accountId: a[account], debit: amount, ...(projectId ? { projectId } : {}) },
      { accountId: a['1120'], credit: amount },
    ]);
  await sale('50000.00', project['Website build']);
  await cost('6100', '20000.00', project['Website build']);
  await cost('6200', '10000.00', project['Website build']);
  await sale('10000.00', project['Data migration']);
  await cost('6100', '12000.00', project['Data migration']);
  await sale('20000.00', project['Support retainer']);
  await cost('6200', '19000.00', project['Support retainer']);
  await sale('20000.00');
  await cost('6100', '5000.00');
  // One invitation still open, one that ran out.
  await ctx.http().post(`${org.base}/invitations`).set(owner.auth).send({ email: 'open.invite@example.test', role: 'ACCOUNTANT' }).expect(201);
  const late = (await ctx.http().post(`${org.base}/invitations`).set(owner.auth).send({ email: 'late.invite@example.test', role: 'VIEWER' }).expect(201)).body.invitation.id;
  await ctx.db.collection('invitations').updateOne({ _id: late } as never, { $set: { expiresAt: new Date(Date.now() - 60_000) } });
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('project finance and organisation admin dashboards', () => {
  it('says which a viewer may open', async () => {
    const roles = (await ctx.http().get(`${org.base}/reports/role-dashboards`).set(viewer.auth).expect(200)).body.roles as { role: string; available: boolean }[];
    expect(roles.filter((r) => ['PROJECT_FINANCE', 'ORG_ADMIN'].includes(r.role)).map((r) => [r.role, r.available])).toEqual([
      ['PROJECT_FINANCE', true],
      ['ORG_ADMIN', false],
    ]);
  });

  it('shows each project with its margin, health and progress, losses first', async () => {
    const r = await brief('PROJECT_FINANCE', viewer.auth);
    expect(r).toMatchObject({ role: 'PROJECT_FINANCE', name: 'Project finance manager', currency: 'INR' });
    const p = r.projects;
    expect(p.projects.map((x: { code: string; profit: string; margin: string | null; health: string }) => `${x.code} ${x.profit} ${x.margin} ${x.health}`)).toEqual([
      'P02 -2000.00 -20.0 LOSS',
      'P04 0.00 null NO_ACTIVITY',
      'P03 1000.00 5.0 THIN',
      'P01 20000.00 40.0 HEALTHY',
    ]);
    const web = p.projects.find((x: { code: string }) => x.code === 'P01');
    expect(web).toMatchObject({
      customer: 'Asha Traders',
      revenue: '50000.00',
      cost: '30000.00',
      startDate: addDays(T, -60),
      endDate: addDays(T, 20),
      elapsedPercent: 75.3,
      daysLeft: 20,
      ended: false,
      topCost: { code: '6100', amount: '20000.00', share: '66.7' },
    });
    expect(p.totals).toEqual({ revenue: '80000.00', cost: '61000.00', profit: '19000.00' });
    expect(p.counts).toEqual({ loss: 1, thin: 1, healthy: 1, noRevenue: 0, noActivity: 1, endingSoon: 1 });
    expect(p.unassigned).toMatchObject({ revenue: '20000.00', cost: '5000.00', revenueShare: '20.0' });
    expect(p.months).toHaveLength(6);
    expect(p.months.at(-1)).toEqual({ month: T.slice(0, 7), projectRevenue: '80000.00', projectCost: '61000.00', otherRevenue: '20000.00', otherCost: '5000.00' });
  });

  it('shows the organisation admin who has access, sign-in security, invitations and what to fix', async () => {
    const r = await brief('ORG_ADMIN');
    const a = r.admin;
    expect(a.members.total).toBe(4);
    expect(a.members.roles.filter((x: { members: number }) => x.members > 0).map((x: { role: string; members: number }) => `${x.role} ${x.members}`)).toEqual([
      'OWNER 1',
      'ACCOUNTANT 1',
      'VIEWER 1',
      'EMPLOYEE 1',
    ]);
    expect(a.members.withoutTwoStep).toBe(4);
    expect(a.members.adminsWithoutTwoStep.map((m: { name: string }) => m.name)).toEqual(['Project Owner']);
    expect(a.security.requireTwoStep).toBe(false);
    expect(a.invitations).toEqual({ pending: 1, expired: 1, accepted: 0, revoked: 0 });
    expect(a.sso).toMatchObject({ configured: false, enabled: false, domains: 0 });
    expect(a.integrations.map((i: { name: string; configured: boolean }) => `${i.name} ${i.configured}`)).toEqual(['AI assistant false', 'Email false']);
    expect(a.usage.items.map((u: { name: string }) => u.name)).toEqual(['AI requests', 'Document uploads']);
    expect(a.attention.map((x: { title: string; level: string; href: string }) => `${x.level} ${x.title} ${x.href}`)).toEqual([
      'HIGH Owners or admins without two-step sign-in /members',
      'MEDIUM Two-step sign-in is not required /members',
      'LOW Invitations expired /members',
    ]);
    // Nothing secret reaches the dashboard.
    expect(JSON.stringify(a)).not.toMatch(/tokenHash|secretCipher|clientSecret/);
  });

  it('keeps the admin dashboard to owners and admins, and every dashboard to members', async () => {
    const no = await brief('ORG_ADMIN', accountant.auth, 403);
    expect(no.message).toBe('This dashboard needs access to organisation settings');
    await brief('PROJECT_FINANCE', employee.auth, 403);
    await brief('PROJECT_FINANCE', outsider.auth, 404);
    await brief('ORG_ADMIN', outsider.auth, 404);
  });

  it('keeps each organisation to its own projects and members', async () => {
    const other = await createOrg(ctx, outsider, { name: 'Other Projects Ltd' });
    await ctx.http().post(`${other.base}/dimensions`).set(outsider.auth).send({ type: 'PROJECT', code: 'X01', name: 'Someone else project' }).expect(201);
    const mine = await brief('PROJECT_FINANCE');
    expect(mine.projects.projects.map((p: { name: string }) => p.name)).not.toContain('Someone else project');
    const theirs = (await ctx.http().get(`${other.base}/reports/role-dashboards/PROJECT_FINANCE`).set(outsider.auth).expect(200)).body;
    expect(theirs.projects.projects.map((p: { name: string }) => p.name)).toEqual(['Someone else project']);
    const admin = (await ctx.http().get(`${other.base}/reports/role-dashboards/ORG_ADMIN`).set(outsider.auth).expect(200)).body.admin;
    expect(admin.members.total).toBe(1);
    expect(admin.invitations.pending + admin.invitations.expired).toBe(0);
  });
});
