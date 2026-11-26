import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../src/admin/admin.service';
import { ApiInstancesService } from '../src/operations/api-instances.service';
import { bootApp, Ctx, registerUser, TestUser } from './helpers';

/**
 * Horizontal scaling (PERF-008) with two API servers on one database, as behind a load balancer:
 * a person signed in on one server is signed in on the other, rate limits are counted once across
 * both when RATE_LIMIT_STORE=database, and System health lists every running server and warns
 * about a server that still counts rate limits on its own.
 */
let a: Ctx;
let b: Ctx;
let owner: TestUser;
let support: TestUser;
const LIMIT = 6;

/** Waits, if needed, so that the next requests fall in one rate-limit minute. */
async function freshMinute() {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 15_000) await new Promise((r) => setTimeout(r, left + 50));
}

beforeAll(async () => {
  const shared = { RATE_LIMIT_STORE: 'database', RATE_LIMIT_API_PER_MINUTE: String(LIMIT) };
  a = await bootApp(shared);
  b = await bootApp(shared);
  owner = await registerUser(a, 'Scaling Owner');
  support = await registerUser(a, 'Scaling Support');
  await a.app.get(AdminService).grant(support.email, 'SUPPORT');
}, 60_000);
afterAll(async () => {
  await a?.app.close();
  await b?.app.close();
});

describe('Several API servers', () => {
  it('keeps a person signed in on whichever server answers', async () => {
    const org = (await a.http().post('/v1/orgs').set(owner.auth).send({ name: 'Scaling Traders', countryCode: 'IN', functionalCurrency: 'INR', fiscalYearStartMonth: 4 }).expect(201)).body;
    const list = (await b.http().get('/v1/orgs').set(owner.auth).expect(200)).body as { id: string }[];
    expect(list.map((o) => o.id)).toContain(org.id);
  });

  it('counts rate limits once across the servers', async () => {
    const user = await registerUser(a, 'Rate Limited Person');
    await freshMinute();
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT + 2; i++) statuses.push((await (i % 2 ? b : a).http().get('/v1/orgs').set(user.auth)).status);
    // Six requests pass between the two servers; the seventh, on either, is turned away.
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 429, 429]);
    const last = await b.http().get('/v1/orgs').set(user.auth).expect(429);
    expect(last.headers['ratelimit-limit']).toBe(String(LIMIT));
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('lists every running server in System health', async () => {
    const h = (await b.http().get('/v1/admin/system').set(support.auth).expect(200)).body;
    const ids = [a.app.get(ApiInstancesService).id, b.app.get(ApiInstancesService).id];
    expect(ids[0]).not.toBe(ids[1]);
    const mine = h.servers.filter((s: { rateLimitStore: string }) => s.rateLimitStore === 'database');
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(h.servers[0]).toMatchObject({ current: true, rateLimitStore: 'database', pid: process.pid });
    expect(h.servers.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
  });

  it('warns about a server counting rate limits alone, and forgets a server that stops', async () => {
    const lone = await bootApp({ RATE_LIMIT_STORE: 'memory' });
    const loneId = lone.app.get(ApiInstancesService).id;
    try {
      const h = (await a.http().get('/v1/admin/system').set(support.auth).expect(200)).body;
      expect(h.problems).toEqual(expect.arrayContaining([expect.stringMatching(/API servers are running and rate limits are counted on each server alone/)]));
    } finally {
      await lone.app.close();
    }
    const left = await a.db.collection('api_instances').findOne({ _id: loneId as never });
    expect(left).toBeNull();
  });
});
