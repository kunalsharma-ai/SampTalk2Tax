import { addDays, noticeMonthsOrPart } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Tax notice analysis (TAX-050) against the real API and database: a GST scrutiny notice known by
 * its form, its usual deadline and checklist ticks; an income-tax demand with interest building up;
 * a notice identified only by the type chosen; a section the analysis does not know; related
 * notices; validation, permissions, audit and tenants.
 */
const T = today();
const day = (n: number) => addDays(T, n);
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const ids: Record<string, string> = {};
const A = (id: string) => `${org.base}/tax-notices/${id}/analysis`;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Analysis Owner');
  accountant = await registerUser(ctx, 'Analysis Accountant');
  viewer = await registerUser(ctx, 'Analysis Viewer');
  org = await createOrg(ctx, owner, { name: 'Noticed Traders Pvt Ltd' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  const add = async (key: string, body: object) => (ids[key] = (await ctx.http().post(`${org.base}/tax-notices`).set(owner.auth).send(body).expect(201)).body.id);
  await add('scrutiny', { authority: 'GST', reference: 'ZD-SYN-0001', section: 'ASMT-10', subject: 'Mismatch between GSTR-1 and GSTR-3B (synthetic)', period: '2025-26', receivedOn: day(-10), demand: '48250.00' });
  await add('scn', { authority: 'GST', reference: 'ZD-SYN-0002', section: 'DRC-01', subject: 'Show cause notice (synthetic)', period: '2025-26', receivedOn: day(-5) });
  await add('demand', { authority: 'INCOME_TAX', reference: 'CPC-SYN-156', section: 'u/s 156', subject: 'Demand after processing (synthetic)', receivedOn: day(-70), demand: '125000.00' });
  await add('pf', { authority: 'PF', reference: 'PF-SYN-7A', section: '7A', subject: 'Inquiry (synthetic)', receivedOn: day(-2) });
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('tax notice analysis', () => {
  it('recognises a GST scrutiny notice by its form and gives the usual deadline and checklist', async () => {
    const a = (await ctx.http().get(A(ids.scrutiny!)).set(viewer.auth).expect(200)).body;
    expect(a).toMatchObject({ recognisedBy: 'SECTION', type: { key: 'GST_61', title: 'Scrutiny of returns (ASMT-10)', replyWithinDays: 30, source: 'CGST Act, 2017, s.61; CGST Rules, rule 99' }, deadline: { date: day(20), source: 'RULE' }, usualDeadline: day(20), interest: null, progress: { done: 0, total: 5 }, chosenType: null, updatedBy: null });
    expect(a.warnings).toEqual([`No reply date is entered; ${day(20)} is 30 days from receipt. Enter the date on the notice if it differs.`]);
    expect(a.types.map((t: { key: string }) => t.key)).toEqual(['GST_46', 'GST_61', 'GST_73', 'GST_74', 'GST_74A']);
    // The other GST notice for the same period is related.
    expect(a.related).toEqual({ samePeriod: true, notices: [expect.objectContaining({ id: ids.scn, reference: 'ZD-SYN-0002', status: 'OPEN' })] });
  });

  it('keeps checklist ticks for those who keep the books', async () => {
    await ctx.http().put(A(ids.scrutiny!)).set(viewer.auth).send({ chosenType: null, checked: ['itc'] }).expect(403);
    const bad = await ctx.http().put(A(ids.scrutiny!)).set(accountant.auth).send({ chosenType: 'IT_156', checked: ['nope'] }).expect(422);
    expect(bad.body.details.issues).toEqual(['IT_156 is not a notice type for this authority', '"nope" is not on this notice\'s checklist']);
    await ctx.http().put(A(ids.scrutiny!)).set(accountant.auth).send({ chosenType: null, checked: ['Bad Key'] }).expect(400);
    const a = (await ctx.http().put(A(ids.scrutiny!)).set(accountant.auth).send({ chosenType: null, checked: ['itc', 'outward', 'itc'] }).expect(200)).body;
    expect(a).toMatchObject({ progress: { done: 2, total: 5 }, updatedBy: 'Analysis Accountant' });
    expect(a.checklist.filter((c: { done: boolean }) => c.done).map((c: { key: string }) => c.key)).toEqual(['outward', 'itc']);
  });

  it('estimates the interest building up on an unpaid income-tax demand', async () => {
    const a = (await ctx.http().get(A(ids.demand!)).set(viewer.auth).expect(200)).body;
    const months = noticeMonthsOrPart(day(-39), T);
    expect(a).toMatchObject({ recognisedBy: 'SECTION', type: { key: 'IT_156' }, deadline: { date: day(-40), source: 'RULE' } });
    expect(a.interest).toMatchObject({ from: day(-39), months, ratePerMonth: '1', amount: (1250 * months).toFixed(2) });
    expect(a.related.samePeriod).toBe(false);
    expect(a.related.notices).toEqual([]);
  });

  it('uses the type chosen when the section does not say, and says when it knows nothing', async () => {
    let a = (await ctx.http().get(A(ids.scn!)).set(viewer.auth).expect(200)).body;
    expect(a).toMatchObject({ type: null, recognisedBy: null, deadline: null, checklist: [] });
    expect(a.warnings[0]).toMatch(/Section DRC-01 is not one this analysis knows for GST notices/);
    a = (await ctx.http().put(A(ids.scn!)).set(owner.auth).send({ chosenType: 'GST_74A', checked: ['working'] }).expect(200)).body;
    expect(a).toMatchObject({ recognisedBy: 'CHOSEN', chosenType: 'GST_74A', type: { key: 'GST_74A' }, deadline: { date: day(25), source: 'RULE' }, progress: { done: 1, total: 5 } });
    a = (await ctx.http().put(A(ids.scn!)).set(owner.auth).send({ chosenType: null, checked: [] }).expect(200)).body;
    expect(a).toMatchObject({ type: null, chosenType: null });

    const pf = (await ctx.http().get(A(ids.pf!)).set(viewer.auth).expect(200)).body;
    expect(pf).toMatchObject({ type: null, types: [], checklist: [] });
    await ctx.http().put(A(ids.pf!)).set(owner.auth).send({ chosenType: 'GST_61', checked: [] }).expect(422);
  });

  it('is audited and kept to its organisation', async () => {
    const events = await ctx.db.collection('audit_events').find({ orgId: org.orgId, action: 'tax_notice.analysis_saved' }).sort({ idNumber: 1 }).toArray();
    expect(events.map((e) => [e.data.reference, e.data.type, e.data.done])).toEqual([['ZD-SYN-0001', 'GST_61', 2], ['ZD-SYN-0002', 'GST_74A', 1], ['ZD-SYN-0002', null, 0]]);
    await ctx.http().get(A('00000000-0000-4000-8000-000000000000')).set(viewer.auth).expect(404);
    const other = await createOrg(ctx, owner, { name: 'Other Noticed Ltd' });
    await ctx.http().get(`${other.base}/tax-notices/${ids.scrutiny}/analysis`).set(owner.auth).expect(404);
    const outsider = await registerUser(ctx, 'Analysis Outsider');
    await ctx.http().get(A(ids.scrutiny!)).set(outsider.auth).expect(404);
  });
});
