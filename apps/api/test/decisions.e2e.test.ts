import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Decision memory against the real API and database: recording a decision with assumptions and
 * expected outcomes, outcomes measured from the books against the month before the decision,
 * search, editing, review with lessons (outcomes frozen), withdrawal, drafts from an approved
 * scenario and a recovery plan, the database refusing changes to a reviewed decision,
 * permissions, tenant isolation and the audit trail.
 */
let ctx: Ctx;
let owner: TestUser;
let approver: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
type Org = Awaited<ReturnType<typeof createOrg>>;
let org: Org;
let other: Org;
const T = today();
const shift = (month: string, by: number) => {
  const t = +month.slice(0, 4) * 12 + (+month.slice(5, 7) - 1) + by;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const M0 = shift(T.slice(0, 7), -2); // the month before the decision: the baseline
const M1 = shift(T.slice(0, 7), -1); // the decision's month, measured
const THIS = T.slice(0, 7);
let id = '';

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Decision Owner');
  approver = await registerUser(ctx, 'Decision Approver');
  viewer = await registerUser(ctx, 'Decision Viewer');
  employee = await registerUser(ctx, 'Decision Employee');
  outsider = await registerUser(ctx, 'Decision Outsider');
  org = await createOrg(ctx, owner, { name: 'Decision Traders Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Decisions Co' });
  for (const [u, role] of [[approver, 'APPROVER'], [viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  for (const m of [M0, M1]) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fiscalYearForDate(`${m}-01`, 4) });
  const j = (date: string, dr: string, cr: string, amount: string) =>
    ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date, memo: 'Decision e2e', post: true, lines: [{ accountId: org.acc[dr], debit: amount }, { accountId: org.acc[cr], credit: amount }] }).expect(201);
  // Before the decision: 1,00,000 of sales at a 30% gross margin. After: 1,20,000 at 40%.
  await j(`${M0}-10`, '1120', '4100', '100000.00');
  await j(`${M0}-12`, '5000', '1120', '70000.00');
  await j(`${M1}-20`, '1120', '4100', '120000.00');
  await j(`${M1}-22`, '5000', '1120', '72000.00');
});
afterAll(async () => {
  await ctx?.app.close();
});

const decision = (over: Record<string, unknown> = {}) => ({
  title: 'Raise prices on trade goods by 8%',
  decision: 'Raise list prices on all trade goods by 8% from the start of the month; keep the top five customers on their current terms until renewal.',
  context: 'Supplier costs rose twice this year and the gross margin fell to 30%. Options considered: absorb, raise prices, or change suppliers.',
  category: 'PRICING',
  tags: ['Pricing', 'margin'],
  decidedOn: `${M1}-03`,
  decidedBy: 'Board meeting',
  reviewDue: `${M1}-28`,
  assumptions: [{ text: 'Customers accept an 8% rise without volume falling more than 5%.' }, { text: 'Supplier costs stay flat for the quarter.' }],
  outcomes: [
    { kpi: 'grossMargin', comparator: 'AT_LEAST', target: '35', measureMonth: M1 },
    { kpi: 'revenue', comparator: 'AT_LEAST', target: '150000', measureMonth: M1 },
    { kpi: 'dso', comparator: 'AT_MOST', target: '30', measureMonth: THIS },
  ],
  ...over,
});

describe('decision memory', () => {
  it('records a decision and measures its outcomes from the books against the month before', async () => {
    const d = (await ctx.http().post(`${org.base}/decisions`).set(owner.auth).send(decision()).expect(201)).body;
    id = d.id;
    expect(d).toMatchObject({ number: 'DM-0001', status: 'ACTIVE', category: 'PRICING', tags: ['pricing', 'margin'], decidedOn: `${M1}-03`, reviewDue: `${M1}-28`, reviewOverdue: true, source: null });
    expect(d.assumptions).toEqual([
      { text: 'Customers accept an 8% rise without volume falling more than 5%.', held: null, note: null },
      { text: 'Supplier costs stay flat for the quarter.', held: null, note: null },
    ]);
    const [gm, rev, dso] = d.outcomes;
    expect(gm).toMatchObject({ kpi: 'grossMargin', baselineMonth: M0, baseline: '30.0', actual: '40.0', status: 'MET', change: '10.0', improved: true, frozen: false });
    expect(gm.explanation).toMatch(/^Met: gross margin was 40\.0% in .*, against 30\.0% before the decision\. Expected at least 35\.0%\.$/);
    expect(rev).toMatchObject({ baseline: '100000.00', actual: '120000.00', status: 'MISSED', change: '20000.00', improved: true });
    expect(rev.explanation).toContain('₹1,20,000.00');
    expect(dso).toMatchObject({ status: 'NOT_DUE', actual: null });
    expect(d.suggestedVerdict).toBe('PARTLY');
    expect(d.people[owner.id]).toBe('Decision Owner');
  });

  it('refuses decisions that cannot be measured or are dated in the future', async () => {
    const e1 = (await ctx.http().post(`${org.base}/decisions`).set(owner.auth).send(decision({ decidedOn: '2999-01-01' })).expect(422)).body;
    expect(e1.message).toBe('A decision cannot be dated in the future');
    const e2 = (await ctx.http().post(`${org.base}/decisions`).set(owner.auth).send(decision({ outcomes: [{ kpi: 'revenue', comparator: 'AT_LEAST', target: '1', measureMonth: M0 }] })).expect(422)).body;
    expect(e2.message).toBe('Expected outcome 1: The month to measure cannot be before the decision');
    await ctx.http().post(`${org.base}/decisions`).set(owner.auth).send(decision({ outcomes: [{ kpi: 'happiness', comparator: 'AT_LEAST', target: '1', measureMonth: M1 }] })).expect(400);
    await ctx.http().post(`${org.base}/decisions`).set(owner.auth).send(decision({ category: 'LUCK' })).expect(400);
    const e3 = (await ctx.http().post(`${org.base}/decisions`).set(owner.auth).send(decision({ outcomes: [decision().outcomes[0], decision().outcomes[0]] })).expect(422)).body;
    expect(e3.message).toBe('Each measure can be expected only once for the same month');
  });

  it('finds decisions by any word in them, their assumptions or lessons, and filters', async () => {
    const hire = (await ctx.http().post(`${org.base}/decisions`).set(approver.auth).send(decision({ title: 'Hire two warehouse staff', decision: 'Hire two people for the warehouse.', context: null, category: 'HIRING', tags: [], reviewDue: null, assumptions: [{ text: 'Overtime falls by half.' }], outcomes: [] })).expect(201)).body;
    expect(hire.number).toBe('DM-0002');
    const search = async (q: string) => (await ctx.http().get(`${org.base}/decisions?q=${encodeURIComponent(q)}`).set(viewer.auth).expect(200)).body.items.map((x: { number: string }) => x.number);
    expect(await search('prices')).toEqual(['DM-0001']);
    expect(await search('overtime')).toEqual(['DM-0002']);
    expect(await search('supplier flat')).toEqual(['DM-0001']);
    expect(await search('dm-0002')).toEqual(['DM-0002']);
    expect(await search('100%_')).toEqual([]);
    expect((await search('')).sort()).toEqual(['DM-0001', 'DM-0002']);
    const byCat = (await ctx.http().get(`${org.base}/decisions?category=HIRING`).set(viewer.auth).expect(200)).body;
    expect(byCat.items.map((x: { number: string }) => x.number)).toEqual(['DM-0002']);
    expect(byCat.totals).toEqual({ active: 2, reviewed: 0, withdrawn: 0, dueForReview: 1 });
    expect(byCat.measures.map((m: { key: string }) => m.key)).toContain('grossMargin');
    const list = (await ctx.http().get(`${org.base}/decisions?q=prices`).set(viewer.auth).expect(200)).body.items[0];
    expect(list).toMatchObject({ outcomes: { met: 1, missed: 1, notDue: 1, noValue: 0 }, suggestedVerdict: 'PARTLY', reviewOverdue: true });
    // A decision that is never carried out stays in the history with the reason.
    await ctx.http().post(`${org.base}/decisions/${hire.id}/withdraw`).set(owner.auth).send({}).expect(400);
    const w = (await ctx.http().post(`${org.base}/decisions/${hire.id}/withdraw`).set(owner.auth).send({ reason: 'Automation made the hires unnecessary.' }).expect(200)).body;
    expect(w).toMatchObject({ status: 'WITHDRAWN', withdrawnReason: 'Automation made the hires unnecessary.', withdrawnById: owner.id });
    expect(await search('automation')).toEqual(['DM-0002']);
    await ctx.http().put(`${org.base}/decisions/${hire.id}`).set(owner.auth).send(decision()).expect(409);
  });

  it('edits an active decision, then reviews it with lessons and freezes what was measured', async () => {
    const u = (await ctx.http().put(`${org.base}/decisions/${id}`).set(owner.auth).send(decision({ reviewDue: null, assumptions: [...decision().assumptions, { text: 'No competitor cuts prices.' }] })).expect(200)).body;
    expect(u.assumptions).toHaveLength(3);
    expect(u.outcomes[0].baseline).toBe('30.0');
    expect(u.reviewOverdue).toBe(false);
    const short = (await ctx.http().post(`${org.base}/decisions/${id}/review`).set(owner.auth).send({ verdict: 'PARTLY', lessons: 'x', assumptions: [{ held: true }] }).expect(422)).body;
    expect(short.message).toBe('Say for each of the 3 assumptions whether it held');
    await ctx.http().post(`${org.base}/decisions/${id}/review`).set(owner.auth).send({ verdict: 'PARTLY', lessons: '', assumptions: [] }).expect(400);
    const r = (
      await ctx
        .http()
        .post(`${org.base}/decisions/${id}/review`)
        .set(approver.auth)
        .send({ verdict: 'PARTLY', outcomeNotes: 'Margin recovered; volume did not grow enough.', lessons: 'Price rises hold margin, but plan volume separately.', assumptions: [{ held: true }, { held: false, note: 'Steel went up again.' }, { held: null }] })
        .expect(200)
    ).body;
    expect(r).toMatchObject({ status: 'REVIEWED', verdict: 'PARTLY', reviewedById: approver.id, lessons: 'Price rises hold margin, but plan volume separately.' });
    expect(r.assumptions[1]).toEqual({ text: 'Supplier costs stay flat for the quarter.', held: false, note: 'Steel went up again.' });
    expect(r.outcomes.map((o: { status: string; frozen: boolean }) => [o.status, o.frozen])).toEqual([['MET', true], ['MISSED', true], ['NOT_DUE', true]]);
    // Later postings do not change a reviewed decision's figures.
    await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: `${M1}-25`, memo: 'Late sale', post: true, lines: [{ accountId: org.acc['1120'], debit: '100000.00' }, { accountId: org.acc['4100'], credit: '100000.00' }] }).expect(201);
    const after = (await ctx.http().get(`${org.base}/decisions/${id}`).set(viewer.auth).expect(200)).body;
    expect(after.outcomes[1].actual).toBe('120000.00');
    expect((await ctx.http().get(`${org.base}/decisions?q=steel`).set(viewer.auth).expect(200)).body.items).toHaveLength(1);
    // A reviewed decision is final, in the API and in the database.
    await ctx.http().put(`${org.base}/decisions/${id}`).set(owner.auth).send(decision()).expect(409);
    await ctx.http().post(`${org.base}/decisions/${id}/review`).set(owner.auth).send({ verdict: 'WORKED', lessons: 'x', assumptions: [{ held: true }, { held: true }, { held: true }] }).expect(409);
    await ctx.http().post(`${org.base}/decisions/${id}/withdraw`).set(owner.auth).send({ reason: 'x' }).expect(409);
    await expect(ctx.prisma.decision.update({ where: { id }, data: { lessons: 'rewritten' } })).rejects.toThrow(/cannot be changed/);
    await expect(ctx.prisma.decision.delete({ where: { id } })).rejects.toThrow(/cannot be changed/);
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=decision&entityId=${id}`).set(owner.auth).expect(200)).body;
    expect((audit.items ?? audit).map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['decision.recorded', 'decision.updated', 'decision.reviewed']));
  });

  it('starts a draft from a recovery plan or an approved scenario only', async () => {
    const plan = (await ctx.http().post(`${org.base}/recovery/plans`).set(owner.auth).send({ name: 'Protect cash', baselineMonths: 3, horizonMonths: 12 }).expect(201)).body;
    const pd = (await ctx.http().get(`${org.base}/decisions/draft?sourceType=RECOVERY_PLAN&sourceId=${plan.id}`).set(owner.auth).expect(200)).body;
    expect(pd).toMatchObject({ title: 'Protect cash', sourceType: 'RECOVERY_PLAN', sourceId: plan.id, category: 'COSTS' });
    expect(pd.decision).toMatch(/^Carry out the recovery plan "Protect cash":/);
    const sc = (await ctx.http().post(`${org.base}/twin/scenarios`).set(owner.auth).send({ name: 'Open Pune branch', description: 'Open a branch in Pune.', baselineMonths: 3, horizonMonths: 12, drivers: [{ kind: 'REVENUE_GROWTH', percentPerMonth: '3', fromMonth: 1 }] }).expect(201)).body;
    const no = (await ctx.http().get(`${org.base}/decisions/draft?sourceType=SCENARIO&sourceId=${sc.id}`).set(owner.auth).expect(422)).body;
    expect(no.message).toBe('Only an approved scenario can be recorded as a decision');
    await ctx.http().post(`${org.base}/decisions`).set(owner.auth).send(decision({ sourceType: 'SCENARIO', sourceId: sc.id })).expect(422);
    await ctx.http().post(`${org.base}/twin/scenarios/${sc.id}/submit`).set(owner.auth).expect(200);
    await ctx.http().post(`${org.base}/twin/scenarios/${sc.id}/approve`).set(approver.auth).send({ note: 'Go, but review in three months.' }).expect(200);
    const sd = (await ctx.http().get(`${org.base}/decisions/draft?sourceType=SCENARIO&sourceId=${sc.id}`).set(owner.auth).expect(200)).body;
    expect(sd).toMatchObject({ title: 'Open Pune branch', decision: 'Open a branch in Pune.', decidedOn: T, decidedBy: 'Decision Approver', sourceType: 'SCENARIO' });
    expect(sd.context).toBe(`Approved in the war room by Decision Approver on ${T}. Approval note: Go, but review in three months.`);
    expect(sd.assumptions.length).toBeGreaterThan(0);
    const rec = (await ctx.http().post(`${org.base}/decisions`).set(owner.auth).send({ ...sd, outcomes: [] }).expect(201)).body;
    expect(rec.source).toEqual({ type: 'SCENARIO', id: sc.id, label: 'Scenario Open Pune branch', path: `/planning/twin/${sc.id}` });
    // A source from another organisation is refused.
    const theirs = (await ctx.http().post(`${other.base}/recovery/plans`).set(outsider.auth).send({ name: 'Theirs', baselineMonths: 3, horizonMonths: 12 }).expect(201)).body;
    await ctx.http().get(`${org.base}/decisions/draft?sourceType=RECOVERY_PLAN&sourceId=${theirs.id}`).set(owner.auth).expect(404);
    await ctx.http().post(`${org.base}/decisions`).set(owner.auth).send(decision({ sourceType: 'RECOVERY_PLAN', sourceId: theirs.id })).expect(422);
  });

  it('lets anyone who reads reports read decisions, and only managers record them, within the organisation', async () => {
    await ctx.http().get(`${org.base}/decisions`).set(viewer.auth).expect(200);
    await ctx.http().post(`${org.base}/decisions`).set(viewer.auth).send(decision()).expect(403);
    await ctx.http().post(`${org.base}/decisions/${id}/review`).set(viewer.auth).send({ verdict: 'WORKED', lessons: 'x', assumptions: [] }).expect(403);
    await ctx.http().get(`${org.base}/decisions`).set(employee.auth).expect(403);
    await ctx.http().get(`${org.base}/decisions/${id}`).set(outsider.auth).expect(404);
    await ctx.http().get(`${other.base}/decisions/${id}`).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/decisions`).set(outsider.auth).expect(200)).body.items).toEqual([]);
  });
});
