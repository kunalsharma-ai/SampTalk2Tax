/**
 * AP-005 recurring bills against the real API and database: a recurring bill is checked on save as
 * its first bill would be (vendor reference that varies, accounts, GST); the runner and Make due
 * bills now make every run that has fallen due exactly once, as posted bills with GST and a due
 * date, or as drafts; a locked period stops a run and keeps the error; pause, resume skipping
 * missed runs, end; shape kept once it has run; deleting a draft bill a run made keeps the run;
 * permissions, tenant isolation and the database guards.
 */
import { addDays } from '@talk2tax/accounting-engine';
import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecurringBillsService } from '../src/recurring-bills/recurring-bills.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';
import { sqlWrite } from './sql-writes';

const synthetic = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
const OWN = synthetic('29', 'ZZZCZ0201Z');
const LANDLORD = synthetic('29', 'ZZZFZ0202Z');
const NIMBUS = synthetic('29', 'ZZZFZ0203Z');

let ctx: Ctx;
let svc: RecurringBillsService;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let fyStart: string;
let periods: { id: string; startDate: string; endDate: string }[];
let g18: string;
let landlord: string;
let cloud: string;

const raw = (sql: string, ...args: unknown[]) => sqlWrite(ctx, sql, args, { bypass: true });
const R = () => `${org.base}/purchases/recurring-bills`;
const rent = (extra: Record<string, unknown> = {}) => ({
  name: 'Office rent',
  contactId: landlord,
  reference: 'RENT-{period}',
  memo: 'Rent for {month}',
  dueDays: 10,
  frequency: 'MONTHLY',
  startDate: fyStart,
  monthEnd: false,
  postMode: 'POST',
  lines: [{ accountId: org.acc['6200'], description: 'Office rent {month}', quantity: '1', unitPrice: '85000', taxRateId: g18, hsnCode: '997212' }],
  ...extra,
});

beforeAll(async () => {
  ctx = await bootApp();
  svc = ctx.app.get(RecurringBillsService);
  owner = await registerUser(ctx, 'Recurring Owner');
  viewer = await registerUser(ctx, 'Recurring Viewer');
  outsider = await registerUser(ctx, 'Recurring Outsider');
  org = await createOrg(ctx, owner, { name: 'Recurring Traders Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Recurring Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  periods = (await ctx.http().get(`${org.base}/periods`).set(owner.auth).expect(200)).body;
  periods.sort((a, b) => a.startDate.localeCompare(b.startDate));
  fyStart = periods[0]!.startDate;
  await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: OWN, legalName: 'Recurring Traders Pvt Ltd', effectiveFrom: fyStart }).expect(200);
  for (const a of (await ctx.http().get(`${org.base}/accounts`).set(owner.auth).expect(200)).body as { code: string; id: string }[]) org.acc[a.code] = a.id;
  g18 = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'GST 18%', rate: '18', kind: 'GST' }).expect(201)).body.id;
  landlord = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Koramangala Estates', isVendor: true, gstin: LANDLORD }).expect(201)).body.id;
  cloud = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Nimbus Cloud', isVendor: true, gstin: NIMBUS }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx.app.close();
});

describe('recurring bills', () => {
  let id: string;

  it('checks a recurring bill as its first bill would be checked', async () => {
    const same = await ctx.http().post(R()).set(owner.auth).send(rent({ reference: 'RENT' })).expect(422);
    expect(same.body).toMatchObject({ error: 'RECURRING_BILL_REFERENCE' });
    expect(same.body.message).toContain('{month}');
    // A yearly placeholder does not change month to month.
    expect((await ctx.http().post(R()).set(owner.auth).send(rent({ reference: 'RENT-{fy}' })).expect(422)).body.error).toBe('RECURRING_BILL_REFERENCE');
    const end = await ctx.http().post(R()).set(owner.auth).send(rent({ endDate: addDays(fyStart, -1) })).expect(422);
    expect(end.body.error).toBe('TEMPLATE_END');
    // A GST rate needs its SAC code, as on any bill.
    const sac = await ctx.http().post(R()).set(owner.auth).send(rent({ lines: [{ accountId: org.acc['6200'], quantity: '1', unitPrice: '85000', taxRateId: g18 }] })).expect(422);
    expect(JSON.stringify(sac.body)).toMatch(/HSN|SAC/);
    await ctx.http().post(R()).set(viewer.auth).send(rent()).expect(403);
    // Nothing was saved by the refused attempts.
    expect((await ctx.http().get(`${R()}?view=all`).set(owner.auth).expect(200)).body.items).toEqual([]);

    const r = await ctx.http().post(R()).set(owner.auth).send(rent({ endDate: periods.at(-1)!.endDate })).expect(201);
    id = r.body.id;
    expect(r.body).toMatchObject({ reference: 'RB-0001', name: 'Office rent', contact: { id: landlord, name: 'Koramangala Estates' }, subtotal: '85000.00', dueDays: 10, runs: [] });
    expect(r.body.schedule).toMatchObject({ frequency: 'MONTHLY', status: 'ACTIVE', postMode: 'POST', nextRunNo: 1, runsTotal: 12 });
    expect(r.body.upcoming).toHaveLength(6);
    expect(r.body.upcoming[0]).toMatchObject({ no: 1, date: fyStart, reference: `RENT-${fyStart.slice(0, 7)}` });
    expect(r.body.lines[0]).toMatchObject({ account: { code: '6200' }, amount: '85000.00', hsnCode: '997212' });
    // The check made no bill.
    expect((await ctx.http().get(`${org.base}/purchases/documents?contactId=${landlord}`).set(owner.auth).expect(200)).body.total).toBe(0);
  });

  it('makes every run that has fallen due, once, as posted bills with GST and a due date', async () => {
    const asOf = addDays(fyStart, 40); // runs 1 and 2 have fallen due
    expect(await svc.runAll(asOf, [org.orgId])).toMatchObject({ recurringBills: 1, made: 2, failed: 0 });
    expect(await svc.runAll(asOf, [org.orgId])).toMatchObject({ made: 0 });
    const t = (await ctx.http().get(`${R()}/${id}`).set(owner.auth).expect(200)).body;
    expect(t.schedule.nextRunNo).toBe(3);
    expect(t.runs.map((r: { runNo: number }) => r.runNo)).toEqual([2, 1]);
    expect(t.runs.every((r: { posted: boolean; by: string; bill: { status: string } }) => r.posted && r.by === 'Schedule' && r.bill.status === 'POSTED')).toBe(true);
    const first = t.runs[1];
    const bill = (await ctx.http().get(`${org.base}/purchases/documents/${first.bill.id}`).set(owner.auth).expect(200)).body;
    expect(bill).toMatchObject({ kind: 'BILL', status: 'POSTED', reference: `RENT-${fyStart.slice(0, 7)}`, issueDate: fyStart, dueDate: addDays(fyStart, 10), total: '100300.00', taxTotal: '15300.00' });
    expect(bill.number).toMatch(/^BILL-/);
    expect(bill.memo).toMatch(/^Rent for /);
    expect(bill.lines[0].description).toMatch(/^Office rent [A-Z][a-z]+ \d{4}$/);
    expect(first.bill).toMatchObject({ number: bill.number, total: '100300.00' });
  });

  it('stops at a locked period, keeps the error, and runs once the period opens', async () => {
    const third = periods[2]!;
    await ctx.http().post(`${org.base}/periods/${third.id}/lock`).set(owner.auth).expect(200);
    const asOf = addDays(third.startDate, 1);
    expect(await svc.runAll(asOf, [org.orgId])).toMatchObject({ made: 0, failed: 1 });
    const t = (await ctx.http().get(`${R()}/${id}`).set(owner.auth).expect(200)).body;
    expect(t.schedule.lastError).toMatch(/LOCKED/);
    expect(t.schedule.nextRunNo).toBe(3);
    await ctx.http().post(`${org.base}/periods/${third.id}/unlock`).set(owner.auth).expect(200);
    expect(await svc.runAll(asOf, [org.orgId])).toMatchObject({ made: 1, failed: 0 });
    expect((await ctx.http().get(`${R()}/${id}`).set(owner.auth).expect(200)).body.schedule).toMatchObject({ nextRunNo: 4, lastError: null });
  });

  it('pauses, resumes skipping the missed runs, and keeps its shape once it has run', async () => {
    await ctx.http().post(`${R()}/${id}/pause`).set(owner.auth).expect(200);
    expect(await svc.runAll(addDays(periods[6]!.startDate, 1), [org.orgId])).toMatchObject({ recurringBills: 0 });
    await ctx.http().post(`${R()}/${id}/resume`).set(viewer.auth).send({}).expect(403);
    const resumed = (await ctx.http().post(`${R()}/${id}/resume`).set(owner.auth).send({ skipMissed: true }).expect(200)).body;
    expect(resumed.schedule.status).toBe('ACTIVE');
    expect(resumed.schedule.nextRunNo).toBeGreaterThanOrEqual(4);
    expect(resumed.runs).toHaveLength(3);

    const reshaped = await ctx.http().put(`${R()}/${id}`).set(owner.auth).send(rent({ frequency: 'QUARTERLY' })).expect(409);
    expect(reshaped.body.error).toBe('RECURRING_BILL_RAN');
    expect((await ctx.http().put(`${R()}/${id}`).set(owner.auth).send(rent({ contactId: cloud })).expect(409)).body.error).toBe('RECURRING_BILL_RAN');
    // The amount, the end date and the posting can change; later bills use the new lines.
    const changed = (await ctx.http().put(`${R()}/${id}`).set(owner.auth).send(rent({ endDate: null, postMode: 'DRAFT', lines: [{ accountId: org.acc['6200'], quantity: '1', unitPrice: '90000', taxRateId: g18, hsnCode: '997212' }] })).expect(200)).body;
    expect(changed.schedule).toMatchObject({ endDate: null, postMode: 'DRAFT', runsTotal: null, status: 'ACTIVE' });
    expect(changed.subtotal).toBe('90000.00');

    await expect(raw(`UPDATE recurring_bills SET next_run_no = 1 WHERE id = '${id}'`)).rejects.toThrow(/not undone/);
    await expect(raw(`UPDATE recurring_bills SET frequency = 'YEARLY' WHERE id = '${id}'`)).rejects.toThrow(/keeps its vendor/);
    await expect(raw(`UPDATE recurring_bills SET number = 9 WHERE id = '${id}'`)).rejects.toThrow(/keeps its number/);
    await expect(raw(`UPDATE recurring_bill_runs SET run_date = run_date + 1 WHERE recurring_bill_id = '${id}'`)).rejects.toThrow(/append-only/);
    await expect(raw(`DELETE FROM recurring_bill_runs WHERE recurring_bill_id = '${id}'`)).rejects.toThrow(/append-only/);
    expect((await ctx.http().delete(`${R()}/${id}`).set(owner.auth).expect(409)).body.error).toBe('RECURRING_BILL_USED');

    const ended = (await ctx.http().post(`${R()}/${id}/end`).set(owner.auth).expect(200)).body;
    expect(ended.schedule.status).toBe('ENDED');
    expect(ended.upcoming).toEqual([]);
    expect((await ctx.http().post(`${R()}/${id}/resume`).set(owner.auth).send({}).expect(409)).body.error).toBe('RECURRING_BILL_ENDED');
  });

  it('makes drafts by Make due bills now; deleting a draft keeps the run; a repeated vendor reference is refused on save', async () => {
    const q = (await ctx.http().post(R()).set(owner.auth).send(rent({ name: 'Cloud hosting', contactId: cloud, reference: 'NIMBUS-{date}', memo: null, dueDays: null, postMode: 'DRAFT', frequency: 'QUARTERLY', endDate: addDays(fyStart, 95), lines: [{ accountId: org.acc['6600'], quantity: '2', unitPrice: '12500.50', taxRateId: g18, hsnCode: '998315' }] })).expect(201)).body;
    expect(q.schedule.runsTotal).toBe(2);
    expect(q.subtotal).toBe('25001.00');
    const ran = (await ctx.http().post(`${R()}/${q.id}/run-due`).set(owner.auth).expect(200)).body;
    expect(ran.error).toBeNull();
    expect(ran.made).toBeGreaterThanOrEqual(1);
    const runs = ran.recurringBill.runs;
    expect(runs.every((r: { posted: boolean; by: string; bill: { status: string } }) => !r.posted && r.by === 'Recurring Owner' && r.bill.status === 'DRAFT')).toBe(true);
    if (ran.made === 2) expect(ran.recurringBill.schedule.status).toBe('ENDED');
    // The vendor's payment terms set the due date when the recurring bill gives none.
    const draft = (await ctx.http().get(`${org.base}/purchases/documents/${runs.at(-1).bill.id}`).set(owner.auth).expect(200)).body;
    expect(draft).toMatchObject({ status: 'DRAFT', reference: `NIMBUS-${fyStart}`, memo: 'RB-0002 Cloud hosting' });
    // Deleting the draft keeps the run, without its bill.
    await ctx.http().delete(`${org.base}/purchases/documents/${draft.id}`).set(owner.auth).expect(204);
    const after = (await ctx.http().get(`${R()}/${q.id}`).set(owner.auth).expect(200)).body;
    expect(after.runs.find((r: { runNo: number }) => r.runNo === 1)).toMatchObject({ bill: null });

    // A third schedule whose next bill repeats a reference already entered for the vendor is refused on save.
    await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: cloud, issueDate: fyStart, reference: `NIMBUS-X-${fyStart}`, lines: [{ accountId: org.acc['6600'], quantity: '1', unitPrice: '10', taxRateId: g18, hsnCode: '998315' }] }).expect(201);
    const dup = await ctx.http().post(R()).set(owner.auth).send(rent({ name: 'Dup', contactId: cloud, reference: 'NIMBUS-X-{date}', postMode: 'DRAFT', lines: [{ accountId: org.acc['6600'], quantity: '1', unitPrice: '10', taxRateId: g18, hsnCode: '998315' }] })).expect(409);
    expect(dup.body.error).toBe('DUPLICATE_BILL');

    // A viewer sees recurring bills but cannot run them.
    await ctx.http().get(`${R()}?view=ended`).set(viewer.auth).expect(200);
    await ctx.http().post(`${R()}/${q.id}/run-due`).set(viewer.auth).expect(403);
  });

  it('lists by view and deletes one that never ran', async () => {
    const all = (await ctx.http().get(`${R()}?view=all`).set(owner.auth).expect(200)).body;
    expect(all.counts.all).toBe(2);
    expect(all.can).toEqual({ manage: true, post: true });
    expect(all.items.map((i: { reference: string }) => i.reference)).toEqual(['RB-0001', 'RB-0002']);
    const fresh = (await ctx.http().post(R()).set(owner.auth).send(rent({ name: 'Later lease', startDate: addDays(periods.at(-1)!.endDate, 400), postMode: 'DRAFT' })).expect(201)).body;
    await ctx.http().delete(`${R()}/${fresh.id}`).set(viewer.auth).expect(403);
    await ctx.http().delete(`${R()}/${fresh.id}`).set(owner.auth).expect(204);
    await ctx.http().get(`${R()}/${fresh.id}`).set(owner.auth).expect(404);
  });

  it('keeps each organisation to its own recurring bills', async () => {
    const mine = (await ctx.http().get(`${R()}?view=all`).set(owner.auth).expect(200)).body.items[0];
    await ctx.http().get(`${other.base}/purchases/recurring-bills/${mine.id}`).set(outsider.auth).expect(404);
    await ctx.http().get(R()).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/purchases/recurring-bills?view=all`).set(outsider.auth).expect(200)).body.items).toEqual([]);
    // Another organisation's vendor cannot be used.
    const r = await ctx.http().post(`${other.base}/purchases/recurring-bills`).set(outsider.auth).send(rent({ lines: [{ accountId: other.acc['6200'], quantity: '1', unitPrice: '1' }] }));
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('RECURRING_BILL_VENDOR');
  });
});
