import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Regulatory change monitoring (TAX-046) against the real API and database: a German business sees
 * the e-invoicing changes for Germany (one already in force, two coming), the rules Talk2Tax uses
 * for Germany with when they were checked, and its own scheduled VAT rate change; it records one
 * change as dealt with, once, audited. Changes for other countries are refused.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let de: Awaited<ReturnType<typeof createOrg>>;
const R = () => `${de.base}/tax/regulatory-changes`;
const next = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Reg Owner');
  viewer = await registerUser(ctx, 'Reg Viewer');
  de = await createOrg(ctx, owner, { name: 'Synthetic GmbH', countryCode: 'DE', functionalCurrency: 'EUR', fiscalYearStartMonth: 1 });
  await ctx.http().post(`${de.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  const rate = (
    await ctx.http().post(`${de.base}/tax-rates`).set(owner.auth).send({ name: 'Synthetic standard 19%', rate: '19', salesAccountId: de.acc['2300'], purchaseAccountId: de.acc['1450'] }).expect(201)
  ).body.id;
  await ctx.http().post(`${de.base}/tax-rates/${rate}/versions`).set(owner.auth).send({ rate: '21', effectiveFrom: next, reason: 'Synthetic rate change' }).expect(201);
});
afterAll(async () => ctx?.app.close());

describe('regulatory change monitoring', () => {
  it("shows Germany's changes, the rules used and the scheduled rate change", async () => {
    const o = (await ctx.http().get(R()).set(viewer.auth).expect(200)).body;
    expect(o.country).toBe('DE');
    expect(o.changes.map((c: { key: string; status: string }) => `${c.key} ${c.status}`)).toEqual([
      'DE-EINVOICE-RECEIVE-2025 IN_FORCE',
      'DE-EINVOICE-ISSUE-2027 TO_REVIEW',
      'DE-EINVOICE-ALL-2028 TO_REVIEW',
    ]);
    expect(o.rules.map((r: { key: string }) => r.key)).toEqual(expect.arrayContaining(['country:DE', 'invoice:DE']));
    expect(o.rules.every((r: { countries: string[] }) => r.countries.length === 0 || r.countries.includes('DE'))).toBe(true);
    expect(o.rateChanges).toEqual([expect.objectContaining({ name: 'Synthetic standard 19%', from: '19', to: '21', effectiveFrom: next })]);
    expect(o.summary).toMatchObject({ toReview: 2, upcoming: 2, scheduledRateChanges: 1 });
  });

  it('records a change as dealt with once, audited', async () => {
    const url = `${R()}/DE-EINVOICE-ISSUE-2027/dealt-with`;
    await ctx.http().post(url).set(viewer.auth).send({ note: 'x' }).expect(403);
    await ctx.http().post(`${R()}/US-1099-THRESHOLD-2026/dealt-with`).set(owner.auth).send({}).expect(404);
    await ctx.http().post(`${R()}/not a key/dealt-with`).set(owner.auth).send({}).expect(400);
    const o = (await ctx.http().post(url).set(owner.auth).send({ note: 'Our bank portal sends XRechnung' }).expect(200)).body;
    expect(o.changes.find((c: { key: string }) => c.key === 'DE-EINVOICE-ISSUE-2027')).toMatchObject({
      status: 'DEALT_WITH',
      acknowledgement: { note: 'Our bank portal sends XRechnung', by: 'Reg Owner' },
    });
    expect(o.summary.toReview).toBe(1);
    await ctx.http().post(url).set(owner.auth).send({}).expect(409);
    const ev = await ctx.db.collection('audit_events').findOne({ orgId: de.orgId, action: 'regulatory_change.dealt_with' });
    expect(ev?.data).toMatchObject({ effectiveOn: '2027-01-01', note: 'Our bank portal sends XRechnung' });
  });
});
