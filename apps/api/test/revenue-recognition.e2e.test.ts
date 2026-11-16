import { addMonth, fiscalYearForDate, monthEnd } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';
import { sqlWrite } from './sql-writes';

/**
 * Revenue recognition (AR-028) against the real API and database: the deferred revenue account,
 * service periods on a draft invoice's lines, posting that credits those lines to deferred revenue
 * and opens a schedule per line, the monthly release run recognising it, the waterfall, voiding
 * the invoice (which takes back what was recognised and ends the schedules), and the guards.
 */
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const M = T.slice(0, 7);
const M1 = addMonth(M, -1);

let ctx: Ctx;
let owner: TestUser;
let sales: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let customer: { id: string };
let tax18: { id: string };
let invId: string;
const R = () => `${org.base}/sales/revenue-recognition`;
const rec = (id = invId) => `${org.base}/sales/documents/${id}/recognition`;

const raw = (sql: string, ...args: unknown[]) => sqlWrite(ctx, sql, args, { bypass: true });
const entryById = async (id: string) => (await ctx.http().get(`${org.base}/journals/${id}`).set(owner.auth).expect(200)).body;
const entryByNumber = async (n: number) => {
  const list = (await ctx.http().get(`${org.base}/journals?limit=200`).set(owner.auth).expect(200)).body;
  return entryById((list.items ?? list).find((j: { entryNumber: number }) => j.entryNumber === n).id);
};
const lineMap = (e: { lines: { accountId: string; debit: string; credit: string }[] }) =>
  Object.fromEntries(
    Object.entries(org.acc)
      .filter(([, id]) => e.lines.some((l) => l.accountId === id))
      .map(([code, id]) => [code, e.lines.filter((l) => l.accountId === id).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0).toFixed(2)]),
  );
const tb = async (code: string) => {
  const t = (await ctx.http().get(`${org.base}/reports/trial-balance?asOf=${T}`).set(owner.auth).expect(200)).body;
  return t.rows.find((r: { code: string }) => r.code === code)?.balance ?? '0.00';
};
const draft = (lines = [
  { accountId: org.acc['4100'], description: 'Annual support plan', quantity: '1', unitPrice: '120000.00', taxRateId: tax18.id },
  { accountId: org.acc['4200'], description: 'Setup', quantity: '1', unitPrice: '5000.00' },
]) => ({ kind: 'INVOICE', contactId: customer.id, issueDate: `${M1}-01`, lines });

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Recognition Owner');
  sales = await registerUser(ctx, 'Recognition Accountant');
  viewer = await registerUser(ctx, 'Recognition Viewer');
  org = await createOrg(ctx, owner, { name: 'Recurring Software Pvt Ltd' });
  for (const [u, role] of [[sales, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  const fy = fiscalYearForDate(T, 4);
  for (const y of [fy - 1, fy, fy + 1]) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: y });
  customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Helix Labs', isCustomer: true, paymentTermsDays: 15 }).expect(201)).body;
  tax18 = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'Standard 18%', rate: '18', salesAccountId: org.acc['2300'], purchaseAccountId: org.acc['1450'] }).expect(201)).body;
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('revenue recognition', () => {
  it('uses the standard deferred revenue account until another is chosen', async () => {
    const s = (await ctx.http().get(`${R()}/settings`).set(viewer.auth).expect(200)).body;
    expect(s).toMatchObject({ deferredAccount: { code: '2350' }, chosen: false, can: { manage: false, settings: false } });
    await ctx.http().put(`${R()}/settings`).set(viewer.auth).send({ deferredAccountId: org.acc['2350'] }).expect(403);
    expect((await ctx.http().put(`${R()}/settings`).set(owner.auth).send({ deferredAccountId: org.acc['2000'] ?? org.acc['1200'] }).expect(422)).body.message).toMatch(/liability account/);
    const saved = (await ctx.http().put(`${R()}/settings`).set(owner.auth).send({ deferredAccountId: org.acc['2350'] }).expect(200)).body;
    expect(saved).toMatchObject({ deferredAccount: { code: '2350' }, chosen: true });
  });

  it('sets a service period on a draft invoice line, and checks it', async () => {
    invId = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send(draft()).expect(201)).body.id;
    const before = (await ctx.http().get(rec()).set(viewer.auth).expect(200)).body;
    expect(before).toMatchObject({ status: 'DRAFT', deferredAccountReady: true });
    expect(before.lines.map((l: { lineNo: number; revenue: boolean; recognition: unknown }) => [l.lineNo, l.revenue, l.recognition])).toEqual([[1, true, null], [2, true, null]]);
    const terms = { lineNo: 1, startDate: `${M1}-01`, months: 12, method: 'EVEN' };
    await ctx.http().put(rec()).set(viewer.auth).send({ lines: [terms] }).expect(403);
    expect((await ctx.http().put(rec()).set(sales.auth).send({ lines: [{ ...terms, lineNo: 3 }] }).expect(422)).body).toMatchObject({ error: 'RECOGNITION_INVALID', message: 'The invoice has no line 3' });
    expect((await ctx.http().put(rec()).set(sales.auth).send({ lines: [terms, terms] }).expect(422)).body.message).toBe('Line 1 is given twice');
    await ctx.http().put(rec()).set(sales.auth).send({ lines: [{ ...terms, months: 0 }] }).expect(400);
    const r = (await ctx.http().put(rec()).set(sales.auth).send({ lines: [terms] }).expect(200)).body;
    expect(r.lines[0].recognition).toEqual({ startDate: `${M1}-01`, months: 12, method: 'EVEN', endDate: monthEnd(addMonth(M1, 11)) });
    expect(r.lines[1].recognition).toBeNull();
  });

  it('posts the service line to deferred revenue and opens a schedule for it', async () => {
    const posted = (await ctx.http().post(`${org.base}/sales/documents/${invId}/post`).set(owner.auth).send({}).expect(200)).body;
    const je = await entryById(posted.journalEntryId);
    expect(lineMap(je)).toEqual({ '1200': '146600.00', '2300': '-21600.00', '2350': '-120000.00', '4200': '-5000.00' });
    const r = (await ctx.http().get(rec()).set(viewer.auth).expect(200)).body;
    expect(r.status).toBe('POSTED');
    expect(r.lines[0].schedule).toMatchObject({ reference: 'DR-0001', amount: '120000.00', recognised: '0.00', deferred: '120000.00', status: 'ACTIVE' });
    const s = (await ctx.http().get(`${org.base}/deferrals/${r.lines[0].schedule.id}`).set(owner.auth).expect(200)).body;
    expect(s).toMatchObject({ kind: 'DEFERRED_REVENUE', counterparty: 'Helix Labs', firstMonth: M1 });
    const terms = { name: s.name, counterparty: s.counterparty, balanceAccountId: org.acc['2350'], pnlAccountId: org.acc['4100'], amount: '120000.00', startDate: `${M1}-01`, months: 6, method: 'EVEN' };
    expect((await ctx.http().put(`${org.base}/deferrals/${s.id}`).set(owner.auth).send(terms).expect(409)).body.message).toMatch(/comes from invoice/);
    expect(s.name).toBe(`${posted.number} line 1: Annual support plan`);
    expect(await tb('2350')).toBe('120000.00');
  });

  it('keeps the terms of a posted invoice', async () => {
    expect((await ctx.http().put(rec()).set(owner.auth).send({ lines: [] }).expect(422)).body.error).toBe('NOT_DRAFT');
    await expect(raw(`DELETE FROM invoice_line_recognition WHERE document_id = $1::uuid`, invId)).rejects.toThrow(/posted invoice is kept/);
    await expect(raw(`UPDATE invoice_line_recognition SET months = 6 WHERE document_id = $1::uuid`, invId)).rejects.toThrow(/posted invoice is kept/);
    await expect(raw(`INSERT INTO invoice_line_recognition (org_id, document_id, line_no, start_date, months, method, created_by_id, updated_at) SELECT org_id, document_id, 2, start_date, 1, 'EVEN', created_by_id, now() FROM invoice_line_recognition WHERE document_id = $1::uuid`, invId)).rejects.toThrow(/while the invoice is a draft/);
  });

  it('refuses to post a line set to a non-revenue account, and a draft whose line was removed', async () => {
    const d = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send(draft([{ accountId: org.acc['4100'], description: 'Hosting', quantity: '1', unitPrice: '12000.00', taxRateId: null } as never])).expect(201)).body;
    await ctx.http().put(rec(d.id)).set(sales.auth).send({ lines: [{ lineNo: 1, startDate: `${M}-01`, months: 3, method: 'DAILY' }] }).expect(200);
    // The line is changed to a balance sheet account after the terms were set.
    await ctx.http().put(`${org.base}/sales/documents/${d.id}`).set(owner.auth).send(draft([{ accountId: org.acc['2350'], description: 'Hosting', quantity: '1', unitPrice: '12000.00' } as never])).expect(200);
    expect((await ctx.http().post(`${org.base}/sales/documents/${d.id}/post`).set(owner.auth).send({}).expect(422)).body.message).toBe('Line 1: only a line to a revenue account can be recognised over time');
    await ctx.http().put(rec(d.id)).set(sales.auth).send({ lines: [] }).expect(200);
    await ctx.http().delete(`${org.base}/sales/documents/${d.id}`).set(owner.auth).expect(204);
  });

  it('recognises a month through the release run, and shows the waterfall', async () => {
    const run = (await ctx.http().post(`${org.base}/deferrals/releases/runs`).set(owner.auth).send({ month: M1 }).expect(201)).body;
    const je = await entryByNumber(run.runs[0].entry.entryNumber);
    expect(lineMap(je)).toEqual({ '2350': '10000.00', '4100': '-10000.00' });
    const o = (await ctx.http().get(`${R()}?from=${M1}`).set(viewer.auth).expect(200)).body;
    expect(o.totals).toEqual({ lines: 1, deferredNow: '110000.00', recognised: '10000.00' });
    expect(o.lines[0]).toMatchObject({ documentId: invId, customer: { name: 'Helix Labs' }, lineNo: 1, months: 12 });
    expect(o.waterfall.months).toHaveLength(12);
    expect(o.waterfall.months.slice(0, 2)).toEqual([{ month: M1, amount: '10000.00' }, { month: M, amount: '10000.00' }]);
    expect(o.waterfall).toMatchObject({ before: '0.00', after: '0.00', total: '120000.00' });
    await ctx.http().get(`${R()}?from=2026-13`).set(viewer.auth).expect(400);
  });

  it('voiding the invoice takes back what was recognised and ends the schedule', async () => {
    const v = (await ctx.http().post(`${org.base}/sales/documents/${invId}/void`).set(owner.auth).send({ date: T, reason: 'Customer cancelled before go-live' }).expect(200)).body;
    expect(v.status).toBe('VOID');
    const r = (await ctx.http().get(rec()).set(viewer.auth).expect(200)).body;
    expect(r.lines[0].schedule).toMatchObject({ status: 'ENDED', deferred: '0.00', endedOn: T });
    const s = (await ctx.http().get(`${org.base}/deferrals/${r.lines[0].schedule.id}`).set(owner.auth).expect(200)).body;
    const n = Number(/journal #(\d+)/.exec(s.end.note)![1]);
    expect(s.end).toMatchObject({ amount: "0.00", entry: null });
    expect(s.end.note).toBe(`${v.number} voided; 10000.00 recognised was taken back in journal #${n}`);
    expect(lineMap(await entryByNumber(n))).toEqual({ '2350': '-10000.00', '4100': '10000.00' });
    for (const code of ['1200', '2300', '2350', '4100', '4200']) expect(await tb(code)).toBe('0.00');
    const o = (await ctx.http().get(`${R()}?from=${M}`).set(viewer.auth).expect(200)).body;
    expect(o.totals.deferredNow).toBe('0.00');
    expect(o.waterfall.months[1]).toEqual({ month: addMonth(M, 1), amount: '0.00' });
  });
});
