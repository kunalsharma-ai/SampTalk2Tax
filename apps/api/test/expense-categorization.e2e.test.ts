import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Automatic expense categorisation (EXP-020, AP-020) and bill coding (AP-026) against the real API and database: approved
 * claims from the same merchant, a merchant whose name says the kind of spending, draft claims
 * that do not count, a vendor's posted bills for a bill line, permissions, validation and
 * isolation between organisations.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let ravi: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let paperMart: string;
let advisors: string;
let tax18: string;
const dim: Record<string, string> = {};

const claimLine = (body: object, user = ravi, o = org) => ctx.http().post(`${o.base}/expense-categorization/claim-line`).set(user.auth).send(body);
const billLine = (body: object, user = owner, o = org) => ctx.http().post(`${o.base}/expense-categorization/bill-line`).set(user.auth).send(body);
async function claim(lines: { account: string; merchant: string; description?: string }[], approve = true) {
  const x = (await ctx.http().post(`${org.base}/expense-claims`).set(ravi.auth).send({ title: 'Field visits', lines: lines.map((l, i) => ({ date: addDays(T, -10 - i), accountId: org.acc[l.account], merchant: l.merchant, description: l.description ?? null, amount: '450.00' })) }).expect(201)).body;
  if (!approve) return;
  await ctx.http().post(`${org.base}/expense-claims/${x.id}/submit`).set(ravi.auth).send({}).expect(200);
  await ctx.http().post(`${org.base}/expense-claims/${x.id}/approve`).set(owner.auth).send({ date: addDays(T, -5) }).expect(200);
}

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Category Owner');
  ravi = await registerUser(ctx, 'Ravi Category');
  viewer = await registerUser(ctx, 'Category Viewer');
  outsider = await registerUser(ctx, 'Category Outsider');
  org = await createOrg(ctx, owner, { name: 'Categories Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Categories Ltd' });
  for (const [u, role] of [[ravi, 'EMPLOYEE'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  await claim([{ account: '6700', merchant: 'Synthetic Movers', description: 'Site visit Pune' }, { account: '6700', merchant: 'Synthetic Movers' }]);
  await claim([{ account: '6700', merchant: 'synthetic movers!', description: 'Site visit Nashik' }, { account: '6500', merchant: 'Synthetic Movers', description: 'Expo stall' }]);
  await claim([{ account: '6200', merchant: 'Draft Only Co' }, { account: '6200', merchant: 'Draft Only Co' }], false);
  paperMart = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Paper Mart', isVendor: true }).expect(201)).body.id;
  tax18 = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'Standard 18%', rate: '18', salesAccountId: org.acc['2300'], purchaseAccountId: org.acc['1450'] }).expect(201)).body.id;
  for (const [type, code, name] of [['DEPARTMENT', 'FIN', 'Finance'], ['DEPARTMENT', 'OPS', 'Operations'], ['PROJECT', 'AUD', 'Annual audit']] as const) dim[code] = (await ctx.http().post(`${org.base}/dimensions`).set(owner.auth).send({ type, code, name }).expect(201)).body.id;
  advisors = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Advisors', isVendor: true }).expect(201)).body.id;
  for (const [i, dept, project] of [[1, 'FIN', 'AUD'], [2, 'FIN', null], [3, 'OPS', null]] as const) {
    await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: advisors, issueDate: addDays(T, -30 * i), reference: `SA-${i}`, post: true, lines: [{ accountId: org.acc['6600'], description: 'Monthly retainer', quantity: '1', unitPrice: '25000.00', taxRateId: tax18, departmentId: dim[dept], projectId: project ? dim[project] : null }, { accountId: org.acc['6500'], description: 'Newsletter design', quantity: '1', unitPrice: '5000.00', taxRateId: null }] }).expect(201);
  }
  for (const ref of ['PM-1', 'PM-2']) await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: paperMart, issueDate: addDays(T, -20), reference: ref, post: true, lines: [{ accountId: org.acc['6600'], description: 'A4 paper reams', quantity: '1', unitPrice: '2400.00' }] }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('expense categorisation', () => {
  it('follows how the same merchant was booked on approved claims', async () => {
    const r = (await claimLine({ merchant: 'SYNTHETIC MOVERS', description: 'Site visit Thane' }).expect(200)).body;
    expect(r.linesRead).toBe(4);
    // 3 of 4 lines from the merchant (2.25) and "site"/"visit" on 2 of 2 earlier lines (1 each).
    expect(r.suggestions).toEqual([
      { accountId: org.acc['6700'], code: '6700', name: 'Travel', confidence: 'HIGH', score: 4.3, because: ['3 of 4 earlier lines from SYNTHETIC MOVERS went here', '"site" was on 2 earlier lines, 2 of them booked here', '"visit" was on 2 earlier lines, 2 of them booked here'] },
    ]);
  });

  it('reads the kind of spending when there is no history, and ignores draft claims', async () => {
    expect((await claimLine({ merchant: 'Airtel', description: 'Broadband for October' }).expect(200)).body.suggestions).toEqual([{ accountId: org.acc['6300'], code: '6300', name: 'Utilities', confidence: 'MEDIUM', score: 2, because: ['"airtel" reads as phone and internet'] }]);
    expect((await claimLine({ merchant: 'Draft Only Co' }).expect(200)).body.suggestions).toEqual([]);
    expect((await claimLine({}).expect(200)).body.suggestions).toEqual([]);
  });

  it("suggests a bill line's account from the vendor's posted bills", async () => {
    const r = (await billLine({ contactId: paperMart, description: 'A4 paper, 5 reams' }, viewer).expect(200)).body;
    expect(r.suggestions[0]).toMatchObject({ code: '6600', confidence: 'HIGH', score: 5, because: ['2 of 2 earlier lines from Paper Mart went here', '"paper" was on 2 earlier lines, 2 of them booked here', '"reams" was on 2 earlier lines, 2 of them booked here'] });
    expect((await billLine({ description: 'Annual Zoom licence' }).expect(200)).body.suggestions[0]).toMatchObject({ code: '6400', because: ['"licence" reads as software'] });
  });

  it("codes a vendor's bill lines with the tax and department they usually had", async () => {
    const coding = (body: object, user = owner, o = org) => ctx.http().post(`${o.base}/expense-categorization/bill-coding`).set(user.auth).send(body);
    const r = (await coding({ contactId: advisors, lines: [{ lineNo: 1, description: 'Retainer for November' }, { lineNo: 2, description: 'Newsletter design' }, { lineNo: 3 }] }, viewer).expect(200)).body;
    expect(r).toMatchObject({ vendor: 'Synthetic Advisors', vendorLines: 6 });
    expect(r.lines[0]).toMatchObject({ lineNo: 1, account: { code: '6600' }, taxRateId: tax18, departmentId: dim.FIN, projectId: null, because: ['Standard 18% on 3 of 3 earlier lines from Synthetic Advisors to 6600', 'Finance on 2 of 3 earlier lines from Synthetic Advisors to 6600'] });
    // The newsletter went to Marketing with no tax and no department: nothing more is suggested.
    expect(r.lines[1]).toMatchObject({ lineNo: 2, account: { code: '6500' }, taxRateId: null, departmentId: null, because: [] });
    // With nothing but the vendor, half its lines went to each account: 1.5 points each, so the lower code first.
    expect(r.lines[2]).toMatchObject({ lineNo: 3, account: { code: '6500', confidence: 'LOW' } });
    // A department no longer in use is not suggested.
    await ctx.http().put(`${org.base}/dimensions/${dim.FIN}`).set(owner.auth).send({ code: 'FIN', name: 'Finance', isActive: false }).expect(200);
    const after = (await coding({ contactId: advisors, lines: [{ lineNo: 1, description: 'Retainer' }] }).expect(200)).body;
    expect(after.lines[0]).toMatchObject({ taxRateId: tax18, departmentId: null });
    await ctx.http().put(`${org.base}/dimensions/${dim.FIN}`).set(owner.auth).send({ code: 'FIN', name: 'Finance', isActive: true }).expect(200);
    await coding({ contactId: advisors, lines: [] }).expect(400);
    await coding({ lines: [{ lineNo: 1 }] }).expect(400);
    await coding({ contactId: advisors, lines: [{ lineNo: 1 }] }, ravi).expect(403);
    await coding({ contactId: advisors, lines: [{ lineNo: 1 }] }, outsider, other).expect(404);
  });

  it('checks permissions, validates and keeps organisations apart', async () => {
    await claimLine({ merchant: 'Uber' }, viewer).expect(403);
    await billLine({ description: 'Paper' }, ravi).expect(403);
    await claimLine({ merchant: 'Uber', extra: 1 }).expect(400);
    await billLine({ contactId: 'not-an-id' }).expect(400);
    await claimLine({ merchant: 'x'.repeat(201) }).expect(400);
    await claimLine({ merchant: 'Uber' }, outsider).expect(404);
    const theirs = (await claimLine({ merchant: 'Synthetic Movers' }, outsider, other).expect(200)).body;
    expect(theirs).toEqual({ suggestions: [], linesRead: 0 });
    // Another organisation's vendor is not found here: only the description counts.
    expect((await billLine({ contactId: paperMart, description: 'A4 paper' }, outsider, other).expect(200)).body).toEqual({ suggestions: [], linesRead: 0 });
  });
});
