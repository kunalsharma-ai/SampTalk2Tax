import { addMonthsAnchored } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContractsService } from '../src/sales-orders/contracts.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';
import { sqlWrite } from './sql-writes';

/**
 * CRM slice 3 against the real API and database: contracts billed every period into draft
 * invoices (on activation, by Bill now and by the runner), never twice; price changes for later
 * periods; pause and resume with skipped periods; billing a period again after its invoice is
 * deleted; renewal with a price rise, automatic renewal and ending; cancellation; MRR and ARR;
 * permissions, tenant isolation and the database guards.
 */
const T = today();
const plusDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const months = (n: number) => addMonthsAnchored(T, n);

let ctx: Ctx;
let svc: ContractsService;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let customer: { id: string };
let otherCustomer: { id: string };
let tax18: { id: string };
let dealId: string;

const raw = (sql: string, ...args: unknown[]) => sqlWrite(ctx, sql, args, { bypass: true });
const body = (extra: Record<string, unknown> = {}) => ({
  contactId: customer.id,
  title: 'Monthly bookkeeping and GST returns',
  frequency: 'MONTHLY',
  timing: 'ADVANCE',
  startDate: months(-2),
  endDate: plusDays(months(10), -1),
  autoRenew: false,
  noticeDays: 30,
  paymentTermsDays: 10,
  reference: 'MSA-2026-07',
  lines: [{ accountId: org.acc['4100'], description: 'Bookkeeping', quantity: '1', unitPrice: '40000.00', taxRateId: tax18.id }],
  ...extra,
});
const docs = (id: string) => ctx.http().get(`${org.base}/sales/contracts/${id}`).set(owner.auth).expect(200).then((r) => r.body);

beforeAll(async () => {
  ctx = await bootApp();
  svc = ctx.app.get(ContractsService);
  owner = await registerUser(ctx, 'Contract Owner');
  viewer = await registerUser(ctx, 'Contract Viewer');
  outsider = await registerUser(ctx, 'Contract Outsider');
  org = await createOrg(ctx, owner, { name: 'Contract Traders Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Contracts Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Nair Logistics', isCustomer: true }).expect(201)).body;
  otherCustomer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Someone Else', isCustomer: true }).expect(201)).body;
  tax18 = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'Standard 18%', rate: '18', salesAccountId: org.acc['2300'], purchaseAccountId: org.acc['1450'] }).expect(201)).body;
  dealId = (await ctx.http().post(`${org.base}/crm/deals`).set(owner.auth).send({ name: 'Annual books', contactId: customer.id, amount: '480000.00', expectedCloseDate: T, stage: 'NEGOTIATION' }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx.app.close();
});

describe('a monthly contract', () => {
  let id: string;
  it('checks its terms and is a draft until activated', async () => {
    const bad = await ctx.http().post(`${org.base}/sales/contracts`).set(owner.auth).send(body({ endDate: plusDays(months(10), -3) })).expect(422);
    expect(bad.body).toMatchObject({ error: 'CONTRACT_END' });
    expect(bad.body.message).toContain('last day of a monthly period');
    expect((await ctx.http().post(`${org.base}/sales/contracts`).set(owner.auth).send(body({ endDate: null, autoRenew: true, renewalMonths: 12 })).expect(422)).body.error).toBe('CONTRACT_RENEWAL');
    expect((await ctx.http().post(`${org.base}/sales/contracts`).set(owner.auth).send(body({ dealId, contactId: otherCustomer.id })).expect(422)).body.error).toBe('SALES_DEAL_OTHER_CUSTOMER');
    const r = await ctx.http().post(`${org.base}/sales/contracts`).set(owner.auth).send(body({ dealId })).expect(201);
    id = r.body.id;
    expect(r.body).toMatchObject({ reference: 'CT-0001', status: 'DRAFT', subtotal: '40000.00', total: '47200.00', monthlyValue: '40000.00', periodsBilled: 0, nextBill: null });
    expect(r.body.upcoming).toHaveLength(6);
    expect(r.body.upcoming[0]).toMatchObject({ periodNo: 1, start: months(-2), billDate: months(-2) });
  });

  it('bills the periods already due on activation, once, and wins the deal', async () => {
    const a = await ctx.http().post(`${org.base}/sales/contracts/${id}/activate`).set(owner.auth).expect(200);
    expect(a.body).toMatchObject({ status: 'ACTIVE', periodsBilled: 3, nextBill: { periodNo: 4, date: months(1) } });
    expect(a.body.periods.map((p: { periodNo: number }) => p.periodNo)).toEqual([3, 2, 1]);
    const inv = (await ctx.http().get(`${org.base}/sales/documents/${a.body.periods[2].invoice.id}`).set(owner.auth).expect(200)).body;
    expect(inv).toMatchObject({ status: 'DRAFT', issueDate: months(-2), dueDate: plusDays(months(-2), 10), total: '47200.00', memo: 'Monthly bookkeeping and GST returns' });
    expect(inv.reference).toMatch(/^CT-0001 .* to .* \/ MSA-2026-07$/);
    const deal = (await ctx.http().get(`${org.base}/crm/deals/${dealId}`).set(owner.auth).expect(200)).body;
    expect(deal.stage).toBe('WON');
    expect((await ctx.http().post(`${org.base}/sales/contracts/${id}/bill-due`).set(owner.auth).expect(200)).body.billed).toBe(0);
    expect(await svc.runAll(T, [org.orgId])).toMatchObject({ contracts: 1, billed: 0, failed: 0 });
    expect((await ctx.http().post(`${org.base}/sales/contracts/${id}/activate`).set(owner.auth).expect(422)).body.error).toBe('CONTRACT_NOT_DRAFT');
  });

  it('bills later periods at the price in force, and keeps its schedule', async () => {
    const changed = await ctx.http().put(`${org.base}/sales/contracts/${id}`).set(owner.auth).send(body({ dealId, lines: [{ accountId: org.acc['4100'], description: 'Bookkeeping', quantity: '1', unitPrice: '45000.00', taxRateId: tax18.id }] })).expect(200);
    expect(changed.body.total).toBe('53100.00');
    expect(changed.body.events[0].body).toContain('amount per period 47200.00 → 53100.00');
    expect((await ctx.http().put(`${org.base}/sales/contracts/${id}`).set(owner.auth).send(body({ frequency: 'QUARTERLY', endDate: null })).expect(422)).body.error).toBe('CONTRACT_SCHEDULE_FIXED');
    expect((await ctx.http().put(`${org.base}/sales/contracts/${id}`).set(owner.auth).send(body({ endDate: plusDays(months(-1), -1) })).expect(422)).body.error).toBe('CONTRACT_END');
    expect(await svc.runAll(months(1), [org.orgId])).toMatchObject({ billed: 1 });
    const c = await docs(id);
    expect(c.periods[0]).toMatchObject({ periodNo: 4, start: months(1), invoice: { total: '53100.00', issueDate: months(1) } });
  });

  it('skips the periods that fall due while paused', async () => {
    await ctx.http().post(`${org.base}/sales/contracts/${id}/pause`).set(owner.auth).expect(200);
    expect(await svc.runAll(months(3), [org.orgId])).toMatchObject({ contracts: 0, billed: 0 });
    const r = await svc.resume({ id: org.orgId, role: 'OWNER', functionalCurrency: 'INR' }, { id: owner.id }, id, months(3));
    expect(r.status).toBe('ACTIVE');
    expect(r.periods.slice(0, 3).map((p) => [p.periodNo, p.status])).toEqual([[6, 'BILLED'], [5, 'SKIPPED'], [4, 'BILLED']]);
    expect(r.events.find((e) => e.kind === 'RESUMED')!.body).toContain('1 period skipped');
  });

  it('bills a period again once its draft invoice is deleted, and only then', async () => {
    const c = await docs(id);
    const p6 = c.periods[0];
    expect((await ctx.http().post(`${org.base}/sales/contracts/${id}/periods/6/bill-again`).set(owner.auth).expect(422)).body.error).toBe('CONTRACT_PERIOD_BILLED');
    await ctx.http().delete(`${org.base}/sales/documents/${p6.invoice.id}`).set(owner.auth).expect(204);
    const after = await docs(id);
    expect(after.periods[0]).toMatchObject({ periodNo: 6, status: 'BILLED', invoice: null, canBillAgain: true });
    const again = await ctx.http().post(`${org.base}/sales/contracts/${id}/periods/6/bill-again`).set(owner.auth).expect(201);
    expect(again.body.contract.periods[0].invoice.id).toBe(again.body.documentId);
    expect((await ctx.http().post(`${org.base}/sales/contracts/${id}/periods/5/bill-again`).set(owner.auth).expect(422)).body.error).toBe('CONTRACT_PERIOD');
  });

  it('renews for another term with a price rise', async () => {
    const r = await ctx.http().post(`${org.base}/sales/contracts/${id}/renew`).set(owner.auth).send({ months: 12, upliftPercent: '5' }).expect(200);
    expect(r.body).toMatchObject({ endDate: plusDays(months(22), -1), subtotal: '47250.00', total: '55755.00' });
    expect(r.body.events[0].body).toMatch(/Renewed for 12 months: ends .* prices \+5%/);
    const list = (await ctx.http().get(`${org.base}/sales/contracts`).set(viewer.auth).expect(200)).body;
    expect(list.summary).toMatchObject({ active: 1, mrr: '47250.00', arr: '567000.00' });
  });
});

describe('renewal and ending', () => {
  it('renews automatically past the end date, and ends otherwise', async () => {
    const auto = (await ctx.http().post(`${org.base}/sales/contracts`).set(owner.auth).send(body({ title: 'Quarterly audit support', frequency: 'QUARTERLY', timing: 'ARREARS', startDate: months(-6), endDate: plusDays(T, -1), autoRenew: true, renewalMonths: 3 })).expect(201)).body;
    const a = await ctx.http().post(`${org.base}/sales/contracts/${auto.id}/activate`).set(owner.auth).expect(200);
    expect(a.body.periods.map((p: { start: string; invoice: { issueDate: string } }) => p.invoice.issueDate)).toEqual([plusDays(T, -1), plusDays(months(-3), -1)]);
    expect(a.body.renewal).toBe('PAST_END');
    await svc.runAll(T, [org.orgId]);
    const renewed = await docs(auto.id);
    expect(renewed).toMatchObject({ status: 'ACTIVE', endDate: plusDays(months(3), -1), renewal: 'RUNNING' });
    expect(renewed.events[0]).toMatchObject({ kind: 'RENEWED', actor: null });

    const once = (await ctx.http().post(`${org.base}/sales/contracts`).set(owner.auth).send(body({ title: 'Year-end accounts', frequency: 'YEARLY', startDate: months(-12), endDate: plusDays(T, -1) })).expect(201)).body;
    expect((await ctx.http().post(`${org.base}/sales/contracts/${once.id}/activate`).set(owner.auth).expect(422)).body.error).toBe('CONTRACT_END');
    await ctx.http().put(`${org.base}/sales/contracts/${once.id}`).set(owner.auth).send(body({ title: 'Year-end accounts', frequency: 'YEARLY', startDate: months(-12), endDate: plusDays(months(12), -1) })).expect(200);
    await ctx.http().post(`${org.base}/sales/contracts/${once.id}/activate`).set(owner.auth).expect(200);
    await svc.runAll(months(12), [org.orgId]);
    await svc.runAll(plusDays(months(24), 0), [org.orgId]);
    const ended = await docs(once.id);
    expect(ended).toMatchObject({ status: 'ENDED', periodsBilled: 2 });
    expect(ended.events[0].kind).toBe('ENDED');
    expect((await ctx.http().put(`${org.base}/sales/contracts/${once.id}`).set(owner.auth).send(body()).expect(422)).body.error).toBe('CONTRACT_CLOSED');
  });

  it('stops billing when cancelled, and keeps the problem when an invoice cannot be made', async () => {
    const c = (await ctx.http().post(`${org.base}/sales/contracts`).set(owner.auth).send(body({ title: 'Payroll processing', startDate: T, endDate: null })).expect(201)).body;
    await ctx.http().post(`${org.base}/sales/contracts/${c.id}/activate`).set(owner.auth).expect(200);
    await raw(`UPDATE tax_rates SET is_active = false WHERE id = '${tax18.id}'`);
    const r = await svc.runAll(months(1), [org.orgId]);
    expect(r.failed).toBeGreaterThan(0);
    const failing = await docs(c.id);
    expect(failing.lastError).toBeTruthy();
    expect(failing.events[0].kind).toBe('BILLING_FAILED');
    await svc.runAll(months(1), [org.orgId]);
    expect((await docs(c.id)).events.filter((e: { kind: string }) => e.kind === 'BILLING_FAILED')).toHaveLength(1);
    await raw(`UPDATE tax_rates SET is_active = true WHERE id = '${tax18.id}'`);
    await ctx.http().post(`${org.base}/sales/contracts/${c.id}/cancel`).set(owner.auth).send({ reason: 'Customer moved payroll in-house' }).expect(200);
    expect(await svc.runAll(months(2), [org.orgId])).toMatchObject({ failed: 0 });
    const done = await docs(c.id);
    expect(done).toMatchObject({ status: 'CANCELLED', periodsBilled: 1, cancelReason: 'Customer moved payroll in-house' });
  });
});

describe('access and guards', () => {
  it('needs sales.manage to change, and stays inside the organisation', async () => {
    const list = (await ctx.http().get(`${org.base}/sales/contracts?view=all`).set(viewer.auth).expect(200)).body;
    expect(list.can.manage).toBe(false);
    await ctx.http().post(`${org.base}/sales/contracts`).set(viewer.auth).send(body()).expect(403);
    await ctx.http().get(`${other.base}/sales/contracts/${list.contracts[0].id}`).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/sales/contracts?view=all`).set(outsider.auth).expect(200)).body.contracts).toEqual([]);
  });

  it('deletes only drafts, and the database refuses the rest', async () => {
    const d = (await ctx.http().post(`${org.base}/sales/contracts`).set(owner.auth).send(body({ title: 'Draft only' })).expect(201)).body;
    await ctx.http().delete(`${org.base}/sales/contracts/${d.id}`).set(owner.auth).expect(204);
    const active = (await ctx.http().get(`${org.base}/sales/contracts`).set(owner.auth).expect(200)).body.contracts[0];
    expect((await ctx.http().delete(`${org.base}/sales/contracts/${active.id}`).set(owner.auth).expect(422)).body.error).toBe('CONTRACT_NOT_DRAFT');
    await expect(raw(`DELETE FROM sales_contracts WHERE id = '${active.id}'`)).rejects.toThrow(/Only a draft/);
    await expect(raw(`UPDATE sales_contracts SET frequency = 'YEARLY' WHERE id = '${active.id}'`)).rejects.toThrow(/billing schedule/);
    await expect(raw(`UPDATE sales_contracts SET next_period_no = 1 WHERE id = '${active.id}'`)).rejects.toThrow(/not undone/);
    await expect(raw(`DELETE FROM sales_contract_periods WHERE contract_id = '${active.id}'`)).rejects.toThrow(/never deleted/);
    await expect(raw(`UPDATE sales_contract_events SET body = 'x' WHERE contract_id = '${active.id}'`)).rejects.toThrow(/append-only/);
    await expect(raw(`UPDATE sales_contracts SET memo = 'x' WHERE org_id = '${org.orgId}' AND status = 'CANCELLED'`)).rejects.toThrow(/cancelled contract/);
  });
});
