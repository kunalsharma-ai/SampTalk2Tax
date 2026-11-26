import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../src/admin/admin.service';
import { readsFromReplica } from '../src/common/replica-reads.interceptor';
import { loadConfig } from '../src/config';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Read replicas (PERF-011) against the real API and database, with MONGODB_REPLICA_READS=reports:
 * report pages read from a secondary (secondaryPreferred, at most 120 seconds behind) while
 * sign-in and permission checks, other pages and every write stay on the primary. The test
 * database is a one-member replica set, so the reads fall back to the primary and the answers are
 * the same; what is checked is where each command asked to be read from.
 */
let ctx: Ctx;
let owner: TestUser;
let support: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const READS = ['find', 'aggregate', 'count', 'distinct'];

interface Seen {
  command: string;
  collection: string;
  mode: string | null;
  maxStalenessSeconds?: number;
}
async function commandsDuring(fn: () => Promise<unknown>): Promise<Seen[]> {
  const seen: Seen[] = [];
  const stop = ctx.store.onCommandStarted((e) => {
    if (!READS.includes(e.commandName) && !['insert', 'update'].includes(e.commandName)) return;
    const pref = (e.command as { $readPreference?: { mode: string; maxStalenessSeconds?: number } }).$readPreference;
    seen.push({ command: e.commandName, collection: String(e.command[e.commandName]), mode: pref?.mode ?? null, maxStalenessSeconds: pref?.maxStalenessSeconds });
  });
  try {
    await fn();
  } finally {
    stop();
  }
  return seen;
}

beforeAll(async () => {
  ctx = await bootApp({ MONGODB_REPLICA_READS: 'reports', MONGODB_REPLICA_MAX_STALENESS_SECONDS: '120' });
  owner = await registerUser(ctx, 'Replica Owner');
  support = await registerUser(ctx, 'Replica Support');
  await ctx.app.get(AdminService).grant(support.email, 'SUPPORT');
  org = await createOrg(ctx, owner, { name: 'Replica Reads Traders' });
}, 60_000);
afterAll(async () => {
  await ctx?.app.close();
});

describe('Read replicas', () => {
  it('reads report pages from a replica, and the checks before them from the primary', async () => {
    let body: { rows?: unknown[] } = {};
    const seen = await commandsDuring(async () => {
      body = (await ctx.http().get(`${org.base}/reports/trial-balance?asOf=${today()}`).set(owner.auth).expect(200)).body;
    });
    expect(body).toBeTruthy();
    const reads = seen.filter((s) => READS.includes(s.command));
    const fromReplica = reads.filter((s) => s.mode === 'secondaryPreferred');
    expect(fromReplica.length).toBeGreaterThan(0);
    expect(fromReplica.every((s) => s.maxStalenessSeconds === 120)).toBe(true);
    // The report's own data came from the replica.
    expect(fromReplica.map((s) => s.collection)).toEqual(expect.arrayContaining(['accounts']));
    // Sign-in, membership and permission checks ran before the handler, on the primary.
    const checks = reads.filter((s) => s.mode === null).map((s) => s.collection);
    expect(checks.length).toBeGreaterThan(0);
    expect(fromReplica.map((s) => s.collection)).not.toContain('user_sessions');
  });

  it('keeps other pages and every write on the primary', async () => {
    const seen = await commandsDuring(async () => {
      await ctx.http().get(`${org.base}/accounts`).set(owner.auth).expect(200);
      await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Replica Customer', isCustomer: true }).expect(201);
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((s) => s.mode !== null)).toEqual([]);
  });

  it('shows the setting and the replica members in System health', async () => {
    const h = (await ctx.http().get('/v1/admin/system').set(support.auth).expect(200)).body;
    expect(h.database.replicaReads).toEqual({ mode: 'reports', maxStalenessSeconds: 120, secondaries: 0 });
    expect(h.problems).toContain('Report reads are set to use replicas, but the database has no secondary member: they go to the primary');
  });

  it('names only report pages read with GET, and refuses a staleness MongoDB would not accept', () => {
    expect(readsFromReplica('GET', '/v1/orgs/:orgId/reports/trial-balance')).toBe(true);
    expect(readsFromReplica('POST', '/v1/orgs/:orgId/reports/export')).toBe(false);
    expect(readsFromReplica('GET', '/v1/orgs/:orgId/report-views')).toBe(false);
    expect(readsFromReplica('GET', '/v1/orgs/:orgId/accounts')).toBe(false);
    expect(() => loadConfig({ ...process.env, MONGODB_REPLICA_READS: 'reports', MONGODB_REPLICA_MAX_STALENESS_SECONDS: '30' })).toThrow(/MONGODB_REPLICA_MAX_STALENESS_SECONDS/);
  });
});
