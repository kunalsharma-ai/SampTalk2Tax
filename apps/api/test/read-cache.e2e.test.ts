import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentStoreService } from '../src/common/document-store.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * The read cache (PERF-010): what the auth guard reads on every request comes from memory, and
 * a change to it takes effect on the next request, whether it was made through this server,
 * straight in the database, or through another server on the same database.
 */
let a: Ctx;
let b: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;

const cacheOf = (ctx: Ctx) => ctx.app.get(DocumentStoreService).readCache!;
async function until(check: () => Promise<boolean>, ms = 3_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

beforeAll(async () => {
  a = await bootApp();
  b = await bootApp();
  owner = await registerUser(a, 'Cache Owner');
  org = await createOrg(a, owner, { name: 'Read Cache Pvt Ltd' });
  expect(await until(async () => cacheOf(a).isLive && cacheOf(b).isLive)).toBe(true);
}, 60_000);
afterAll(async () => {
  await a?.app.close();
  await b?.app.close();
});

async function member(role = 'ACCOUNTANT') {
  const u = await registerUser(a, `Cache ${role}`);
  await a.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  return u;
}

describe('the read cache', () => {
  it('answers repeated requests from memory', async () => {
    const before = { ...cacheOf(a).stats };
    for (let i = 0; i < 5; i++) await a.http().get(`${org.base}/accounts`).set(owner.auth).expect(200);
    expect(cacheOf(a).stats.hits - before.hits).toBeGreaterThanOrEqual(5 * 3); // membership, organisation, plan at least
  });

  it('a member who is removed is refused on the very next request', async () => {
    const u = await member();
    await a.http().get(`${org.base}/accounts`).set(u.auth).expect(200);
    await a.http().get(`${org.base}/accounts`).set(u.auth).expect(200); // now cached
    await a.http().delete(`${org.base}/members/${u.id}`).set(owner.auth).expect(204);
    await a.http().get(`${org.base}/accounts`).set(u.auth).expect(404);
  });

  it('a role change applies on the next request', async () => {
    const u = await member('ACCOUNTANT');
    await a.http().post(`${org.base}/contacts`).set(u.auth).send({ name: 'Allowed', isCustomer: true }).expect(201);
    await a.http().put(`${org.base}/members/${u.id}`).set(owner.auth).send({ role: 'VIEWER' }).expect(200);
    await a.http().post(`${org.base}/contacts`).set(u.auth).send({ name: 'Not Allowed', isCustomer: true }).expect(403);
  });

  it('a change made straight in the database applies on the next request', async () => {
    await a.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Before Suspension', isCustomer: true }).expect(201);
    await a.db.collection('organizations').updateOne({ _id: org.orgId as never }, { $set: { suspendedAt: new Date(), suspendedReason: 'Read cache test' } });
    await a.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'During Suspension', isCustomer: true }).expect(423);
    await a.db.collection('organizations').updateOne({ _id: org.orgId as never }, { $set: { suspendedAt: null, suspendedReason: null } });
    await a.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'After Suspension', isCustomer: true }).expect(201);
  });

  it('a member removed through another server is refused here within moments', async () => {
    const u = await member();
    await a.http().get(`${org.base}/accounts`).set(u.auth).expect(200);
    await a.http().get(`${org.base}/accounts`).set(u.auth).expect(200);
    await b.http().delete(`${org.base}/members/${u.id}`).set(owner.auth).expect(204);
    // The other server's change reaches this one through the change stream.
    expect(await until(async () => (await a.http().get(`${org.base}/accounts`).set(u.auth)).status === 404, 2_000)).toBe(true);
  });

  it('two-step sign-in required by the organisation applies at once', async () => {
    const u = await member();
    await a.http().get(`${org.base}/accounts`).set(u.auth).expect(200);
    await a.db
      .collection('org_security_settings')
      .insertOne({ _id: crypto.randomUUID() as never, orgId: org.orgId, requireTwoStep: true, updatedById: owner.id, createdAt: new Date(), updatedAt: new Date() });
    expect((await a.http().get(`${org.base}/accounts`).set(u.auth).expect(403)).body.error).toBe('MFA_REQUIRED');
    await a.db.collection('org_security_settings').deleteMany({ orgId: org.orgId });
    await a.http().get(`${org.base}/accounts`).set(u.auth).expect(200);
  });

  it('keeps nothing while it cannot follow changes', async () => {
    const cache = cacheOf(a);
    await cache.stop();
    const before = { ...cache.stats };
    await a.http().get(`${org.base}/accounts`).set(owner.auth).expect(200);
    expect(cache.stats.hits).toBe(before.hits);
    expect(cache.isLive).toBe(false);
    cache.start();
    expect(await until(async () => cache.isLive)).toBe(true);
  });
});
