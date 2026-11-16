import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Vendor risk monitoring (AP-024) against the real API and database: the risk factors found from
 * bank details, spend and onboarding, reviews (kept as recorded), a new factor or a review date
 * asking for another review, the VENDOR_RISK alert, permissions and tenant isolation.
 */
const T = today();
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

let ctx: Ctx;
let owner: TestUser;
let approver: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const v: Record<string, { id: string; name: string }> = {};
const R = () => `${org.base}/purchases/vendor-risk`;
const raw = (sql: string, ...args: unknown[]) =>
  ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
    return tx.$executeRawUnsafe(sql, ...args);
  });
const bill = (contactId: string, amount: string) =>
  ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId, issueDate: T, dueDate: addDays(T, 30), lines: [{ accountId: org.acc['6600'], description: 'Supplies', quantity: '1', unitPrice: amount }], post: true }).expect(201);
const bank = (contactId: string, accountNumber: string) =>
  ctx.http().put(`${org.base}/contacts/${contactId}/bank-details`).set(owner.auth).send({ accountName: 'Account holder', accountNumber, ifsc: 'HDFC0001234' }).expect(200);
const row = async (id: string) => (await ctx.http().get(R()).set(viewer.auth).expect(200)).body.vendors.find((x: { id: string }) => x.id === id);
const codes = (r: { factors: { code: string; level: string }[] }) => r.factors.map((f) => `${f.code}:${f.level}`);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Risk Owner');
  approver = await registerUser(ctx, 'Risk Approver');
  viewer = await registerUser(ctx, 'Risk Viewer');
  outsider = await registerUser(ctx, 'Risk Outsider');
  org = await createOrg(ctx, owner, { name: 'Tungabhadra Engineering' });
  await createOrg(ctx, outsider, { name: 'Other Org' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: approver.email, role: 'APPROVER' }).expect(201);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  const mk = async (key: string, name: string) => (v[key] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ isVendor: true, name }).expect(201)).body);
  await mk('kaveri', 'Kaveri Metals');
  await mk('godavari', 'Godavari Tools');
  await mk('krishna', 'Krishna Tools');
  await mk('tiny', 'Tiny Supplies');
  await bill(v.kaveri!.id, '60000.00');
  await bill(v.godavari!.id, '10000.00');
  await bill(v.krishna!.id, '5000.00');
  await bill(v.tiny!.id, '1000.00');
  await bank(v.godavari!.id, '5010 0012 3456');
  await bank(v.krishna!.id, '501000123456');
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('vendor risk', () => {
  it('finds each vendor’s risk factors, the ones waiting for review first', async () => {
    const r = (await ctx.http().get(R()).set(viewer.auth).expect(200)).body;
    expect(r.asOf).toBe(T);
    expect(r.totalSpend).toBe('76000.00');
    expect(r.totals).toMatchObject({ vendors: 4, high: 2, medium: 1, low: 0, needsReview: 3 });
    const g = r.vendors.find((x: { id: string }) => x.id === v.godavari!.id);
    expect(codes(g)).toEqual(['BANK_SHARED:HIGH', 'BANK_CHANGED_UNVERIFIED:HIGH', 'NEW_VENDOR:MEDIUM']);
    expect(g.factors[0].detail).toContain('Krishna Tools');
    expect(g).toMatchObject({ level: 'HIGH', need: 'NEVER_REVIEWED', share: '13.2', owed: '10000.00' });
    expect(codes(r.vendors.find((x: { id: string }) => x.id === v.kaveri!.id))).toEqual(['CONCENTRATION:MEDIUM', 'NEW_VENDOR:MEDIUM']);
    expect(r.vendors.at(-1)).toMatchObject({ id: v.tiny!.id, level: 'NONE', need: null, factors: [] });
    expect(r.vendors.slice(0, 2).map((x: { level: string }) => x.level)).toEqual(['HIGH', 'HIGH']);
    await ctx.http().get(R()).set(outsider.auth).expect(404);
    await ctx.http().get(`${R()}/00000000-0000-4000-8000-000000000000`).set(viewer.auth).expect(404);
  });

  it('records a review and keeps it as recorded', async () => {
    const P = `${R()}/${v.kaveri!.id}/reviews`;
    const body = { decision: 'MONITOR', note: 'Second source for sheet metal being lined up', nextReviewOn: addDays(T, 90) };
    await ctx.http().post(P).set(viewer.auth).send(body).expect(403);
    await ctx.http().post(P).set(owner.auth).send({ ...body, decision: 'MAYBE' }).expect(400);
    expect((await ctx.http().post(P).set(owner.auth).send({ ...body, note: 'ok' }).expect(422)).body.message).toMatch(/Say what was looked at/);
    expect((await ctx.http().post(P).set(owner.auth).send({ ...body, nextReviewOn: addDays(T, 400) }).expect(422)).body.message).toBe('The next review must be within 365 days');
    const d = (await ctx.http().get(`${R()}/${v.kaveri!.id}`).set(viewer.auth).expect(200)).body;
    expect(d.suggestedNextReviewOn).toBe(addDays(T, 90));
    const r = (await ctx.http().post(P).set(owner.auth).send(body).expect(201)).body;
    expect(r).toMatchObject({ need: null, level: 'MEDIUM' });
    expect(r.reviews).toEqual([expect.objectContaining({ level: 'MEDIUM', factorCodes: ['CONCENTRATION', 'NEW_VENDOR'], decision: 'MONITOR', reviewedOn: T, reviewedBy: 'Risk Owner' })]);
    expect(r.lastReview).toMatchObject({ decision: 'MONITOR', nextReviewOn: addDays(T, 90) });
    await expect(raw(`UPDATE vendor_risk_reviews SET decision = 'STOP' WHERE contact_id = $1::uuid`, v.kaveri!.id)).rejects.toThrow(/kept as recorded/);
    await expect(raw(`DELETE FROM vendor_risk_reviews WHERE contact_id = $1::uuid`, v.kaveri!.id)).rejects.toThrow(/kept as recorded/);
  });

  it('asks again when a new factor appears, and when the review date comes', async () => {
    await bank(v.kaveri!.id, '000111222333');
    const k = await row(v.kaveri!.id);
    expect(k).toMatchObject({ level: 'HIGH', need: 'NEW_RISK', newFactors: ['BANK_CHANGED_UNVERIFIED'] });
    // Verified by someone other than who changed them: now only a recent change, low.
    await ctx.http().post(`${org.base}/contacts/${v.kaveri!.id}/bank-details/verify`).set(approver.auth).send({ note: 'Called their finance head on the number we hold' }).expect(200);
    expect(codes(await row(v.kaveri!.id))).toEqual(['CONCENTRATION:MEDIUM', 'NEW_VENDOR:MEDIUM', 'BANK_CHANGED_RECENTLY:LOW']);
    expect((await row(v.kaveri!.id)).need).toBe('NEW_RISK');
    // A review whose date has passed (inserted as if recorded long ago).
    await raw(
      `INSERT INTO vendor_risk_reviews (org_id, contact_id, level, factor_codes, decision, note, reviewed_on, next_review_on, reviewed_by_id) VALUES ($1::uuid, $2::uuid, 'HIGH', ARRAY['BANK_SHARED', 'BANK_CHANGED_UNVERIFIED'], 'ACCEPTED', 'Same group company, shared account confirmed', $3::date, $4::date, $5::uuid)`,
      org.orgId,
      v.krishna!.id,
      addDays(T, -100),
      addDays(T, -1),
      owner.id,
    );
    expect(await row(v.krishna!.id)).toMatchObject({ need: 'REVIEW_DUE', lastReview: { decision: 'ACCEPTED', reviewedBy: 'Risk Owner' } });
  });

  it('flags billing a vendor whose onboarding is required but not approved', async () => {
    await ctx.http().put(`${org.base}/purchases/onboarding-settings`).set(owner.auth).send({ required: true, requirements: [] }).expect(200);
    expect(codes(await row(v.tiny!.id))).toEqual(['ONBOARDING_INCOMPLETE:MEDIUM']);
    await ctx.http().put(`${org.base}/purchases/onboarding-settings`).set(owner.auth).send({ required: false, requirements: [] }).expect(200);
  });

  it('raises a VENDOR_RISK alert while a review is waiting, and clears it once reviewed', async () => {
    const scan = async () => {
      await ctx.http().post(`${org.base}/alerts/scan`).set(owner.auth).send({}).expect(200);
      return (await ctx.http().get(`${org.base}/alerts`).set(owner.auth).expect(200)).body.alerts.filter((a: { rule: string }) => a.rule === 'VENDOR_RISK');
    };
    const before = await scan();
    const g = before.find((a: { title: string }) => a.title.startsWith('Godavari Tools'));
    expect(g).toMatchObject({ severity: 'CRITICAL', title: 'Godavari Tools: high vendor risk, nobody has reviewed it yet' });
    expect(before.find((a: { title: string }) => a.title.startsWith('Krishna Tools')).title).toBe('Krishna Tools: high vendor risk, the review date has come');
    await ctx.http().post(`${R()}/${v.godavari!.id}/reviews`).set(owner.auth).send({ decision: 'STOP', note: 'Bank change not confirmed by the vendor; hold payments', nextReviewOn: addDays(T, 30) }).expect(201);
    const after = await scan();
    expect(after.find((a: { title: string }) => a.title.startsWith('Godavari Tools'))).toBeUndefined();
    expect((await ctx.http().get(R()).set(viewer.auth).expect(200)).body.totals.stopped).toBe(1);
  });
});
