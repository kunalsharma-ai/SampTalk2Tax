import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Automatic expense categorisation (EXP-020, AP-020) against the real API and database: approved
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
