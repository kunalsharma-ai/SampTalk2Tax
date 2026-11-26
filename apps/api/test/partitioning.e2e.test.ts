import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shardReadiness } from '@talk2tax/document-db';
import { AdminService } from '../src/admin/admin.service';
import { COLLECTIONS } from '../src/db/collections';
import { bootApp, Ctx, registerUser, TestUser } from './helpers';

/**
 * Database partitioning (PERF-009): which collections could be sharded by organisation today,
 * held to a baseline that may only shrink, and the sizes System health compares with the review
 * thresholds. See docs/PARTITIONING.md.
 */
const baseline = JSON.parse(readFileSync(join(__dirname, '../../../perf/partitioning-baseline.json'), 'utf8')) as { blocking: Record<string, string[]> };

describe('Partitioning readiness', () => {
  const now = shardReadiness(COLLECTIONS);

  it('adds no unique index that would block sharding by organisation', () => {
    const added = now.collections.flatMap((c) => c.blockers.filter((b) => !(baseline.blocking[c.name] ?? []).includes(b.index)).map((b) => `${c.name}.${b.index} (${b.key.join(', ')})`));
    // A new unique index on a tenant collection must start with orgId, e.g. { orgId: 1, number: 1 }.
    expect(added).toEqual([]);
  });

  it('keeps the baseline down to what still blocks', () => {
    const blocking = new Map(now.collections.map((c) => [c.name, c.blockers.map((b) => b.index)]));
    const stale = Object.entries(baseline.blocking).flatMap(([name, indexes]) => indexes.filter((i) => !(blocking.get(name) ?? []).includes(i)).map((i) => `${name}.${i}`));
    // Fixed or removed: take it out of perf/partitioning-baseline.json.
    expect(stale).toEqual([]);
  });

  it('gives every tenant collection an index that can carry an orgId shard key', () => {
    const without = COLLECTIONS.filter((c) => c.scope === 'tenant' && !(c.indexes ?? []).some((i) => Object.keys(i.key)[0] === 'orgId')).map((c) => c.name);
    expect(without).toEqual([]);
    expect(now.counts.READY).toBeGreaterThan(now.counts.NEEDS_ORG_PREFIX + now.counts.GLOBAL_LOOKUP);
  });
});

describe('Partitioning in System health', () => {
  let ctx: Ctx;
  let small: Ctx;
  let owner: TestUser;
  let support: TestUser;

  beforeAll(async () => {
    ctx = await bootApp();
    // Review thresholds of about 1 KB, so the test database is already "past" them.
    small = await bootApp({ PARTITIONING_REVIEW_DATABASE_GB: '0.000001', PARTITIONING_REVIEW_COLLECTION_GB: '0.000001' });
    owner = await registerUser(ctx, 'Partition Owner');
    support = await registerUser(ctx, 'Partition Support');
    await ctx.app.get(AdminService).grant(support.email, 'SUPPORT');
    await ctx.http().post('/v1/orgs').set(owner.auth).send({ name: 'Partition Traders', countryCode: 'IN', functionalCurrency: 'INR', fiscalYearStartMonth: 4 }).expect(201);
  }, 60_000);
  afterAll(async () => {
    await ctx?.app.close();
    await small?.app.close();
  });

  it('shows sizes, thresholds and readiness to the platform team only', async () => {
    await ctx.http().get('/v1/admin/system/partitioning').set(owner.auth).expect(403);
    const p = (await ctx.http().get('/v1/admin/system/partitioning').set(support.auth).expect(200)).body;
    expect(p.shardKey).toEqual({ orgId: 1 });
    expect(p.databaseBytes).toBeGreaterThan(0);
    expect(p.thresholds).toEqual({ databaseBytes: 2048 * 1024 ** 3, collectionBytes: 512 * 1024 ** 3 });
    expect(p.advice).toMatchObject({ justified: false, reasons: [] });
    expect(p.advice.databaseShare).toBeLessThan(0.01);
    expect(p.largest.length).toBe(10);
    const largest = p.largest as { bytes: number }[];
    for (let i = 1; i < largest.length; i++) expect(largest[i - 1].bytes).toBeGreaterThanOrEqual(largest[i].bytes);
    expect(p.readiness.counts).toEqual(shardReadiness(COLLECTIONS).counts);
    const portal = p.readiness.notReady.find((c: { name: string }) => c.name === 'auditor_portal_links');
    expect(portal).toMatchObject({ state: 'GLOBAL_LOOKUP', blockers: [{ key: ['tokenHash'], kind: 'GLOBAL_LOOKUP' }] });
    // Sizes only: no organisation's rows or names.
    expect(JSON.stringify(p)).not.toContain('Partition Traders');
    const h = (await ctx.http().get('/v1/admin/system').set(support.auth).expect(200)).body;
    expect(h.problems.some((x: string) => /review partitioning/.test(x))).toBe(false);
  });

  it('says partitioning is justified once the database passes the thresholds', async () => {
    const p = (await small.http().get('/v1/admin/system/partitioning').set(support.auth).expect(200)).body;
    expect(p.advice.justified).toBe(true);
    expect(p.advice.reasons[0]).toMatch(/^The database holds .* past the 0\.0 MB set for one replica set$/);
    expect(p.advice.reasons.length).toBeGreaterThan(1);
    const h = (await small.http().get('/v1/admin/system').set(support.auth).expect(200)).body;
    expect(h.status).toBe('DEGRADED');
    expect(h.problems).toContain('The database has reached 0 GB: review partitioning (see Database partitioning below)');
  });
});
