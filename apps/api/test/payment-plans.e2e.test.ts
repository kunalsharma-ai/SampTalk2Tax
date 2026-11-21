import { addDays, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInOrg } from '../src/common/tenant-context';
import { paymentPlans } from '../src/db/collections/payment-plans';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Suggested payment plans (AR-040) against the real API and database: suggestions sized to what
 * each customer has paid a month lately, disputed invoices left out, a plan agreed from the
 * suggestion (never from amounts in the request), progress from money received since, a broken
 * plan, cancelling, permissions, the record kept as it was, and tenant isolation.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const c: Record<string, string> = {};
const inv: Record<string, { id: string; number: string }> = {};

const invoice = async (who: string, issueDate: string, amount: string, dueIn = 30) => {
  const r = await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: c[who], issueDate, dueDate: addDays(issueDate, dueIn), post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; number: string };
};
const receipt = (who: string, date: string, documentId: string, amount: string) =>
  ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: c[who], date, bankAccountId: org.acc['1120'], amount, allocations: [{ documentId, amount }] }).expect(201);
type Instalment = { no: number; dueDate: string; amount: string; paid: string; status: string };
type Plan = { id: string; reference: string; customer: string; total: string; status: string; statusLabel: string; suggestedInstalments: number; invoices: { number: string; outstanding: string }[]; progress: { paid: string; remaining: string; behindBy: string; instalments: Instalment[]; next: { no: number; amount: string } | null }; cancelReason: string | null };
type Candidate = { contactId: string; customer: string; total: string; monthlyReceipts: string | null; recommended: number; schedule: { amount: string }[]; leftOut: { number: string }[]; reasons: string[]; options: { instalments: number; recommended: boolean }[] };
type List = { asOf: string; summary: Record<string, number | string>; candidates: Candidate[]; plans: Plan[] };
const list = async (user = owner) => (await ctx.http().get(`${org.base}/payment-plans`).set(user.auth).expect(200)).body as List;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Plan Owner');
  viewer = await registerUser(ctx, 'Plan Viewer');
  outsider = await registerUser(ctx, 'Plan Outsider');
  org = await createOrg(ctx, owner, { name: 'Plan Traders Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Plan Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fiscalYearForDate(T, 4) - 1 });
  for (const name of ['Asha Traders', 'Banyan Retail', 'Cedar Foods', 'Deodar Mills']) c[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, isCustomer: true }).expect(201)).body.id;
  // Asha paid 60,000 twice in the last six months (20,000 a month), and now owes 90,000 overdue.
  await receipt('Asha Traders', addDays(T, -100), (await invoice('Asha Traders', addDays(T, -150), '60000.00')).id, '60000.00');
  await receipt('Asha Traders', addDays(T, -20), (await invoice('Asha Traders', addDays(T, -60), '60000.00')).id, '60000.00');
  inv.a1 = await invoice('Asha Traders', addDays(T, -70), '60000.00');
  inv.a2 = await invoice('Asha Traders', addDays(T, -40), '30000.00');
  inv.a3 = await invoice('Asha Traders', T, '5000.00');
  // Banyan: 9,000 overdue and a disputed 4,000; nothing received lately.
  inv.b1 = await invoice('Banyan Retail', addDays(T, -45), '9000.00');
  inv.b2 = await invoice('Banyan Retail', addDays(T, -35), '4000.00');
  await ctx.http().post(`${org.base}/sales/disputes`).set(owner.auth).send({ documentId: inv.b2.id, reason: 'QUALITY', description: 'Short delivery' }).expect(201);
  // Cedar: only a disputed invoice. Deodar: nothing overdue.
  const cedar = await invoice('Cedar Foods', addDays(T, -40), '20000.00');
  await ctx.http().post(`${org.base}/sales/disputes`).set(owner.auth).send({ documentId: cedar.id, reason: 'QUALITY', description: 'Damaged on arrival' }).expect(201);
  await invoice('Deodar Mills', T, '7000.00');
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('payment plans', () => {
  it('suggests plans sized to what each customer has paid lately, leaving disputes out', async () => {
    const r = await list(viewer);
    expect(r.asOf).toBe(T);
    expect(r.candidates.map((x) => x.customer)).toEqual(['Asha Traders', 'Banyan Retail']);
    const [asha, banyan] = r.candidates;
    expect(asha).toMatchObject({ total: '90000.00', monthlyReceipts: '20000.00', recommended: 5, leftOut: [] });
    expect(asha!.schedule.map((s) => s.amount)).toEqual(['18000.00', '18000.00', '18000.00', '18000.00', '18000.00']);
    expect(asha!.options.find((o) => o.recommended)!.instalments).toBe(5);
    expect(banyan).toMatchObject({ total: '9000.00', monthlyReceipts: null, recommended: 3, leftOut: [{ number: inv.b2!.number }] });
    expect(banyan!.reasons.join(' ')).toMatch(/1 disputed invoice left out/);
    expect(r.summary).toMatchObject({ running: 0, candidates: 2, remaining: '0.00' });
  });

  it('suggests a plan with chosen instalments and checks the choice', async () => {
    const q = (s: string, user = owner) => ctx.http().get(`${org.base}/payment-plans/suggest?${s}`).set(user.auth);
    const r = (await q(`contactId=${c['Asha Traders']}&instalments=4&firstDueDate=${addDays(T, 10)}`, viewer).expect(200)).body;
    expect(r).toMatchObject({ customer: 'Asha Traders', runningPlan: null, suggestion: { instalments: 4, recommended: 5, firstDueDate: addDays(T, 10) } });
    expect(r.suggestion.schedule.map((s: { amount: string }) => s.amount)).toEqual(['22500.00', '22500.00', '22500.00', '22500.00']);
    expect((await q(`contactId=${c['Asha Traders']}&firstDueDate=${addDays(T, -1)}`).expect(422)).body.message).toMatch(/past/);
    await q(`contactId=${c['Asha Traders']}&instalments=13`).expect(400);
    await q(`contactId=${c['Asha Traders']}&amount=1`).expect(400);
    await q(`contactId=${other.orgId}`).expect(404);
    expect((await q(`contactId=${c['Deodar Mills']}`).expect(200)).body.suggestion).toBeNull();
  });

  it('agrees a plan from the suggestion and tracks money received against it', async () => {
    const body = { contactId: c['Asha Traders'], instalments: 5, firstDueDate: addDays(T, 7), note: 'Agreed on a call' };
    await ctx.http().post(`${org.base}/payment-plans`).set(viewer.auth).send(body).expect(403);
    await ctx.http().post(`${org.base}/payment-plans`).set(owner.auth).send({ ...body, total: '1.00' }).expect(400);
    const p = (await ctx.http().post(`${org.base}/payment-plans`).set(owner.auth).send(body).expect(201)).body as Plan;
    expect(p).toMatchObject({ reference: expect.stringMatching(/^PP-\d{3}$/), customer: 'Asha Traders', total: '90000.00', status: 'ON_TRACK', statusLabel: 'On track', suggestedInstalments: 5 });
    expect(p.invoices.map((i) => i.number)).toEqual([inv.a1!.number, inv.a2!.number]);
    expect(p.progress.instalments.map((i) => [i.dueDate, i.status])[0]).toEqual([addDays(T, 7), 'DUE']);
    const again = await ctx.http().post(`${org.base}/payment-plans`).set(owner.auth).send(body).expect(409);
    expect(again.body.message).toMatch(new RegExp(`already has payment plan ${p.reference}`));
    expect((await ctx.http().post(`${org.base}/payment-plans`).set(owner.auth).send({ ...body, contactId: c['Cedar Foods'] }).expect(422)).body.error).toBe('NOTHING_OVERDUE');

    await receipt('Asha Traders', T, inv.a1!.id, '25000.00');
    const now = (await ctx.http().get(`${org.base}/payment-plans/${p.id}`).set(viewer.auth).expect(200)).body as Plan;
    expect(now.progress).toMatchObject({ paid: '25000.00', remaining: '65000.00', behindBy: '0.00', next: { no: 2, amount: '11000.00' } });
    expect(now.progress.instalments.slice(0, 2).map((i) => [i.paid, i.status])).toEqual([
      ['18000.00', 'PAID'],
      ['7000.00', 'PART_PAID'],
    ]);
    const r = await list();
    expect(r.candidates.map((x) => x.customer)).toEqual(['Banyan Retail']);
    expect(r.summary).toMatchObject({ running: 1, onTrack: 1, remaining: '65000.00' });

    await expect(runInOrg(org.orgId, () => ctx.store.collection(paymentPlans).updateOne({ id: p.id }, { $set: { total: '1.00' } }))).rejects.toThrow(/keeps its invoices and instalments/);
    await expect(runInOrg(org.orgId, () => ctx.store.collection(paymentPlans).deleteOne({ id: p.id }))).rejects.toThrow(/kept as a record/);
  });

  it('shows a broken plan, and cancels a plan with a reason', async () => {
    const p = (await ctx.http().post(`${org.base}/payment-plans`).set(owner.auth).send({ contactId: c['Banyan Retail'], instalments: 3, firstDueDate: T }).expect(201)).body as Plan;
    expect(p.progress.instalments.map((i) => i.amount)).toEqual(['3000.00', '3000.00', '3000.00']);
    // The first instalment ten days ago, unpaid: written straight to the database to move time on.
    await ctx.db.collection('payment_plans').updateOne({ _id: p.id } as never, { $set: { 'instalments.0.dueDate': addDays(T, -10) } });
    const broken = (await ctx.http().get(`${org.base}/payment-plans/${p.id}`).set(owner.auth).expect(200)).body as Plan;
    expect(broken).toMatchObject({ status: 'BROKEN', progress: { behindBy: '3000.00', instalments: [{ status: 'LATE' }, {}, {}] } });
    expect((await list()).summary).toMatchObject({ running: 2, broken: 1, behindBy: '3000.00' });

    await ctx.http().post(`${org.base}/payment-plans/${p.id}/cancel`).set(viewer.auth).send({ reason: 'Customer stopped paying' }).expect(403);
    await ctx.http().post(`${org.base}/payment-plans/${p.id}/cancel`).set(owner.auth).send({ reason: '' }).expect(400);
    const cancelled = (await ctx.http().post(`${org.base}/payment-plans/${p.id}/cancel`).set(owner.auth).send({ reason: 'Customer stopped paying' }).expect(201)).body as Plan;
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Customer stopped paying', progress: { next: null } });
    expect((await ctx.http().post(`${org.base}/payment-plans/${p.id}/cancel`).set(owner.auth).send({ reason: 'Again please' }).expect(409)).body.error).toBe('ALREADY_CANCELLED');
    expect((await list()).candidates.map((x) => x.customer)).toEqual(['Banyan Retail']);

    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=payment_plan`).set(owner.auth).expect(200)).body;
    const actions = ((audit.items ?? audit) as { action: string }[]).map((x) => x.action);
    expect(actions.filter((a) => a === 'payment_plan.agreed')).toHaveLength(2);
    expect(actions).toContain('payment_plan.cancelled');
  });

  it('keeps organisations apart', async () => {
    await ctx.http().get(`${org.base}/payment-plans`).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/payment-plans`).set(outsider.auth).expect(200)).body).toMatchObject({ candidates: [], plans: [] });
    const mine = (await list()).plans[0]!;
    await ctx.http().get(`${other.base}/payment-plans/${mine.id}`).set(outsider.auth).expect(404);
  });
});
