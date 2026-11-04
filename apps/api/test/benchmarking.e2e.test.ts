import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BenchmarkingService } from '../src/benchmarking/benchmarking.service';
import { todayIst } from '../src/cash-flow/cash-flow.service';
import { PrismaService } from '../src/common/prisma.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Benchmarking against the real API and database: an organisation's own metrics from posted
 * journals; opting in with consent; the pseudonymous pool (no organisation id, only shared rounded
 * ratios, unreadable by tenants); suppression below five peers, median only below ten; live and
 * synthetic pools kept apart; refresh, withdrawal (contribution deleted) and rejoining under a new
 * key; permissions and the audit trail.
 */
let ctx: Ctx;
let prisma: PrismaService;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
type Org = Awaited<ReturnType<typeof createOrg>>;
let org: Org;
let other: Org;
const T = todayIst();
const shift = (ym: string, k: number) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + m - 1 + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const L = shift(T.slice(0, 7), -1);
const P = shift(L, -1);
const journal = (date: string, debit: string, credit: string, amount: string) =>
  ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date, post: true, memo: 'Benchmark test', lines: [{ accountId: org.acc[debit], debit: amount }, { accountId: org.acc[credit], credit: amount }] }).expect(201);
const join = { industry: 'RETAIL', sizeBand: 'SMALL', headcount: 4, metrics: ['GROSS_MARGIN', 'NET_MARGIN', 'REVENUE_PER_EMPLOYEE', 'DSO'], consent: true };
const pool = () => prisma.benchmarkContribution.findMany();
const peer = (metrics: Record<string, string>, over: Record<string, unknown> = {}) =>
  prisma.benchmarkContribution.create({ data: { participantKey: randomUUID(), period: L, industry: 'RETAIL', sizeBand: 'SMALL', countryCode: 'IN', currency: 'INR', isSynthetic: false, metrics, ...over } });
const get = async (who: TestUser = viewer, o: Org = org) => (await ctx.http().get(`${o.base}/benchmarking`).set(who.auth).expect(200)).body;
const cmp = (body: { comparison: { key: string }[] }, key: string) => body.comparison.find((c) => c.key === key) as Record<string, any>;

beforeAll(async () => {
  ctx = await bootApp();
  prisma = ctx.app.get(PrismaService);
  // The pool is platform-wide; start this file from an empty one.
  await prisma.benchmarkContribution.deleteMany();
  owner = await registerUser(ctx, 'Bench Owner');
  accountant = await registerUser(ctx, 'Bench Accountant');
  viewer = await registerUser(ctx, 'Bench Viewer');
  employee = await registerUser(ctx, 'Bench Employee');
  outsider = await registerUser(ctx, 'Bench Outsider');
  org = await createOrg(ctx, owner, { name: 'Benchmark Retail Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Bench Co' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  await journal(`${P}-10`, '1120', '3100', '500000.00');
  await journal(`${P}-15`, '1120', '4100', '200000.00');
  await journal(`${L}-15`, '1120', '4100', '300000.00');
  await journal(`${L}-16`, '5000', '1120', '120000.00');
  await journal(`${L}-17`, '6200', '1120', '30000.00');
});
afterAll(async () => {
  await prisma.benchmarkContribution.deleteMany();
  await ctx?.app.close();
});

describe('benchmarking', () => {
  it('shows an organisation its own metrics before it takes part, and nothing about others', async () => {
    const b = await get();
    expect(b.period.month).toBe(L);
    expect(b.pool).toBe('LIVE');
    expect(b.participation).toBeNull();
    expect(b.comparison).toBeNull();
    const v = Object.fromEntries(b.metrics.map((m: { key: string; value: string | null }) => [m.key, m.value]));
    expect(v).toMatchObject({ GROSS_MARGIN: '76.0', NET_MARGIN: '70.0', OPEX_RATIO: '6.0', DSO: '0', REVENUE_GROWTH: null, REVENUE_PER_EMPLOYEE: null, PROJECT_MARGIN: null });
    expect(b.metrics.find((m: { key: string }) => m.key === 'REVENUE_PER_EMPLOYEE').reason).toMatch(/Headcount not known/);
    expect(b.methodology).toMatchObject({ minPeers: 5, minPeersForQuartiles: 10, consentVersion: 1 });
    expect(b.methodology.definitions).toHaveLength(10);
  });

  it('only owners and admins decide what is shared, and consent is required', async () => {
    await ctx.http().get(`${org.base}/benchmarking`).set(employee.auth).expect(403);
    await ctx.http().get(`${org.base}/benchmarking`).set(outsider.auth).expect(404);
    for (const u of [accountant, viewer]) await ctx.http().put(`${org.base}/benchmarking/participation`).set(u.auth).send(join).expect(403);
    const noConsent = await ctx.http().put(`${org.base}/benchmarking/participation`).set(owner.auth).send({ ...join, consent: false }).expect(400);
    expect(JSON.stringify(noConsent.body)).toMatch(/Agree to the terms/);
    await ctx.http().put(`${org.base}/benchmarking/participation`).set(owner.auth).send({ ...join, metrics: [] }).expect(400);
    await ctx.http().put(`${org.base}/benchmarking/participation`).set(owner.auth).send({ ...join, industry: 'MINING' }).expect(400);
    await ctx.http().post(`${org.base}/benchmarking/participation/refresh`).set(owner.auth).expect(409);
    expect(await pool()).toHaveLength(0);
  });

  it('opts in: only the shared, rounded ratios go into a pool with no organisation id', async () => {
    const b = (await ctx.http().put(`${org.base}/benchmarking/participation`).set(owner.auth).send(join).expect(200)).body;
    expect(b.participation).toMatchObject({ status: 'OPTED_IN', industry: 'RETAIL', sizeBand: 'SMALL', headcount: 4, consentVersion: 1, contributedPeriod: L, sharedMetrics: ['GROSS_MARGIN', 'NET_MARGIN', 'DSO', 'REVENUE_PER_EMPLOYEE'] });
    expect(b.participation.participantKey).toBeUndefined();
    const rows = await pool();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ period: L, industry: 'RETAIL', sizeBand: 'SMALL', countryCode: 'IN', currency: 'INR', isSynthetic: false, metrics: { GROSS_MARGIN: '76.0', NET_MARGIN: '70.0', DSO: '0', REVENUE_PER_EMPLOYEE: '125000' } });
    expect(Object.keys(rows[0]!)).not.toContain('orgId');
    expect(JSON.stringify(rows[0])).not.toContain(org.orgId);
    const part = await prisma.benchmarkParticipation.findUniqueOrThrow({ where: { orgId: org.orgId } });
    expect(part.participantKey).toBe(rows[0]!.participantKey);
  });

  it('keeps the pool away from tenants', async () => {
    const seen = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('t2t.org_id', ${org.orgId}, true), set_config('t2t.bypass', '', true)`;
      return tx.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM benchmark_contributions`;
    });
    expect(seen[0]!.n).toBe(0);
    const write = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('t2t.org_id', ${org.orgId}, true), set_config('t2t.bypass', '', true)`;
      await tx.$executeRaw`INSERT INTO benchmark_contributions (id, participant_key, period, industry, size_band, country_code, currency, is_synthetic, metrics, updated_at) VALUES (gen_random_uuid(), gen_random_uuid(), ${L}, 'RETAIL', 'SMALL', 'IN', 'INR', false, '{}', now())`;
    });
    await expect(write).rejects.toThrow(/row-level security/);
    // Another organisation sees its own (empty) figures and no participation.
    const o = await get(outsider, other);
    expect(o.participation).toBeNull();
    expect(o.metrics.find((m: { key: string }) => m.key === 'GROSS_MARGIN').value).toBeNull();
  });

  it('suppresses groups under five, shows only the median under ten, and never one participant', async () => {
    let b = await get();
    expect(cmp(b, 'GROSS_MARGIN')).toMatchObject({ value: '76.0', group: null, aggregate: null, position: null, note: expect.stringMatching(/Fewer than 5 other participants/) });
    expect(cmp(b, 'OPEX_RATIO').note).toBe('You do not share this metric, so it is not compared.');

    for (const g of ['40.0', '50.0', '60.0', '70.0']) await peer({ GROSS_MARGIN: g, REVENUE_PER_EMPLOYEE: '300000' });
    await peer({ GROSS_MARGIN: '99.0' }, { isSynthetic: true }); // synthetic: never mixed with live organisations
    await peer({ GROSS_MARGIN: '10.0' }, { period: shift(L, -3) }); // too old
    b = await get();
    expect(cmp(b, 'GROSS_MARGIN').aggregate).toBeNull();

    await peer({ GROSS_MARGIN: '80.0', REVENUE_PER_EMPLOYEE: '500000' }, { countryCode: 'AE', currency: 'AED' });
    b = await get();
    const gm = cmp(b, 'GROSS_MARGIN');
    expect(gm.group).toEqual({ level: 'INDUSTRY_SIZE', label: 'Retail, 11 to 50 people, any country' });
    expect(gm.aggregate).toEqual({ peers: '5 to 9', median: '60.0', lowerQuartile: null, upperQuartile: null });
    expect(gm.position).toBe('ABOVE_MEDIAN');
    expect(gm.note).toMatch(/Retail, 11 to 50 people, IN/);
    // Revenue per employee compares only the four INR peers: suppressed.
    expect(cmp(b, 'REVENUE_PER_EMPLOYEE').aggregate).toBeNull();
    const out = JSON.stringify(b.comparison);
    for (const single of ['40.0', '80.0', '99.0', '10.0', '300000', '500000']) expect(out).not.toContain(single);

    for (const g of ['45.0', '55.0', '65.0', '75.0', '85.0', '90.0']) await peer({ GROSS_MARGIN: g });
    b = await get();
    expect(cmp(b, 'GROSS_MARGIN')).toMatchObject({ group: { level: 'INDUSTRY_SIZE_COUNTRY' }, aggregate: { peers: '10 to 24', median: '62.5', lowerQuartile: '51.2', upperQuartile: '73.8' }, position: 'TOP_QUARTER', note: null });
  });

  it('changes what is shared under the same key, refreshes, and catches up when the month moves on', async () => {
    const key = (await prisma.benchmarkParticipation.findUniqueOrThrow({ where: { orgId: org.orgId } })).participantKey;
    const b = (await ctx.http().put(`${org.base}/benchmarking/participation`).set(owner.auth).send({ ...join, metrics: ['GROSS_MARGIN'] }).expect(200)).body;
    expect(b.participation.sharedMetrics).toEqual(['GROSS_MARGIN']);
    const mine = await prisma.benchmarkContribution.findUniqueOrThrow({ where: { participantKey: key! } });
    expect(mine.metrics).toEqual({ GROSS_MARGIN: '76.0' });
    expect(cmp(b, 'DSO').aggregate).toBeNull();

    await prisma.benchmarkParticipation.update({ where: { orgId: org.orgId }, data: { contributedPeriod: shift(L, -1) } });
    await prisma.benchmarkContribution.update({ where: { participantKey: key! }, data: { period: shift(L, -1) } });
    expect((await get()).participation.contributedPeriod).toBe(L);
    expect((await prisma.benchmarkContribution.findUniqueOrThrow({ where: { participantKey: key! } })).period).toBe(L);
    await ctx.http().post(`${org.base}/benchmarking/participation/refresh`).set(owner.auth).expect(200);
  });

  it('withdraws: the contribution is deleted, and rejoining uses a new key', async () => {
    const key = (await prisma.benchmarkParticipation.findUniqueOrThrow({ where: { orgId: org.orgId } })).participantKey!;
    const b = (await ctx.http().delete(`${org.base}/benchmarking/participation`).set(owner.auth).expect(200)).body;
    expect(b.participation).toMatchObject({ status: 'WITHDRAWN', contributedPeriod: null });
    expect(b.comparison).toBeNull();
    expect(await prisma.benchmarkContribution.count({ where: { participantKey: key } })).toBe(0);
    await ctx.http().delete(`${org.base}/benchmarking/participation`).set(owner.auth).expect(409);
    await ctx.http().put(`${org.base}/benchmarking/participation`).set(owner.auth).send(join).expect(200);
    const again = (await prisma.benchmarkParticipation.findUniqueOrThrow({ where: { orgId: org.orgId } })).participantKey!;
    expect(again).not.toBe(key);
    expect(await prisma.benchmarkContribution.count({ where: { participantKey: again } })).toBe(1);
  });

  it('compares demo organisations only with the synthetic pool', async () => {
    await prisma.organization.update({ where: { id: other.orgId }, data: { isDemo: true } });
    expect(await ctx.app.get(BenchmarkingService).seedSyntheticPeers(80, L)).toBe(80);
    const b = (await ctx.http().put(`${other.base}/benchmarking/participation`).set(outsider.auth).send({ ...join, industry: 'WHOLESALE', metrics: ['DSO', 'OPEX_RATIO'] }).expect(200)).body;
    expect(b.pool).toBe('SYNTHETIC');
    expect((await pool()).filter((r) => r.isSynthetic)).toHaveLength(81);
    // The live organisation still sees only live peers.
    expect(cmp(await get(), 'GROSS_MARGIN').aggregate.peers).toBe('10 to 24');
  });

  it('records every decision in the audit trail', async () => {
    const events = await prisma.auditEvent.findMany({ where: { orgId: org.orgId, action: { startsWith: 'benchmark.' } }, orderBy: { id: 'asc' } });
    expect(events.map((e) => e.action)).toEqual(['benchmark.opted_in', 'benchmark.updated', 'benchmark.refreshed', 'benchmark.withdrawn', 'benchmark.opted_in']);
    expect(events[0]!.data).toMatchObject({ industry: 'RETAIL', consentVersion: 1, metricsContributed: 4 });
    expect(events[3]!.data).toMatchObject({ contributionsDeleted: 1 });
  });
});
