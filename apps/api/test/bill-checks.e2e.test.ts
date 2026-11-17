import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Unusual bill checks (AP-031) against the real API and database: a vendor's ordinary bills,
 * then one far above the usual with a price jump and a new account, a vendor whose bank details
 * just changed, the worklist, and reviews that cover only the findings they saw.
 */
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let C: string;
const id: Record<string, string> = {};

const bill = async (vendor: string, issueDate: string, reference: string, lines: { account: string; description: string; unitPrice: string; quantity?: string }[], post = true) =>
  (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendor, issueDate, reference, post, lines: lines.map((l) => ({ accountId: org.acc[l.account], description: l.description, quantity: l.quantity ?? '1', unitPrice: l.unitPrice })) }).expect(201)).body.id as string;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Bill Check Owner');
  viewer = await registerUser(ctx, 'Bill Check Viewer');
  org = await createOrg(ctx, owner, { name: 'Bill Checks Pvt Ltd' });
  C = `${org.base}/purchases/bill-checks`;
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  for (const name of ['Paper Mart', 'Swift Logistics']) id[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, isVendor: true }).expect(201)).body.id;
  for (const [i, price] of [['1', '2400.00'], ['2', '2500.00'], ['3', '2450.00']] as const) {
    id[`paper${i}`] = await bill(id['Paper Mart']!, addDays(T, -90 + Number(i) * 20), `PM-${i}`, [{ account: '6600', description: 'A4 paper, 10 reams', unitPrice: price }]);
  }
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('unusual bill checks', () => {
  it('finds nothing in an ordinary bill', async () => {
    id.ok = await bill(id['Paper Mart']!, addDays(T, -5), 'PM-4', [{ account: '6600', description: 'A4 paper, 10 reams', unitPrice: '2550.00' }]);
    const r = (await ctx.http().get(`${C}/${id.ok}`).set(viewer.auth).expect(200)).body;
    expect(r).toMatchObject({ documentId: id.ok, vendor: 'Paper Mart', findings: [], highest: null, review: null });
    // Only earlier bills count: the vendor's first bill is marked as such, for information.
    const first = (await ctx.http().get(`${C}/${id.paper1}`).set(viewer.auth).expect(200)).body;
    expect(first.findings.map((f: { code: string }) => f.code)).toEqual(['FIRST_BILL']);
  });

  it('flags a reused vendor invoice number, a much larger bill, a price jump and a new account', async () => {
    id.odd = await bill(id['Paper Mart']!, addDays(T, -2), 'pm 2', [
      { account: '6600', description: 'A4 Paper, 10 reams', unitPrice: '3400.00' },
      { account: '6400', description: 'Printer lease', unitPrice: '9000.00' },
    ], false);
    const r = (await ctx.http().get(`${C}/${id.odd}`).set(viewer.auth).expect(200)).body;
    expect(r.findings.map((f: { code: string }) => f.code)).toEqual(['SAME_VENDOR_REFERENCE', 'AMOUNT_ABOVE_USUAL', 'PRICE_JUMP', 'NEW_ACCOUNT']);
    expect(r.findings[0]).toMatchObject({ severity: 'HIGH', relatedIds: [id.paper2] });
    expect(r.findings[2].detail).toMatch(/^A4 Paper, 10 reams: 3400\.00 a unit against 2550\.00 on BILL-\d+ \(.+\), up 33%\.$/);
    expect(r.highest).toBe('HIGH');
  });

  it('flags a vendor whose bank details just changed and are not verified', async () => {
    await ctx.http().put(`${org.base}/contacts/${id['Swift Logistics']}/bank-details`).set(owner.auth).send({ accountName: 'Swift Logistics', accountNumber: '50100999888', ifsc: 'HDFC0001234' }).expect(200);
    id.swift = await bill(id['Swift Logistics']!, T, 'SL-77', [{ account: '6400', description: 'Freight', unitPrice: '20000.00' }]);
    const r = (await ctx.http().get(`${C}/${id.swift}`).set(viewer.auth).expect(200)).body;
    expect(r.findings.map((f: { code: string }) => f.code)).toEqual(['BANK_DETAILS_CHANGED', 'BANK_DETAILS_UNVERIFIED', 'FIRST_BILL', 'ROUND_AMOUNT']);
  });

  it('lists bills to review, and a review covers only the findings it saw', async () => {
    const list = (await ctx.http().get(C).set(viewer.auth).expect(200)).body;
    expect(list.summary).toMatchObject({ toReview: 2, high: 2, reviewed: 0 });
    // For-information findings (the first bill from Paper Mart) stay off the list.
    expect(list.items.map((i: { documentId: string }) => i.documentId).sort()).toEqual([id.odd, id.swift].sort());

    await ctx.http().post(`${C}/${id.swift}/review`).set(viewer.auth).send({ note: 'Called Swift on the number in the contract' }).expect(403);
    expect((await ctx.http().post(`${C}/${id.swift}/review`).set(owner.auth).send({ note: 'ok' }).expect(400)).body.error).toBeDefined();
    const reviewed = (await ctx.http().post(`${C}/${id.swift}/review`).set(owner.auth).send({ note: 'Called Swift on the number in the contract; new account confirmed' }).expect(200)).body;
    expect(reviewed.review).toMatchObject({ note: 'Called Swift on the number in the contract; new account confirmed', by: 'Bill Check Owner', current: true });
    expect((await ctx.http().post(`${C}/${id.ok}/review`).set(owner.auth).send({ note: 'Nothing to see' }).expect(422)).body.error).toBe('NOTHING_TO_REVIEW');

    const after = (await ctx.http().get(C).set(viewer.auth).expect(200)).body;
    expect(after.summary).toMatchObject({ toReview: 1, reviewed: 1 });
    expect((await ctx.http().get(`${C}?includeReviewed=true`).set(viewer.auth).expect(200)).body.items.at(-1).documentId).toBe(id.swift);

    // Verifying the bank details changes the findings, so the old review no longer covers them.
    const approver = await registerUser(ctx, 'Bill Check Approver');
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: approver.email, role: 'APPROVER' }).expect(201);
    await ctx.http().post(`${org.base}/contacts/${id['Swift Logistics']}/bank-details/verify`).set(approver.auth).send({ note: 'Called Swift finance' }).expect(200);
    const now = (await ctx.http().get(`${C}/${id.swift}`).set(viewer.auth).expect(200)).body;
    expect(now.findings.map((f: { code: string }) => f.code)).toEqual(['BANK_DETAILS_CHANGED', 'FIRST_BILL', 'ROUND_AMOUNT']);
    expect(now.review.current).toBe(false);

    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, action: 'bill_check.reviewed' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.data).toMatchObject({ findings: ['BANK_DETAILS_CHANGED', 'BANK_DETAILS_UNVERIFIED', 'FIRST_BILL', 'ROUND_AMOUNT'] });
  });
});
