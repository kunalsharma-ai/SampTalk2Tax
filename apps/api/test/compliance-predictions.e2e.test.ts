import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Compliance deadline predictions (TAX-047): GSTR-1 filed late three months running is predicted
 * late again; GSTR-3B filed early is on track unless the books disagree with the month's documents.
 * Real API and DB.
 */
const synthetic = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;

let ctx: Ctx;
let owner: TestUser;
let employee: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const T = today();
const monthOf = (back: number) => {
  const d = new Date(`${T.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - back);
  return d.toISOString().slice(0, 7);
};
const next = (m: string) => monthOf(0) === m ? monthOf(-1) : (() => { const d = new Date(`${m}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 7); })();
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10); // not money
type Prediction = { key: string; risk: string; history: number; late: number; lateRate: string | null; usualLeadDays: number | null; reasons: string[]; signals: { severity: string; message: string }[]; dueDate: string };

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Deadline Owner');
  employee = await registerUser(ctx, 'Deadline Employee');
  org = await createOrg(ctx, owner);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: employee.email, role: 'EMPLOYEE' }).expect(201);
  for (const m of [4, 3, 2, 1].map(monthOf)) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fiscalYearForDate(`${m}-01`, 4) });
  await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: synthetic('29', 'ZZZDP0001Z'), legalName: 'Deadline Test Pvt Ltd', effectiveFrom: `${monthOf(4)}-01` }).expect(200);
  for (const a of (await ctx.http().get(`${org.base}/accounts`).set(owner.auth).expect(200)).body as { code: string; id: string }[]) org.acc[a.code] = a.id;
  // Months 4, 3 and 2 back: GSTR-1 filed three days late, GSTR-3B five days early.
  for (const back of [4, 3, 2]) {
    const m = monthOf(back);
    const n = next(m);
    await ctx.http().post(`${org.base}/compliance/filings`).set(owner.auth).send({ key: `GSTR1:${m}`, filedOn: `${n}-14`, reference: `ARN1${back}` }).expect(201);
    await ctx.http().post(`${org.base}/compliance/filings`).set(owner.auth).send({ key: `GSTR3B:${m}`, filedOn: `${n}-15`, reference: `ARN3${back}` }).expect(201);
  }
  // Last month, a manual journal on Output IGST: the books will not agree with the documents.
  await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: `${monthOf(1)}-20`, post: true, memo: 'IGST correction', lines: [{ accountId: org.acc['6400'], debit: '500.00' }, { accountId: org.acc['2312'], credit: '500.00' }] }).expect(201);
});
afterAll(async () => ctx?.app.close());

describe('compliance deadline predictions', () => {
  it('predicts a habitually late return late, and flags books that disagree', async () => {
    const r = (await ctx.http().get(`${org.base}/compliance/predictions`).set(owner.auth).expect(200)).body as { items: Prediction[]; summary: { high: number }; history: number; configured: boolean };
    expect(r.configured).toBe(true);
    const by = (key: string) => r.items.find((i) => i.key === key)!;
    const g1 = by(`GSTR1:${monthOf(1)}`);
    expect(g1).toMatchObject({ risk: 'HIGH', history: 3, late: 3, lateRate: '100', usualLeadDays: -3 });
    const g1Overdue = g1.dueDate < T;
    expect(g1.reasons).toEqual(g1Overdue ? [expect.stringMatching(/^Overdue by \d+ days?$/), 'Late 3 of the last 3 times'] : ['Late 3 of the last 3 times', 'Usually done 3 days after the due date']);
    const g3 = by(`GSTR3B:${monthOf(1)}`);
    expect(g3).toMatchObject({ history: 3, late: 0, lateRate: '0', usualLeadDays: 5 });
    expect(g3.signals).toEqual([{ severity: 'WARN', message: expect.stringMatching(/^The GST accounts and .+'s documents differ \(1 item to explain\)$/) }]);
    // Overdue makes it high; otherwise the warning, and a usual date possibly gone by, make it at risk.
    expect(g3.risk).toBe(g3.dueDate < T ? 'HIGH' : 'MEDIUM');
    // Worst first.
    const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as Record<string, number>;
    expect(r.items.map((i) => rank[i.risk])).toEqual([...r.items.map((i) => rank[i.risk]!)].sort((a, b) => a - b));
    expect(r.summary.high).toBe(r.items.filter((i) => i.risk === 'HIGH').length);
    expect(r.history).toBeGreaterThanOrEqual(6);
  });

  it('an organisation that always files early is on track for the month to come', async () => {
    const r = (await ctx.http().get(`${org.base}/compliance/predictions`).query({ days: 120 }).set(owner.auth).expect(200)).body as { items: Prediction[] };
    const later = r.items.find((i) => i.key === `GSTR3B:${monthOf(0)}`)!;
    // The current month has not ended: no books signals yet, and GSTR-3B has always been early.
    expect(later.signals).toEqual([]);
    // Last month's GSTR-3B (due the 20th) counts as a late period once its due date has passed unfiled.
    const prior = r.items.find((i) => i.key === `GSTR3B:${monthOf(1)}`);
    const priorOverdue = prior !== undefined && prior.dueDate < T;
    expect(later.late).toBe(priorOverdue ? 1 : 0);
    expect(later.risk).toBe(priorOverdue || addDays(later.dueDate, -5) < T ? 'MEDIUM' : 'LOW');
  });

  it('needs reports access and a sensible window', async () => {
    await ctx.http().get(`${org.base}/compliance/predictions`).set(employee.auth).expect(403);
    await ctx.http().get(`${org.base}/compliance/predictions`).query({ days: 400 }).set(owner.auth).expect(400);
    await ctx.http().get(`${org.base}/compliance/predictions`).set((await registerUser(ctx, 'Outsider')).auth).expect(404);
  });
});
