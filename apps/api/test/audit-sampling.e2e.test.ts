import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drawSample } from '@talk2tax/accounting-engine';
import { runInOrg } from '../src/common/tenant-context';
import { auditSamples } from '../src/db/collections/audit-samples';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Audit sampling (AUDIT-009) against the real API and database: random, monetary unit and
 * high-value samples drawn from posted journals and bills; the same seed draws the same items
 * again; each item's result recorded once until the sample completes; a change to the books
 * shows; samples kept as drawn; audited; permissions and tenant isolation.
 */
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const T = today();
type Item = { refId: string; label: string; amount: string; reason: string; result: string | null; note: string | null; testedBy: { name: string } | null };
type Sample = { id: string; reference: string; status: string; seed: string; interval: string | null; populationCount: number; populationTotal: string; populationChanged: boolean; redrawMatches: boolean; progress: { tested: number; exceptions: number; remaining: number }; items: Item[] };
const S = () => `${org.base}/audit-samples`;
const AMOUNTS = ['150.00', '320.00', '480.00', '760.00', '990.00', '1250.00', '1800.00', '2400.00', '3100.00', '4700.00', '6400.00', '25000.00'];
const je = (amount: string) => ({ date: T, post: true, memo: `Sampling test ${amount}`, lines: [{ accountId: org.acc['6200'], debit: amount }, { accountId: org.acc['1120'], credit: amount }] });

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Sampling Owner');
  accountant = await registerUser(ctx, 'Sampling Accountant');
  viewer = await registerUser(ctx, 'Sampling Viewer');
  outsider = await registerUser(ctx, 'Sampling Outsider');
  org = await createOrg(ctx, owner, { name: 'Sampling Test Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Sampling Ltd' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  for (const a of AMOUNTS) await ctx.http().post(`${org.base}/journals`).set(accountant.auth).send(je(a)).expect(201);
  const vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Basalt Traders', isVendor: true }).expect(201)).body.id;
  for (const p of ['900', '12000', '3500']) await ctx.http().post(`${org.base}/purchases/documents`).set(accountant.auth).send({ kind: 'BILL', contactId: vendor, issueDate: T, post: true, lines: [{ accountId: org.acc['6600'], quantity: '1', unitPrice: p }] }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('audit sampling', () => {
  let random: Sample;

  it('draws a random sample of posted journals that the same seed draws again', async () => {
    const body = { name: 'Journals this month', population: 'JOURNALS', from: T, to: T, method: 'RANDOM', size: 5, seed: 'fy-audit-1' };
    await ctx.http().post(S()).set(viewer.auth).send(body).expect(403);
    expect((await ctx.http().post(S()).set(owner.auth).send({ ...body, from: '2020-01-01', to: '2020-01-31' }).expect(422)).body.error).toBe('EMPTY_POPULATION');
    expect((await ctx.http().post(S()).set(owner.auth).send({ ...body, to: '2020-01-01' }).expect(422)).body.error).toBe('INVALID_RANGE');
    await ctx.http().post(S()).set(owner.auth).send({ ...body, size: 201 }).expect(400);
    random = (await ctx.http().post(S()).set(accountant.auth).send(body).expect(201)).body;
    expect(random).toMatchObject({ reference: 'S-001', status: 'OPEN', seed: 'fy-audit-1', populationCount: AMOUNTS.length + 3, populationTotal: '63750.00', populationChanged: false, redrawMatches: true, progress: { tested: 0, exceptions: 0, remaining: 5 } });
    expect(random.items).toHaveLength(5);
    expect(new Set(random.items.map((i) => i.refId)).size).toBe(5);
    expect(random.items.every((i) => i.reason === 'RANDOM' && /^Journal \d+/.test(i.label))).toBe(true);
    const again = (await ctx.http().post(S()).set(owner.auth).send({ ...body, name: 'The same again' }).expect(201)).body as Sample;
    expect(again.reference).toBe('S-002');
    expect(again.items.map((i) => i.refId)).toEqual(random.items.map((i) => i.refId));
    // Anyone can check it: the engine draws the same items from the same population and seed.
    const pop = AMOUNTS.map((a, k) => ({ id: `x${k}`, amount: a }));
    expect(drawSample(pop, 'RANDOM', 5, 'fy-audit-1')).toEqual(drawSample([...pop].reverse(), 'RANDOM', 5, 'fy-audit-1'));
    const seeded = (await ctx.http().post(S()).set(owner.auth).send({ ...body, seed: undefined, name: 'Own seed' }).expect(201)).body as Sample;
    expect(seeded.seed).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('picks by money in monetary unit sampling and takes every high-value bill', async () => {
    const mus = (await ctx.http().post(S()).set(owner.auth).send({ name: 'MUS journals', population: 'JOURNALS', from: T, to: T, method: 'MONETARY_UNIT', size: 4, seed: 'mus-1' }).expect(201)).body as Sample;
    // The bills' journals are posted journals too: 47,350 + 16,400 over 4.
    expect(mus.interval).toBe('15937.50');
    expect(mus.items.find((i) => i.amount === '25000.00')?.reason).toBe('ABOVE_INTERVAL');
    expect(mus.items.length).toBeLessThanOrEqual(4);

    expect((await ctx.http().post(S()).set(owner.auth).send({ name: 'Big bills', population: 'BILLS', from: T, to: T, method: 'HIGH_VALUE', size: 2 }).expect(422)).body.error).toBe('THRESHOLD_REQUIRED');
    const hv = (await ctx.http().post(S()).set(owner.auth).send({ name: 'Big bills', population: 'BILLS', from: T, to: T, method: 'HIGH_VALUE', size: 2, threshold: '3000' }).expect(201)).body as Sample;
    expect(hv.items.map((i) => [i.amount, i.reason])).toEqual([['12000.00', 'HIGH_VALUE'], ['3500.00', 'HIGH_VALUE']]);
    expect(hv.items[0]!.label).toMatch(/Basalt Traders$/);
    await ctx.http().get(S()).set(viewer.auth).expect(403);
    const all = (await ctx.http().get(S()).set(owner.auth).expect(200)).body;
    expect(all.samples.map((s: { reference: string }) => s.reference)).toEqual(['S-005', 'S-004', 'S-003', 'S-002', 'S-001']);
  });

  it('records each item once, and completes when every item is tested', async () => {
    const R = (refId: string) => `${S()}/${random.id}/items/${refId}/result`;
    const [a, b, ...rest] = random.items;
    expect((await ctx.http().post(R(a!.refId)).set(owner.auth).send({ result: 'EXCEPTION', note: 'bad' }).expect(422)).body.error).toBe('NOTE_REQUIRED');
    let s = (await ctx.http().post(R(a!.refId)).set(owner.auth).send({ result: 'EXCEPTION', note: 'No supporting invoice on file' }).expect(201)).body as Sample;
    expect(s.items[0]).toMatchObject({ result: 'EXCEPTION', note: 'No supporting invoice on file', testedBy: { name: 'Sampling Owner' } });
    expect((await ctx.http().post(R(a!.refId)).set(owner.auth).send({ result: 'OK' }).expect(409)).body.error).toBe('ALREADY_TESTED');
    expect((await ctx.http().post(R(random.items[0]!.refId.replace(/.$/, (c) => (c === '0' ? '1' : '0')))).set(owner.auth).send({ result: 'OK' }).expect(404)).body.error).toBe('NOT_IN_SAMPLE');
    await Promise.all([b!, ...rest].map((i) => ctx.http().post(R(i.refId)).set(accountant.auth).send({ result: 'OK' }).expect(201)));
    s = (await ctx.http().get(`${S()}/${random.id}`).set(owner.auth).expect(200)).body;
    expect(s).toMatchObject({ status: 'COMPLETED', progress: { tested: 5, exceptions: 1, remaining: 0 } });
    expect((await ctx.http().post(R(b!.refId)).set(owner.auth).send({ result: 'OK' }).expect(409)).body.error).toBe('SAMPLE_COMPLETED');
  });

  it('shows when the books changed since the sample was drawn, and keeps samples as drawn', async () => {
    await ctx.http().post(`${org.base}/journals`).set(accountant.auth).send(je('555.00')).expect(201);
    const s = (await ctx.http().get(`${S()}/${random.id}`).set(owner.auth).expect(200)).body as Sample;
    expect(s.populationChanged).toBe(true);
    await expect(runInOrg(org.orgId, () => ctx.store.collection(auditSamples).updateOne({ id: random.id }, { $set: { name: 'Changed' } }))).rejects.toThrow(/kept as it was completed/);
    const open = (await ctx.http().get(S()).set(owner.auth).expect(200)).body.samples.find((x: { reference: string }) => x.reference === 'S-002');
    await expect(runInOrg(org.orgId, () => ctx.store.collection(auditSamples).updateOne({ id: open.id }, { $set: { seed: 'other' } }))).rejects.toThrow(/selection it was drawn with/);
    await expect(runInOrg(org.orgId, () => ctx.store.collection(auditSamples).deleteOne({ id: open.id }))).rejects.toThrow(/kept as a record/);
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=audit_sample`).set(owner.auth).expect(200)).body;
    const actions = ((audit.items ?? audit) as { action: string }[]).map((e) => e.action);
    expect(actions.filter((x) => x === 'audit_sample.drawn')).toHaveLength(5);
    expect(actions.filter((x) => x === 'audit_sample.item_tested')).toHaveLength(5);
  });

  it('keeps each organisation to its own samples', async () => {
    await ctx.http().get(S()).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/audit-samples`).set(outsider.auth).expect(200)).body.samples).toEqual([]);
    await ctx.http().get(`${other.base}/audit-samples/${random.id}`).set(outsider.auth).expect(404);
    expect((await ctx.http().post(`${other.base}/audit-samples`).set(outsider.auth).send({ name: 'Theirs', population: 'JOURNALS', from: T, to: T, method: 'RANDOM', size: 3 }).expect(422)).body.error).toBe('EMPTY_POPULATION');
  });
});
