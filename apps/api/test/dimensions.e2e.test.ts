import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';
import { sqlWrite } from './sql-writes';

/**
 * Financial dimensions against the real API and database: departments and projects, journal and
 * invoice lines tagged with them (checked by kind, organisation and active state), reversals
 * keeping them, the profit and loss by department and by project, the income statement for one
 * department, and the database guards.
 */
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const FROM = `${T.slice(0, 7)}-01`;

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let F: string;
const id: Record<string, string> = {};

const raw = (sql: string, ...args: unknown[]) => sqlWrite(ctx, sql, args, { bypass: true });
const journal = (lines: Record<string, unknown>[], memo = 'Test') => ({ date: T, memo, post: true, lines });
const profit = async (type: string) => (await ctx.http().get(`${F}/profit?type=${type}&from=${FROM}&to=${T}`).set(viewer.auth).expect(200)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Dimension Owner');
  viewer = await registerUser(ctx, 'Dimension Viewer');
  outsider = await registerUser(ctx, 'Dimension Outsider');
  org = await createOrg(ctx, owner, { name: 'Dimensions Pvt Ltd' });
  F = `${org.base}/dimensions`;
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('departments and projects', () => {
  it('adds departments and projects with codes unique per kind', async () => {
    await ctx.http().post(F).set(viewer.auth).send({ type: 'DEPARTMENT', code: 'SALES', name: 'Sales' }).expect(403);
    id.sales = (await ctx.http().post(F).set(owner.auth).send({ type: 'DEPARTMENT', code: 'SALES', name: 'Sales' }).expect(201)).body.id;
    const ops = (await ctx.http().post(F).set(owner.auth).send({ type: 'DEPARTMENT', code: 'ops', name: 'Operations', description: 'Warehouse and delivery' }).expect(201)).body;
    id.ops = ops.id;
    expect(ops).toMatchObject({ code: 'OPS', isActive: true, lines: 0 });
    id.hr = (await ctx.http().post(F).set(owner.auth).send({ type: 'DEPARTMENT', code: 'HR', name: 'People' }).expect(201)).body.id;
    expect((await ctx.http().post(F).set(owner.auth).send({ type: 'DEPARTMENT', code: 'sales', name: 'Sales again' }).expect(409)).body.error).toBe('DIMENSION_CODE_TAKEN');
    expect((await ctx.http().post(F).set(owner.auth).send({ type: 'DEPARTMENT', code: 'has space', name: 'X' }).expect(422)).body.error).toBe('DIMENSION_INVALID');
    expect((await ctx.http().post(F).set(owner.auth).send({ type: 'DEPARTMENT', code: 'MKT', name: 'Marketing', customer: 'Acme' }).expect(422)).body.message).toBe('Only projects have a customer and dates');
    expect((await ctx.http().post(F).set(owner.auth).send({ type: 'PROJECT', code: 'P1', name: 'Bad', startDate: T, endDate: '2000-01-01' }).expect(422)).body.message).toBe('A project cannot end before it starts');
    const p = (await ctx.http().post(F).set(owner.auth).send({ type: 'PROJECT', code: 'SALES', name: 'Sales portal build', customer: 'Asha Traders', startDate: FROM }).expect(201)).body;
    id.portal = p.id;
    expect(p).toMatchObject({ type: 'PROJECT', code: 'SALES', customer: 'Asha Traders', startDate: FROM, endDate: null });
    const list = (await ctx.http().get(`${F}?type=DEPARTMENT`).set(viewer.auth).expect(200)).body;
    expect(list.values.map((v: { code: string }) => v.code)).toEqual(['HR', 'OPS', 'SALES']);
    expect(list.can).toEqual({ manage: false });
  });

  it('tags journal lines, checking the kind, the organisation and that the value is active', async () => {
    const lines = (dept: string | null, project: string | null = null) => [
      { accountId: org.acc['6100'], debit: '40000.00', departmentId: dept, projectId: project },
      { accountId: org.acc['1120'], credit: '40000.00' },
    ];
    expect((await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(journal(lines(id.portal!))).expect(422)).body.error).toBe('INVALID_DIMENSION');
    expect((await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(journal(lines(null, id.sales))).expect(422)).body.message).toBe('Line 1: project not found');
    const other = await createOrg(ctx, outsider, { name: 'Other Pvt Ltd' });
    const theirs = (await ctx.http().post(`${other.base}/dimensions`).set(outsider.auth).send({ type: 'DEPARTMENT', code: 'SALES', name: 'Theirs' }).expect(201)).body.id;
    expect((await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(journal(lines(theirs))).expect(422)).body.message).toBe('Line 1: department not found');

    const salaries = (await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(journal(lines(id.sales!, id.portal!), 'Sales salaries')).expect(201)).body;
    expect(salaries.lines[0]).toMatchObject({ departmentId: id.sales, projectId: id.portal });
    expect(salaries.lines[1]).toMatchObject({ departmentId: null, projectId: null });
    await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(journal([
      { accountId: org.acc['6200'], debit: '30000.00', departmentId: id.ops },
      { accountId: org.acc['6100'], debit: '25000.00', departmentId: id.ops },
      { accountId: org.acc['6300'], debit: '5000.00' },
      { accountId: org.acc['1120'], credit: '60000.00' },
    ], 'Rent, wages and power')).expect(201);
    id.salaries = salaries.id;

    await ctx.http().put(`${F}/${id.hr}`).set(owner.auth).send({ code: 'HR', name: 'People', isActive: false }).expect(200);
    expect((await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(journal(lines(id.hr!))).expect(422)).body.message).toBe('Line 1: department HR is inactive');
  });

  it('carries invoice line tags to the journal', async () => {
    const customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Asha Traders', isCustomer: true }).expect(201)).body;
    const body = {
      kind: 'INVOICE',
      contactId: customer.id,
      issueDate: T,
      lines: [
        { accountId: org.acc['4200'], description: 'Portal build, phase 1', quantity: '1', unitPrice: '150000', departmentId: id.sales, projectId: id.portal },
        { accountId: org.acc['4100'], description: 'Hardware', quantity: '2', unitPrice: '10000' },
      ],
    };
    expect((await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ ...body, lines: [{ ...body.lines[0], departmentId: id.portal }] }).expect(422)).body.error).toBe('DOCUMENT_INVALID');
    const draft = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send(body).expect(201)).body;
    expect(draft.lines[0]).toMatchObject({ departmentId: id.sales, projectId: id.portal });
    const posted = (await ctx.http().post(`${org.base}/sales/documents/${draft.id}/post`).set(owner.auth).send({}).expect(200)).body;
    const je = (await ctx.http().get(`${org.base}/journals/${posted.journalEntryId}`).set(owner.auth).expect(200)).body;
    const rev = je.lines.find((l: { accountId: string }) => l.accountId === org.acc['4200']);
    expect(rev).toMatchObject({ credit: '150000.00', departmentId: id.sales, projectId: id.portal });
    expect(je.lines.find((l: { accountId: string }) => l.accountId === org.acc['4100']).departmentId).toBeNull();
  });

  it('splits the profit and loss by department and by project', async () => {
    const d = await profit('DEPARTMENT');
    // HR is inactive and unused, so it is left out.
    expect(d.columns.map((c: { name: string }) => c.name)).toEqual(['Operations', 'Sales', 'Not assigned']);
    expect(d.sections[0]).toMatchObject({ type: 'REVENUE', totals: ['0.00', '150000.00', '20000.00'], total: '170000.00' });
    expect(d.sections[1].rows.map((r: { code: string; amounts: string[] }) => [r.code, r.amounts])).toEqual([
      ['6100', ['25000.00', '40000.00', '0.00']],
      ['6200', ['30000.00', '0.00', '0.00']],
      ['6300', ['0.00', '0.00', '5000.00']],
    ]);
    expect(d.netProfit).toEqual(['-55000.00', '110000.00', '15000.00']);
    expect(d.netProfitTotal).toBe('70000.00');
    expect(d.margin[1]).toBe('73.3');
    const all = (await ctx.http().get(`${F}/profit?type=DEPARTMENT&from=${FROM}&to=${T}&includeInactive=true`).set(viewer.auth).expect(200)).body;
    expect(all.columns.map((c: { name: string }) => c.name)).toEqual(['People', 'Operations', 'Sales', 'Not assigned']);
    const p = await profit('PROJECT');
    expect(p.columns.map((c: { name: string }) => c.name)).toEqual(['Sales portal build', 'Not assigned']);
    expect(p.netProfit).toEqual(['110000.00', '-40000.00']);
    const is = (await ctx.http().get(`${org.base}/reports/income-statement?from=${FROM}&to=${T}&departmentId=${id.ops}`).set(viewer.auth).expect(200)).body;
    expect(is).toMatchObject({ totalRevenue: '0.00', totalExpenses: '55000.00', netIncome: '-55000.00' });
  });

  it('keeps the tags on a reversal, even when the department has since been made inactive', async () => {
    await ctx.http().put(`${F}/${id.sales}`).set(owner.auth).send({ code: 'SALES', name: 'Sales', isActive: false }).expect(200);
    const rev = (await ctx.http().post(`${org.base}/journals/${id.salaries}/reverse`).set(owner.auth).send({ date: T }).expect(201)).body;
    expect(rev.lines[0]).toMatchObject({ credit: '40000.00', departmentId: id.sales, projectId: id.portal });
    const d = await profit('DEPARTMENT');
    expect(d.sections[1].rows.find((r: { code: string }) => r.code === '6100').amounts).toEqual(['25000.00', '0.00', '0.00']);
    const list = (await ctx.http().get(`${F}?type=DEPARTMENT`).set(owner.auth).expect(200)).body;
    expect(list.values.find((v: { code: string }) => v.code === 'SALES')).toMatchObject({ isActive: false, lines: 3 });
  });

  it('keeps departments and projects in the database', async () => {
    await expect(raw(`DELETE FROM dimension_values WHERE id = $1::uuid`, id.ops)).rejects.toThrow(/never deleted/);
    await expect(raw(`UPDATE dimension_values SET type = 'PROJECT' WHERE id = $1::uuid`, id.ops)).rejects.toThrow(/keeps its organisation and type/);
    await expect(raw(`UPDATE journal_lines SET department_id = $1::uuid WHERE org_id = $2::uuid AND department_id IS NULL`, id.portal, org.orgId)).rejects.toThrow(/must be a department/);
    await expect(raw(`UPDATE dimension_values SET code = 'bad code' WHERE id = $1::uuid`, id.ops)).rejects.toThrow(/dimension_values_chk/);
  });
});
