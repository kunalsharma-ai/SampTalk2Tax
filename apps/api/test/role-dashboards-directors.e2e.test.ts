import { addDays, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * DASH-046/057/059 against the real API and database: the finance director's plan against
 * actual, accounts furthest off it, department budgets and closes; one department's budget,
 * spending by month and account and claims waiting, for a chosen department; the external
 * auditor's year-end, trial balance, portal links, evidence and findings. Who may open each,
 * the department choice, isolation.
 */
const T = today();
const FY = fiscalYearForDate(T, 4);
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let approver: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const dep: Record<string, string> = {};
const brief = async (role: string, auth = owner.auth, status = 200, query = '') => (await ctx.http().get(`${org.base}/reports/role-dashboards/${role}${query}`).set(auth).expect(status)).body;
const twelve = (x: string) => Array.from({ length: 12 }, () => x);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Director Owner');
  accountant = await registerUser(ctx, 'Director Accountant');
  approver = await registerUser(ctx, 'Director Approver');
  viewer = await registerUser(ctx, 'Director Viewer');
  employee = await registerUser(ctx, 'Director Employee');
  outsider = await registerUser(ctx, 'Director Outsider');
  org = await createOrg(ctx, owner, { name: 'Director Dashboards Pvt Ltd' });
  for (const [u, role] of [
    [accountant, 'ACCOUNTANT'],
    [approver, 'APPROVER'],
    [viewer, 'VIEWER'],
    [employee, 'EMPLOYEE'],
  ] as const)
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  for (const fy of [FY - 1, FY]) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy });
  for (const [code, name] of [
    ['D01', 'Sales'],
    ['D02', 'Field service'],
  ])
    dep[name] = (await ctx.http().post(`${org.base}/dimensions`).set(owner.auth).send({ type: 'DEPARTMENT', code, name }).expect(201)).body.id;
  const a = org.acc;
  const journal = (lines: object[]) => ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: T, post: true, memo: 'Dashboard test', lines }).expect(201);
  await journal([
    { accountId: a['6100'], debit: '12000.00', departmentId: dep.Sales },
    { accountId: a['1120'], credit: '12000.00' },
  ]);
  await journal([
    { accountId: a['6200'], debit: '3000.00', departmentId: dep.Sales },
    { accountId: a['1120'], credit: '3000.00' },
  ]);
  await journal([
    { accountId: a['1120'], debit: '50000.00' },
    { accountId: a['4100'], credit: '50000.00' },
  ]);
  await ctx.http().put(`${org.base}/department-budgets`).set(owner.auth).send({ departmentId: dep.Sales, fiscalYear: FY, amount: '120000.00' }).expect(200);
  // A claim waiting for approval, charged to Sales.
  const claim = (
    await ctx
      .http()
      .post(`${org.base}/expense-claims`)
      .set(employee.auth)
      .send({
        title: 'Synthetic client visit',
        lines: [
          {
            date: T,
            accountId: a['6700'],
            merchant: 'Synthetic Cabs',
            amount: '2000.00',
            departmentId: dep.Sales,
          },
        ],
      })
      .expect(201)
  ).body;
  await ctx.http().post(`${org.base}/expense-claims/${claim.id}/submit`).set(employee.auth).send({}).expect(200);
  // This year's approved plan.
  const plan = (await ctx.http().post(`${org.base}/budgets`).set(accountant.auth).send({ basis: 'EMPTY', fiscalYear: FY, name: 'Plan' }).expect(201)).body.budget.id;
  await ctx
    .http()
    .put(`${org.base}/budgets/${plan}/lines`)
    .set(accountant.auth)
    .send({
      lines: [
        { accountId: a['4100'], amounts: twelve('10000') },
        { accountId: a['6100'], amounts: twelve('500') },
      ],
    })
    .expect(200);
  await ctx.http().post(`${org.base}/budgets/${plan}/submit`).set(accountant.auth).expect(200);
  await ctx.http().post(`${org.base}/budgets/${plan}/approve`).set(approver.auth).expect(200);
  // An audit with a link for the external auditor and a request for evidence.
  const e = (
    await ctx
      .http()
      .post(`${org.base}/audit-engagements`)
      .set(owner.auth)
      .send({
        name: 'Statutory audit',
        objective: 'Year-end audit',
        scopeFrom: T,
        scopeTo: T,
        leadId: accountant.id,
        reviewerId: approver.id,
      })
      .expect(201)
  ).body;
  await ctx.http().post(`${org.base}/audit-engagements/${e.id}/auditor-links`).set(owner.auth).send({ auditorName: 'R. Mehta', firm: 'Mehta and Co', expiresInDays: 30 }).expect(201);
  await ctx
    .http()
    .post(`${org.base}/audit-evidence`)
    .set(accountant.auth)
    .send({
      engagementId: e.id,
      title: 'Bank confirmations',
      details: '',
      ownerId: accountant.id,
      dueDate: addDays(T, 5),
    })
    .expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('finance director, department manager and external auditor dashboards', () => {
  it('says which a viewer may open', async () => {
    const roles = (await ctx.http().get(`${org.base}/reports/role-dashboards`).set(viewer.auth).expect(200)).body.roles as { role: string; available: boolean }[];
    expect(roles.filter((r) => ['FINANCE_DIRECTOR', 'DEPARTMENT_MANAGER', 'EXTERNAL_AUDITOR'].includes(r.role)).map((r) => [r.role, r.available])).toEqual([
      ['FINANCE_DIRECTOR', true],
      ['DEPARTMENT_MANAGER', true],
      ['EXTERNAL_AUDITOR', false],
    ]);
    expect((await brief('EXTERNAL_AUDITOR', viewer.auth, 403)).message).toBe('This dashboard needs access to audit and controls');
  });

  it('gives the finance director the plan against actual and the accounts furthest off it', async () => {
    const r = await brief('FINANCE_DIRECTOR', viewer.auth);
    expect(r).toMatchObject({
      role: 'FINANCE_DIRECTOR',
      name: 'Finance director',
    });
    const v = r.director;
    expect(v.fiscalYear).toBe(FY);
    expect(v.plan.budget).toMatchObject({ name: 'Plan' });
    expect(v.plan.fullYear).toMatchObject({
      revenue: '120000.00',
      expenses: '6000.00',
      netIncome: '114000.00',
    });
    expect(v.plan.yearToDate.revenue).toMatchObject({ actual: '50000.00' });
    expect(v.plan.quarters).toHaveLength(4);
    const codes = v.plan.offPlan.map((x: { code: string }) => x.code);
    // Rent is above plan (12,000 spent against at most 6,000 for the year), and anything the wrong way comes first.
    expect(codes).toEqual(expect.arrayContaining(['4100', '6100']));
    const rent = v.plan.offPlan.find((x: { code: string }) => x.code === '6100').yearToDate;
    expect(rent).toMatchObject({ actual: '12000.00', favourable: false });
    const favourable = v.plan.offPlan.map((x: { yearToDate: { favourable: boolean } }) => x.yearToDate.favourable);
    expect(favourable).toEqual([...favourable].sort((x: boolean, y: boolean) => Number(x) - Number(y)));
    expect(v.departments.totals).toMatchObject({
      budget: '120000.00',
      actual: '15000.00',
      committed: '2000.00',
    });
    expect(v.closes[0].current).toBe(true);
  });

  it("gives the department manager one department's budget, spending and claims waiting", async () => {
    const v = (await brief('DEPARTMENT_MANAGER', viewer.auth)).department;
    expect(v.departments.map((d: { name: string }) => d.name)).toEqual(['Sales', 'Field service']);
    const s = v.department;
    expect(s).toMatchObject({
      id: dep.Sales,
      name: 'Sales',
      spent: '15000.00',
    });
    expect(s.budget).toMatchObject({
      amount: '120000.00',
      actual: '15000.00',
      committed: '2000.00',
    });
    expect(s.accounts.map((x: { code: string; spent: string; share: string }) => [x.code, x.spent, x.share])).toEqual([
      ['6100', '12000.00', '80.0'],
      ['6200', '3000.00', '20.0'],
    ]);
    expect(s.months.at(-1)).toEqual({
      month: T.slice(0, 7),
      spent: '15000.00',
      budget: '10000.00',
    });
    expect(s.claims).toEqual([
      expect.objectContaining({
        title: 'Synthetic client visit',
        claimant: 'Director Employee',
        forDepartment: '2000.00',
      }),
    ]);
    const field = (await brief('DEPARTMENT_MANAGER', viewer.auth, 200, `?departmentId=${dep['Field service']}`)).department.department;
    expect(field).toMatchObject({
      name: 'Field service',
      spent: '0.00',
      budget: expect.objectContaining({ amount: null, status: 'NO_BUDGET' }),
      accounts: [],
      claims: [],
    });
    await brief('DEPARTMENT_MANAGER', viewer.auth, 404, '?departmentId=00000000-0000-4000-8000-000000000000');
    await brief('DEPARTMENT_MANAGER', viewer.auth, 400, '?departmentId=nope');
  });

  it('gives the external auditor the year-end, trial balance, portal links, evidence and findings', async () => {
    const v = (await brief('EXTERNAL_AUDITOR')).externalAudit;
    expect(v.years[0]).toMatchObject({ ended: false });
    expect(v.trialBalance).toMatchObject({ balanced: true });
    expect(v.portal.active).toBe(1);
    expect(v.portal.links[0]).toMatchObject({
      auditorName: 'R. Mehta',
      firm: 'Mehta and Co',
      viewCount: 0,
      engagement: expect.stringContaining('Statutory audit'),
    });
    expect(JSON.stringify(v.portal)).not.toContain('tokenHash');
    expect(v.evidence.outstanding.map((x: { title: string }) => x.title)).toEqual(['Bank confirmations']);
    expect(v.findings.summary).toMatchObject({ open: 0 });
  });

  it('keeps out people without reports and other organisations', async () => {
    await brief('FINANCE_DIRECTOR', employee.auth, 403);
    await brief('DEPARTMENT_MANAGER', outsider.auth, 404);
  });
});
