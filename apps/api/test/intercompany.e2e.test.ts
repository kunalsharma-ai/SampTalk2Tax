import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Intercompany transactions against the real API and database: each company's intercompany
 * accounts (checked against its chart and kept apart from elimination rules), charges and
 * settlements posted in both companies in one transaction (all or nothing, even when the second
 * company's period is locked), different currencies, exact eliminations in the consolidation,
 * reversal of both entries, permissions in both companies, and the guards on removing members.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let parentOnly: TestUser;
type Org = Awaited<ReturnType<typeof createOrg>>;
let parent: Org;
let sub: Org;
let fze: Org;
let G: string;
let groupId: string;
const T = today();
const FROM = `${Number(T.slice(5, 7)) >= 4 ? T.slice(0, 4) : Number(T.slice(0, 4)) - 1}-04-01`;
type Txn = { id: string; reference: string; kind: string; from: { amount: string; entry: { id: string; entryNumber: number } }; to: { amount: string; currency: string; entry: { id: string; entryNumber: number } }; reversedOn: string | null };
let charge: Txn;

const account = async (o: Org, code: string, name: string, type: string) => {
  o.acc[code] = (await ctx.http().post(`${o.base}/accounts`).set(owner.auth).send({ code, name, type }).expect(201)).body.id;
};
const report = async () => (await ctx.http().get(`${G}/${groupId}/report?from=${FROM}&to=${T}`).set(owner.auth).expect(200)).body;
const post = async (body: Record<string, unknown>, who = owner, status = 201) => {
  const r = await ctx.http().post(`${G}/${groupId}/intercompany`).set(who.auth).send({ date: T, description: 'Management fee', ...body });
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r;
};
const journalsOf = async (o: Org) => {
  const b = (await ctx.http().get(`${o.base}/journals?limit=100`).set(owner.auth).expect(200)).body;
  return (Array.isArray(b) ? b : b.items) as { id: string; source: string; reference: string | null; type: string }[];
};
const balance = async (o: Org, code: string) => {
  const tb = (await ctx.http().get(`${o.base}/reports/trial-balance?asOf=${T}`).set(owner.auth).expect(200)).body;
  const r = tb.rows.find((x: { code: string }) => x.code === code);
  return r ? (Number(r.netDebit) - Number(r.netCredit)).toFixed(2) : '0.00';
};

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'IC Owner');
  viewer = await registerUser(ctx, 'IC Viewer');
  parentOnly = await registerUser(ctx, 'IC Parent Accountant');
  parent = await createOrg(ctx, owner, { name: 'IC Holding Ltd' });
  sub = await createOrg(ctx, owner, { name: 'IC Sub Pvt Ltd' });
  fze = await createOrg(ctx, owner, { name: 'IC Trading FZE', countryCode: 'AE', functionalCurrency: 'AED', fiscalYearStartMonth: 4 });
  for (const o of [parent, sub]) await ctx.http().post(`${o.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  await ctx.http().post(`${parent.base}/members`).set(owner.auth).send({ email: parentOnly.email, role: 'ACCOUNTANT' }).expect(201);
  for (const o of [parent, sub, fze]) {
    await account(o, '1250', 'Due from group companies', 'ASSET');
    await account(o, '2160', 'Due to group companies', 'LIABILITY');
    await account(o, '4300', 'Intercompany revenue', 'REVENUE');
    await account(o, '6950', 'Intercompany charges', 'EXPENSE');
  }
  G = `${parent.base}/consolidation/groups`;
  groupId = (await ctx.http().post(G).set(owner.auth).send({ name: 'IC group' }).expect(201)).body.id;
  await ctx.http().post(`${G}/${groupId}/members`).set(owner.auth).send({ orgId: sub.orgId }).expect(201);
  await ctx.http().post(`${G}/${groupId}/members`).set(owner.auth).send({ orgId: fze.orgId }).expect(201);
  await ctx.http().put(`${G}/${groupId}/rates`).set(owner.auth).send({ memberOrgId: fze.orgId, periodEnd: T, closing: '23', average: '22.5', historical: '22' }).expect(200);
});
afterAll(async () => {
  await ctx?.app.close();
});

const ACCOUNTS = { receivable: '1250', payable: '2160', revenue: '4300', expense: '6950' };

describe('intercompany accounts', () => {
  it('checks each account against the company chart and keeps them apart from elimination rules', async () => {
    const url = (o: Org) => `${G}/${groupId}/members/${o.orgId}/intercompany-accounts`;
    const wrong = await ctx.http().put(url(parent)).set(owner.auth).send({ ...ACCOUNTS, receivable: '4300', revenue: '1250' }).expect(422);
    expect(wrong.body.details.issues[0]).toContain('The receivable account must be asset account');
    expect((await ctx.http().put(url(parent)).set(owner.auth).send({ ...ACCOUNTS, payable: '1250' }).expect(422)).body.message).toBe('Use a different account for each purpose');
    await ctx.http().put(url(parent)).set(owner.auth).send({ ...ACCOUNTS, expense: '9999' }).expect(422);
    // A rule already on 1250 must go first.
    const d = (await ctx.http().post(`${G}/${groupId}/rules`).set(owner.auth).send({ name: 'Old current account', left: { orgId: parent.orgId, code: '1250' }, right: { orgId: sub.orgId, code: '2160' } }).expect(201)).body;
    expect((await ctx.http().put(url(parent)).set(owner.auth).send(ACCOUNTS).expect(422)).body.message).toContain('Old current account');
    await ctx.http().delete(`${G}/${groupId}/rules/${d.rules[0].id}`).set(owner.auth).expect(200);
    for (const o of [parent, sub, fze]) {
      const res = (await ctx.http().put(url(o)).set(owner.auth).send(ACCOUNTS).expect(200)).body;
      expect(res.members.find((m: { orgId: string }) => m.orgId === o.orgId).intercompanyAccounts).toEqual(ACCOUNTS);
    }
    // And a rule cannot be added on an intercompany account.
    const rule = await ctx.http().post(`${G}/${groupId}/rules`).set(owner.auth).send({ name: 'Double', left: { orgId: parent.orgId, code: '4300' }, right: { orgId: sub.orgId, code: '6950' } }).expect(422);
    expect(rule.body.details.issues).toContain('Account 4300 is an intercompany account: its intercompany transactions are already eliminated by their exact amounts');
    await ctx.http().put(url(sub)).set(parentOnly.auth).send(ACCOUNTS).expect(403);
  });
});

describe('intercompany transactions', () => {
  it('posts a charge in both companies at once', async () => {
    charge = (await post({ kind: 'CHARGE', fromOrgId: parent.orgId, toOrgId: sub.orgId, amount: '50000.00' })).body;
    expect(charge).toMatchObject({ reference: 'IC-0001', kind: 'CHARGE', from: { amount: '50000.00' }, to: { amount: '50000.00', currency: 'INR' }, reversedOn: null });
    expect(charge.from.entry.entryNumber).toBeGreaterThan(0);
    const pj = (await journalsOf(parent)).find((j) => j.id === charge.from.entry.id)!;
    const sj = (await journalsOf(sub)).find((j) => j.id === charge.to.entry.id)!;
    expect(pj).toMatchObject({ source: 'INTERCOMPANY', reference: 'IC-0001' });
    expect(sj).toMatchObject({ source: 'INTERCOMPANY', reference: 'IC-0001' });
    expect(await balance(parent, '1250')).toBe('50000.00');
    expect(await balance(parent, '4300')).toBe('-50000.00');
    expect(await balance(sub, '6950')).toBe('50000.00');
    expect(await balance(sub, '2160')).toBe('-50000.00');
    // The entries cannot be reversed on their own.
    expect((await ctx.http().post(`${parent.base}/journals/${charge.from.entry.id}/reverse`).set(owner.auth).send({ date: T }).expect(409)).body.error).toBeTruthy();
  });

  it('posts a settlement through each company bank account', async () => {
    expect((await post({ kind: 'SETTLEMENT', fromOrgId: parent.orgId, toOrgId: sub.orgId, amount: '20000.00' }, owner, 422)).body.details.issues).toEqual([
      'Choose the bank account IC Holding Ltd receives the money in',
      'Choose the bank account IC Sub Pvt Ltd pays from',
    ]);
    expect((await post({ kind: 'SETTLEMENT', fromOrgId: parent.orgId, toOrgId: sub.orgId, amount: '20000.00', fromBankCode: '1250', toBankCode: '1120' }, owner, 422)).body.message).toContain('is not a bank or cash account');
    const s = (await post({ kind: 'SETTLEMENT', fromOrgId: parent.orgId, toOrgId: sub.orgId, amount: '20000.00', fromBankCode: '1120', toBankCode: '1120', description: 'Part payment' })).body;
    expect(s.reference).toBe('IC-0002');
    expect(await balance(parent, '1250')).toBe('30000.00');
    expect(await balance(sub, '2160')).toBe('-30000.00');
    expect(await balance(sub, '1120')).toBe('-20000.00');
  });

  it('needs an amount in each currency when the companies differ', async () => {
    expect((await post({ kind: 'CHARGE', fromOrgId: parent.orgId, toOrgId: fze.orgId, amount: '23000.00' }, owner, 422)).body.message).toBe('Enter the amount in AED for IC Trading FZE as an amount above zero');
    expect((await post({ kind: 'CHARGE', fromOrgId: parent.orgId, toOrgId: sub.orgId, amount: '10.00', toAmount: '11.00' }, owner, 422)).body.message).toBe('Both companies keep their books in INR, so the amounts must be the same');
    expect((await post({ kind: 'CHARGE', fromOrgId: parent.orgId, toOrgId: sub.orgId, amount: '10.001' }, owner, 422)).body.message).toBe('The amount in INR has more decimals than INR allows');
    const x = (await post({ kind: 'CHARGE', fromOrgId: parent.orgId, toOrgId: fze.orgId, amount: '23000.00', toAmount: '1000.00', description: 'Software licence' })).body;
    expect(x).toMatchObject({ from: { amount: '23000.00' }, to: { amount: '1000.00', currency: 'AED' } });
    expect(await balance(fze, '6950')).toBe('1000.00');
  });

  it('posts nothing when the second company cannot take the entry', async () => {
    const periods = (await ctx.http().get(`${sub.base}/periods`).set(owner.auth).expect(200)).body as { id: string; startDate: string; endDate: string }[];
    const current = periods.find((p) => p.startDate <= T && T <= p.endDate)!;
    await ctx.http().post(`${sub.base}/periods/${current.id}/lock`).set(owner.auth).expect(200);
    const before = (await journalsOf(parent)).length;
    expect((await post({ kind: 'CHARGE', fromOrgId: parent.orgId, toOrgId: sub.orgId, amount: '999.00' }, owner, 409)).body.error).toBe('PERIOD_NOT_OPEN');
    expect((await journalsOf(parent)).length).toBe(before);
    expect(await balance(parent, '1250')).toBe('53000.00');
    await ctx.http().post(`${sub.base}/periods/${current.id}/unlock`).set(owner.auth).expect(200);
    // The number was not used up by the failed attempt's transaction.
    const list = (await ctx.http().get(`${G}/${groupId}/intercompany`).set(owner.auth).expect(200)).body;
    expect(list.items.map((t: Txn) => t.reference)).toEqual(['IC-0003', 'IC-0002', 'IC-0001']);
  });

  it('needs posting rights in both companies', async () => {
    const r = await post({ kind: 'CHARGE', fromOrgId: parent.orgId, toOrgId: sub.orgId, amount: '5.00' }, viewer, 403);
    expect(r.body.details.issues).toEqual(['You need journals.post in IC Holding Ltd', 'You need journals.post in IC Sub Pvt Ltd']);
    const p = await post({ kind: 'CHARGE', fromOrgId: parent.orgId, toOrgId: sub.orgId, amount: '5.00' }, parentOnly, 403);
    expect(p.body.details.issues).toEqual(['You need journals.post in a company you are not a member of']);
    // The accountant sees nothing of transactions involving a company they are not in.
    const l = (await ctx.http().get(`${G}/${groupId}/intercompany`).set(parentOnly.auth).expect(200)).body;
    expect(l).toEqual({ items: [], hidden: 3 });
  });

  it('eliminates exactly the posted amounts in the consolidation', async () => {
    const r = await report();
    expect(r.balanced).toBe(true);
    const ledger = r.eliminations.filter((e: { source: string }) => e.source === 'LEDGER');
    expect(ledger.map((e: { name: string; matched: boolean }) => [e.name, e.matched])).toEqual([
      ['Intercompany balance: IC Sub Pvt Ltd owes IC Holding Ltd', true],
      ['Intercompany charges: IC Holding Ltd to IC Sub Pvt Ltd', true],
      ['Intercompany balance: IC Trading FZE owes IC Holding Ltd', true],
      ['Intercompany charges: IC Holding Ltd to IC Trading FZE', false],
    ]);
    // 1,000 AED at the closing rate 23 is 23,000 INR, which agrees with the parent's receivable.
    // The charge at the average rate 22.5 is 22,500 INR against 23,000 INR of revenue.
    expect(ledger[2]).toMatchObject({ left: { amount: '23000.00' }, right: { amount: '-23000.00' } });
    expect(ledger[3]).toMatchObject({ left: { amount: '-23000.00' }, right: { amount: '22500.00' }, difference: '-500.00' });
    const row = (code: string) => r.rows.find((x: { code: string }) => x.code === code);
    expect(row('1250').consolidated).toBe('0.00');
    expect(row('2160').consolidated).toBe('0.00');
    expect(row('4300').consolidated).toBe('0.00');
  });

  it('reverses both entries together', async () => {
    const rv = (await ctx.http().post(`${G}/${groupId}/intercompany/${charge.id}/reverse`).set(owner.auth).send({ date: T }).expect(200)).body;
    expect(rv.reversedOn).toBe(T);
    expect(rv.from.reversal.entryNumber).toBeGreaterThan(0);
    expect(rv.to.reversal.entryNumber).toBeGreaterThan(0);
    expect(await balance(parent, '1250')).toBe((30000 + 23000 - 50000).toFixed(2));
    expect(await balance(sub, '2160')).toBe('20000.00');
    await ctx.http().post(`${G}/${groupId}/intercompany/${charge.id}/reverse`).set(owner.auth).send({ date: T }).expect(409);
    await ctx.http().post(`${G}/${groupId}/intercompany/${charge.id}/reverse`).set(viewer.auth).send({ date: T }).expect(403);
    const r = await report();
    expect(r.balanced).toBe(true);
    expect(r.rows.find((x: { code: string }) => x.code === '1250').consolidated).toBe('0.00');
  });

  it('keeps members and the group while transactions exist, and audits', async () => {
    expect((await ctx.http().delete(`${G}/${groupId}/members/${sub.orgId}`).set(owner.auth).expect(409)).body.error).toBe('MEMBER_IN_USE');
    expect((await ctx.http().delete(`${G}/${groupId}`).set(owner.auth).expect(409)).body.error).toBe('GROUP_IN_USE');
    const audit = (await ctx.http().get(`${parent.base}/audit-events?entityType=intercompany_transaction&limit=100`).set(owner.auth).expect(200)).body;
    const actions = (Array.isArray(audit) ? audit : audit.items).map((e: { action: string }) => e.action);
    expect(actions.filter((a: string) => a === 'intercompany.posted')).toHaveLength(3);
    expect(actions).toContain('intercompany.reversed');
    const subAudit = (await ctx.http().get(`${sub.base}/audit-events?entityType=journal_entry&limit=100`).set(owner.auth).expect(200)).body;
    expect((Array.isArray(subAudit) ? subAudit : subAudit.items).some((e: { action: string }) => e.action === 'journal.system_posted')).toBe(true);
  });
});
