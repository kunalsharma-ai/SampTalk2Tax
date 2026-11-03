import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Group consolidation against the real API and database: groups owned by a parent organisation,
 * adding members (only organisations the user owns or administers), translation rates for a
 * USD member, elimination rules checked against each member's accounts, the consolidation
 * worksheet and statements, intercompany differences, permissions in every member, exports with
 * the audit trail, and tenant isolation.
 */
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let outsider: TestUser;
type Org = Awaited<ReturnType<typeof createOrg>>;
let parent: Org;
let sub: Org;
let us: Org;
let viewerOnly: Org;
let theirs: Org;
let G: string;
let groupId: string;
const T = today();
const FROM = `${Number(T.slice(5, 7)) >= 4 ? T.slice(0, 4) : Number(T.slice(0, 4)) - 1}-04-01`;

const account = async (o: Org, code: string, name: string, type: string) => {
  o.acc[code] = (await ctx.http().post(`${o.base}/accounts`).set(owner.auth).send({ code, name, type }).expect(201)).body.id;
};
const journal = (o: Org, debit: string, credit: string, amount: string, memo: string) =>
  ctx.http().post(`${o.base}/journals`).set(owner.auth).send({ date: T, post: true, memo, lines: [{ accountId: o.acc[debit], debit: amount }, { accountId: o.acc[credit], credit: amount }] }).expect(201);
const report = async (who = owner, status = 200) => (await ctx.http().get(`${G}/${groupId}/report?from=${FROM}&to=${T}`).set(who.auth).expect(status)).body;
type WRow = { code: string; amounts: string[]; elimination: string; consolidated: string };
const row = (r: { rows: WRow[] }, code: string) => r.rows.find((x) => x.code === code)!;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Group Owner');
  accountant = await registerUser(ctx, 'Group Accountant');
  outsider = await registerUser(ctx, 'Group Outsider');
  parent = await createOrg(ctx, owner, { name: 'Holding Ltd' });
  sub = await createOrg(ctx, owner, { name: 'Sub Pvt Ltd' });
  us = await createOrg(ctx, owner, { name: 'US Inc', countryCode: 'US', functionalCurrency: 'USD', fiscalYearStartMonth: 4 });
  viewerOnly = await createOrg(ctx, outsider, { name: 'Viewer Only Co' });
  theirs = await createOrg(ctx, outsider, { name: 'Their Holding' });
  await ctx.http().post(`${viewerOnly.base}/members`).set(outsider.auth).send({ email: owner.email, role: 'VIEWER' }).expect(201);
  await ctx.http().post(`${parent.base}/members`).set(owner.auth).send({ email: accountant.email, role: 'ACCOUNTANT' }).expect(201);
  G = `${parent.base}/consolidation/groups`;

  await account(parent, '1250', 'Due from group companies', 'ASSET');
  await account(parent, '1600', 'Investment in subsidiaries', 'ASSET');
  await account(parent, '4300', 'Intercompany sales', 'REVENUE');
  await account(sub, '2160', 'Due to group companies', 'LIABILITY');
  await account(sub, '6950', 'Intercompany purchases', 'EXPENSE');
  await journal(parent, '1120', '3100', '500000.00', 'Capital');
  await journal(parent, '1600', '1120', '200000.00', 'Invest in Sub');
  await journal(parent, '1250', '4300', '100000.00', 'Management fee to Sub');
  await journal(sub, '1120', '3100', '200000.00', 'Capital from Holding');
  await journal(sub, '6950', '2160', '100000.00', 'Management fee from Holding');
  await journal(us, '1120', '3100', '10000.00', 'Capital');
  await journal(us, '1120', '4100', '1500.00', 'Sales');
  await journal(us, '6100', '1120', '500.00', 'Salaries');
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('consolidation groups', () => {
  it('creates a group with the parent as its first member', async () => {
    await ctx.http().post(G).set(accountant.auth).send({ name: 'Group' }).expect(403);
    groupId = (await ctx.http().post(G).set(owner.auth).send({ name: 'Holding group' }).expect(201)).body.id;
    await ctx.http().post(G).set(owner.auth).send({ name: 'HOLDING GROUP' }).expect(409);
    await ctx.http().post(G).set(owner.auth).send({ name: 'Bad', currency: 'XYZ' }).expect(400);
    const d = (await ctx.http().get(`${G}/${groupId}`).set(owner.auth).expect(200)).body;
    expect(d).toMatchObject({ name: 'Holding group', currency: 'INR', parentOrgId: parent.orgId, rules: [], rates: [] });
    expect(d.members).toEqual([expect.objectContaining({ orgId: parent.orgId, name: 'Holding Ltd', isParent: true, yourRole: 'OWNER', canReadReports: true })]);
    expect(d.candidates.map((c: { name: string }) => c.name)).toEqual(['Sub Pvt Ltd', 'US Inc']);
  });

  it('adds only organisations the user owns or administers', async () => {
    await ctx.http().post(`${G}/${groupId}/members`).set(owner.auth).send({ orgId: theirs.orgId }).expect(404);
    expect((await ctx.http().post(`${G}/${groupId}/members`).set(owner.auth).send({ orgId: viewerOnly.orgId }).expect(403)).body.message).toMatch(/your role there is VIEWER/);
    await ctx.http().post(`${G}/${groupId}/members`).set(owner.auth).send({ orgId: sub.orgId }).expect(201);
    const d = (await ctx.http().post(`${G}/${groupId}/members`).set(owner.auth).send({ orgId: us.orgId }).expect(201)).body;
    expect(d.members.map((m: { name: string }) => m.name)).toEqual(['Holding Ltd', 'Sub Pvt Ltd', 'US Inc']);
    await ctx.http().post(`${G}/${groupId}/members`).set(owner.auth).send({ orgId: sub.orgId }).expect(409);
    expect((await ctx.http().delete(`${G}/${groupId}/members/${parent.orgId}`).set(owner.auth).expect(409)).body.error).toBe('PARENT_MEMBER');
  });

  it('needs translation rates for a member in another currency', async () => {
    const blocked = (await ctx.http().get(`${G}/${groupId}/report?from=${FROM}&to=${T}`).set(owner.auth).expect(422)).body;
    expect(blocked.error).toBe('CONSOLIDATION_BLOCKED');
    expect(blocked.details.issues).toEqual([`US Inc keeps its books in USD: enter its USD to INR rates for the period`]);
    expect((await ctx.http().put(`${G}/${groupId}/rates`).set(owner.auth).send({ memberOrgId: sub.orgId, periodEnd: T, closing: '1', average: '1', historical: '1' }).expect(422)).body.error).toBe('SAME_CURRENCY');
    await ctx.http().put(`${G}/${groupId}/rates`).set(owner.auth).send({ memberOrgId: us.orgId, periodEnd: T, closing: '0', average: '82', historical: '80' }).expect(400);
    await ctx.http().put(`${G}/${groupId}/rates`).set(owner.auth).send({ memberOrgId: us.orgId, periodEnd: T, closing: '84', average: '82', historical: '80' }).expect(200);
    const d = (await ctx.http().put(`${G}/${groupId}/rates`).set(owner.auth).send({ memberOrgId: us.orgId, periodEnd: T, closing: '85', average: '82', historical: '80' }).expect(200)).body;
    expect(d.rates).toEqual([expect.objectContaining({ memberName: 'US Inc', periodEnd: T, closing: '85', average: '82', historical: '80' })]);
  });

  it('consolidates the members with translation', async () => {
    const r = await report();
    expect(r.balanced).toBe(true);
    expect(r.entities.map((e: { name: string; currency: string }) => `${e.name} ${e.currency}`)).toEqual(['Holding Ltd INR', 'Sub Pvt Ltd INR', 'US Inc USD']);
    expect(row(r, '1120')).toMatchObject({ amounts: ['300000.00', '200000.00', '935000.00'], consolidated: '1435000.00' });
    expect(row(r, '3100').amounts).toEqual(['-500000.00', '-200000.00', '-800000.00']);
    expect(r.entities[2]).toMatchObject({ translationReserve: '-53000.00', netIncome: '82000.00' });
    expect(r.incomeStatement).toMatchObject({ totalRevenue: '223000.00', totalExpenses: '141000.00', netIncome: '82000.00' });
    expect(r.balanceSheet.balanced).toBe(true);
  });

  it('eliminates intercompany balances with rules checked against each member', async () => {
    const bad = (await ctx.http().post(`${G}/${groupId}/rules`).set(owner.auth).send({ name: 'Loan', left: { orgId: parent.orgId, code: '1700' }, right: { orgId: theirs.orgId, code: '2160' } }).expect(422)).body;
    expect(bad.details.issues).toEqual(['The first organisation has no account 1700', 'The second organisation is not in the group']);
    for (const [name, l, rr] of [
      ['Current accounts', '1250', '2160'],
      ['Management fees', '4300', '6950'],
      ['Investment and capital', '1600', '3100'],
    ]) {
      await ctx.http().post(`${G}/${groupId}/rules`).set(owner.auth).send({ name, left: { orgId: parent.orgId, code: l }, right: { orgId: sub.orgId, code: rr } }).expect(201);
    }
    const r = await report();
    expect(r.eliminations.map((e: { name: string; matched: boolean; difference: string }) => [e.name, e.matched, e.difference])).toEqual([
      ['Current accounts', true, '0.00'],
      ['Management fees', true, '0.00'],
      ['Investment and capital', true, '0.00'],
    ]);
    expect(row(r, '1250')).toMatchObject({ elimination: '-100000.00', consolidated: '0.00' });
    expect(row(r, '3100').consolidated).toBe('-1300000.00');
    expect(r.incomeStatement).toMatchObject({ totalRevenue: '123000.00', totalExpenses: '41000.00', netIncome: '82000.00' });
    expect(r.incomeStatement.revenue.map((l: { code: string }) => l.code)).toEqual(['4100']);
    expect(r.balanceSheet).toMatchObject({ totalAssets: '1435000.00', totalLiabilities: '0.00', totalEquity: '1435000.00', balanced: true });
    expect((await ctx.http().delete(`${G}/${groupId}/members/${sub.orgId}`).set(owner.auth).expect(409)).body.details.issues).toHaveLength(3);
  });

  it('shows a mismatch between the two sides as an intercompany difference', async () => {
    await journal(sub, '6950', '2160', '5000.00', 'Fee booked twice');
    const r = await report();
    const e = r.eliminations.find((x: { name: string }) => x.name === 'Current accounts');
    expect(e).toMatchObject({ matched: false, difference: '-5000.00', left: { amount: '100000.00' }, right: { amount: '-105000.00' } });
    // The same fee also lands on the purchases side, so the fees rule differs the other way.
    expect(r.eliminations.find((x: { name: string }) => x.name === 'Management fees')).toMatchObject({ matched: false, difference: '5000.00' });
    expect(r.rows.find((x: { kind: string }) => x.kind === 'INTERCOMPANY_DIFFERENCE')).toMatchObject({ elimination: '0.00', consolidated: '0.00' });
    expect(r.balanced).toBe(true);
    expect(r.balanceSheet.balanced).toBe(true);
  });

  it('needs report access in every member', async () => {
    const res = await report(accountant, 403);
    // Names of organisations the user does not belong to are not shown.
    expect(res.details.issues).toEqual(['No report access in an organisation you are not a member of', 'No report access in an organisation you are not a member of']);
    await ctx.http().get(`${G}/${groupId}`).set(accountant.auth).expect(200);
    await ctx.http().put(`${G}/${groupId}`).set(accountant.auth).send({ name: 'x', currency: 'INR' }).expect(403);
    await ctx.http().get(`${G}/${groupId}`).set(outsider.auth).expect(404);
    // Another organisation's route cannot reach this group.
    await ctx.http().get(`${theirs.base}/consolidation/groups/${groupId}`).set(outsider.auth).expect(404);
  });

  it('exports the worksheet and statements and audits each export', async () => {
    const csv = await ctx.http().get(`${G}/${groupId}/export/worksheet?from=${FROM}&to=${T}&format=csv`).set(owner.auth).expect(200);
    expect(csv.headers['content-disposition']).toContain(`holding-group-consolidation-worksheet-${T}.csv`);
    expect(csv.text).toContain('Code,Account,Holding Ltd,Sub Pvt Ltd,US Inc,Eliminations,Consolidated');
    expect(csv.text).toContain('1120,Bank,300000.00,200000.00,935000.00,0.00,1435000.00'.replace('Bank', csv.text.match(/\r\n1120,([^,]+),/)![1]!));
    expect(csv.text).toContain('US Inc: USD translated at closing 85, average 82, historical 80.');
    expect(csv.text).toContain('"Elimination ""Current accounts"" leaves a difference of -5000.00."');
    const pdf = await ctx.http().get(`${G}/${groupId}/export/balance-sheet?from=${FROM}&to=${T}&format=pdf`).set(owner.auth).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    await ctx.http().get(`${G}/${groupId}/export/cash-flow?from=${FROM}&to=${T}&format=pdf`).set(owner.auth).expect(404);
    await ctx.http().get(`${G}/${groupId}/export/worksheet?from=${FROM}&to=${T}&format=doc`).set(owner.auth).expect(400);
    const events = (await ctx.http().get(`${parent.base}/audit-events?entityType=report`).set(owner.auth).expect(200)).body;
    const list = Array.isArray(events) ? events : events.items;
    expect(list.filter((e: { action: string; data: { report: string } }) => e.action === 'report.exported' && e.data.report.startsWith('consolidated-')).length).toBe(2);
  });

  it('removes a member with its rates, and deletes the group', async () => {
    const d = (await ctx.http().delete(`${G}/${groupId}/members/${us.orgId}`).set(owner.auth).expect(200)).body;
    expect(d.rates).toEqual([]);
    expect(d.members).toHaveLength(2);
    const rule = d.rules[0].id;
    await ctx.http().put(`${G}/${groupId}/rules/${rule}`).set(owner.auth).send({ name: 'Current accounts (off)', left: { orgId: parent.orgId, code: '1250' }, right: { orgId: sub.orgId, code: '2160' }, isActive: false }).expect(200);
    const r = await report();
    expect(r.eliminations.map((e: { name: string }) => e.name)).toEqual(['Management fees', 'Investment and capital']);
    await ctx.http().delete(`${G}/${groupId}`).set(owner.auth).expect(200);
    await ctx.http().get(`${G}/${groupId}`).set(owner.auth).expect(404);
    const audit = (await ctx.http().get(`${parent.base}/audit-events?entityType=consolidation_group&limit=100`).set(owner.auth).expect(200)).body;
    const actions = (Array.isArray(audit) ? audit : audit.items).map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['consolidation_group.created', 'consolidation_group.member_added', 'consolidation_group.rates_set', 'consolidation_group.member_removed', 'consolidation_group.deleted']));
  });
});
