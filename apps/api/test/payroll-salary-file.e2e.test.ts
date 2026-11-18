import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Salary payment preparation (PAY-017): employees' salary accounts, checked when saved and shown
 * masked in lists, and the bank's bulk transfer file of net salaries for a posted pay run, with
 * the employees who cannot be paid by transfer listed.
 */
const t = today();
const FY = Number(t.slice(5, 7)) >= 4 ? Number(t.slice(0, 4)) : Number(t.slice(0, 4)) - 1;
const APR = `${FY}-04`;

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let run: string;
const emp: Record<string, string> = {};
const structure = { effectiveFrom: `${APR}-01`, components: [{ code: 'BASIC', name: 'Basic', kind: 'WAGES', monthlyAmount: '30000' }] };
const base = (code: string, extra: Record<string, unknown> = {}) => ({ code, name: `Employee ${code}`, dateOfJoining: `${APR}-01`, structure, ...extra });

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Salary Owner');
  viewer = await registerUser(ctx, 'Salary Viewer');
  org = await createOrg(ctx, owner);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  await ctx.http().put(`${org.base}/payroll/settings`).set(owner.auth).send({}).expect(200);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('salary accounts', () => {
  it('checks the account when saved, and keeps all three details or none', async () => {
    const bad = await ctx.http().post(`${org.base}/payroll/employees`).set(owner.auth).send(base('S001', { bankAccountName: 'Asha Kulkarni', bankAccountNumber: '1234', bankIfsc: 'HDFC0001234' })).expect(422);
    expect(bad.body.details.issues).toContain('Salary account: An account number is 6 to 34 letters or digits');
    const noIfsc = await ctx.http().post(`${org.base}/payroll/employees`).set(owner.auth).send(base('S001', { bankAccountNumber: '50100012345678' })).expect(422);
    expect(noIfsc.body.details.issues).toEqual(expect.arrayContaining(["Salary account: Enter the account holder's name as the bank has it", expect.stringContaining('Salary account: An IFSC is 11 characters')]));
    const e = (await ctx.http().post(`${org.base}/payroll/employees`).set(owner.auth).send(base('S001', { email: 'asha@example.test', bankAccountName: 'Asha Kulkarni', bankAccountNumber: '5010 0012 3456 78', bankIfsc: 'hdfc0001234' })).expect(201)).body;
    emp.S001 = e.id;
    expect(e.bank).toEqual({ accountName: 'Asha Kulkarni', accountNumber: '50100012345678', masked: 'XXXXXXXX5678', ifsc: 'HDFC0001234' });
    emp.S002 = (await ctx.http().post(`${org.base}/payroll/employees`).set(owner.auth).send(base('S002')).expect(201)).body.id;
    emp.S003 = (await ctx.http().post(`${org.base}/payroll/employees`).set(owner.auth).send(base('S003', { bankAccountName: 'Ravi Shetty', bankAccountNumber: '001234567890', bankIfsc: 'ICIC0000456' })).expect(201)).body.id;
    // The list shows the last digits only.
    const list = (await ctx.http().get(`${org.base}/payroll/employees`).set(owner.auth).expect(200)).body;
    expect(list.find((x: { code: string }) => x.code === 'S001').bank).toEqual({ accountName: 'Asha Kulkarni', masked: 'XXXXXXXX5678', ifsc: 'HDFC0001234' });
    expect(JSON.stringify(list)).not.toContain('50100012345678');
  });

  it('keeps full account numbers out of the audit trail', async () => {
    const e = (await ctx.http().get(`${org.base}/payroll/employees/${emp.S003}`).set(owner.auth).expect(200)).body;
    await ctx.http().put(`${org.base}/payroll/employees/${emp.S003}`).set(owner.auth).send({ code: 'S003', name: e.name, dateOfJoining: e.dateOfJoining, bankAccountName: 'Ravi Shetty', bankAccountNumber: '009988776655', bankIfsc: 'ICIC0000456' }).expect(200);
    const ev = await ctx.prisma.auditEvent.findFirst({ where: { action: 'payroll.employee_updated', entityId: emp.S003 }, orderBy: { createdAt: 'desc' } });
    expect(ev?.data).toMatchObject({ bankAccountNumber: 'XXXXXXXX6655' });
    expect(JSON.stringify(ev?.data)).not.toContain('009988776655');
  });
});

describe('the salary bank file', () => {
  it('lists who can be paid by transfer and who needs a salary account', async () => {
    run = (await ctx.http().post(`${org.base}/payroll/runs`).set(owner.auth).send({ period: APR, payDate: `${APR}-28` }).expect(201)).body.id;
    const tr = (await ctx.http().get(`${org.base}/payroll/runs/${run}/salary-transfers`).set(owner.auth).expect(200)).body;
    expect(tr.ready).toBe(2);
    expect(tr.rows.map((r: { code: string; account: string | null; issue: string | null }) => [r.code, r.account, r.issue])).toEqual([
      ['S001', 'XXXXXXXX5678', null],
      ['S002', null, 'No salary account'],
      ['S003', 'XXXXXXXX6655', null],
    ]);
    const net = tr.rows[0].net;
    expect(tr.total).toBe((Number(net) * 2).toFixed(2));
    await ctx.http().get(`${org.base}/payroll/runs/${run}/salary-transfers`).set(viewer.auth).expect(403);
    // Only a posted run can be paid.
    expect((await ctx.http().post(`${org.base}/payroll/runs/${run}/salary-file`).set(owner.auth).send({ bankAccountId: org.acc['1120'] }).expect(409)).body.error).toBe('PAY_RUN_NOT_POSTED');
  });

  it('makes the bank file of net salaries for a posted run', async () => {
    await ctx.http().post(`${org.base}/payroll/runs/${run}/post`).set(owner.auth).expect(200);
    expect((await ctx.http().post(`${org.base}/payroll/runs/${run}/salary-file`).set(owner.auth).send({ bankAccountId: org.acc['1110'] }).expect(422)).body.error).toBe('INVALID_BANK_ACCOUNT');
    const r = await ctx.http().post(`${org.base}/payroll/runs/${run}/salary-file`).set(owner.auth).send({ bankAccountId: org.acc['1120'] }).expect(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers["content-disposition"]).toMatch(/^attachment; filename=".+-salaries-\d{4}-\d{2}-28\.csv"$/);
    const lines = r.text.trim().split('\r\n');
    expect(lines[0]).toBe('Payment date,Debit account,Beneficiary name,Beneficiary account number,IFSC,Amount,Currency,Payment reference,Beneficiary email,Employee');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(new RegExp(`^${APR}-28,1120 Operating Bank Account,Asha Kulkarni,50100012345678,HDFC0001234,\\d+\\.\\d{2},INR,Salary .*,asha@example.test,S001 Employee S001$`));
    expect(lines[2]).toContain('Ravi Shetty,009988776655,ICIC0000456');
    expect(r.text).not.toContain('S002');
    const ev = await ctx.prisma.auditEvent.findFirst({ where: { action: 'payroll.salary_file_downloaded', entityId: run } });
    expect(ev?.data).toMatchObject({ employees: 2, left: ['S002'] });
    await ctx.http().post(`${org.base}/payroll/runs/${run}/salary-file`).set(viewer.auth).send({ bankAccountId: org.acc['1120'] }).expect(403);
  });
});
