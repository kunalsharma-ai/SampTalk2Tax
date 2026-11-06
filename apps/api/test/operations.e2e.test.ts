import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../src/admin/admin.service';
import { FlagsService } from '../src/operations/flags.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/** Operations (M9 slice 6) against the real API and database: errors, health, flags, maintenance. */
let ctx: Ctx;
let owner: TestUser;
let admin: TestUser;
let support: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;

const journal = (who: TestUser = owner) =>
  ctx.http().post(`${org.base}/journals`).set(who.auth).send({ date: today(), memo: 'Ops test', lines: [{ accountId: org.acc['1120'], debit: '5' }, { accountId: org.acc['4100'], credit: '5' }] });

beforeAll(async () => {
  ctx = await bootApp();
  // The error this suite causes on purpose starts from nothing on each run.
  await ctx.prisma.errorGroup.deleteMany({ where: { route: '/v1/orgs/:id/flags' } });
  owner = await registerUser(ctx, 'Ops Owner');
  admin = await registerUser(ctx, 'Ops Admin');
  support = await registerUser(ctx, 'Ops Support');
  await ctx.app.get(AdminService).grant(admin.email, 'SUPER_ADMIN');
  await ctx.app.get(AdminService).grant(support.email, 'SUPPORT');
  org = await createOrg(ctx, owner, { name: 'Ops Traders Pvt Ltd' });
  other = await createOrg(ctx, owner, { name: 'Ops Other Pvt Ltd' });
});
afterAll(async () => {
  // Leave the platform as other suites expect it: no maintenance, flags at their defaults.
  const open = await ctx.prisma.maintenanceWindow.findFirst({ where: { endedAt: null } });
  if (open) await ctx.prisma.maintenanceWindow.update({ where: { id: open.id }, data: { endedAt: new Date(), endedBy: admin.id } });
  await ctx.prisma.featureFlagOverride.deleteMany({ where: { orgId: { in: [org.orgId, other.orgId] } } });
  await ctx.prisma.featureFlag.deleteMany({});
  await ctx.app.close();
});

describe('request ids and error tracking', () => {
  it('gives every request an id, keeping a sensible incoming one', async () => {
    const r = await ctx.http().get('/health').expect(200);
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect((await ctx.http().get('/health').set('X-Request-Id', 'web-req-12345678').expect(200)).headers['x-request-id']).toBe('web-req-12345678');
    expect((await ctx.http().get('/health').set('X-Request-Id', 'bad id!').expect(200)).headers['x-request-id']).not.toBe('bad id!');
    const refused = await ctx.http().get(`${org.base}/journals/not-a-uuid`).set(owner.auth);
    expect(refused.body.requestId).toBe(refused.headers['x-request-id']);
  });

  it('keeps unexpected server errors grouped, findable by reference, and reopens a resolved group', async () => {
    const flags = ctx.app.get(FlagsService);
    const original = flags.forOrg.bind(flags);
    flags.forOrg = async () => {
      throw new TypeError('Cannot read properties of undefined (reading "x")');
    };
    try {
      const a = await ctx.http().get(`${org.base}/flags`).set(owner.auth).expect(500);
      expect(a.body).toMatchObject({ error: 'INTERNAL', message: 'Unexpected server error' });
      expect(a.body.message).not.toContain('undefined');
      await ctx.http().get(`${other.base}/flags`).set(owner.auth).expect(500);
      await new Promise((r) => setTimeout(r, 300));
      const found = (await ctx.http().get(`/v1/admin/errors/requests/${a.body.requestId}`).set(support.auth).expect(200)).body;
      expect(found).toMatchObject({ name: 'TypeError', method: 'GET', route: '/v1/orgs/:id/flags', occurrences: 2, resolvedAt: null });
      expect(found.frame).toContain('operations.e2e.test');
      expect(found.events.map((e: { orgId: string }) => e.orgId).sort()).toEqual([org.orgId, other.orgId].sort());
      expect(found.events[0].path).toBe('/v1/orgs/:id/flags');
      const list = (await ctx.http().get('/v1/admin/errors').set(support.auth).expect(200)).body;
      expect(list.groups.find((g: { id: string }) => g.id === found.id)).toMatchObject({ occurrences: 2, last24h: 2 });

      // Support can read errors but not resolve them; owners cannot see them at all.
      await ctx.http().put(`/v1/admin/errors/${found.id}/resolved`).set(support.auth).send({ resolved: true }).expect(403);
      await ctx.http().get('/v1/admin/errors').set(owner.auth).expect(403);
      expect((await ctx.http().put(`/v1/admin/errors/${found.id}/resolved`).set(admin.auth).send({ resolved: true }).expect(200)).body).toMatchObject({ resolvedBy: 'Ops Admin' });
      await ctx.http().get(`${org.base}/flags`).set(owner.auth).expect(500);
      await new Promise((r) => setTimeout(r, 300));
      expect((await ctx.http().get(`/v1/admin/errors/${found.id}`).set(admin.auth).expect(200)).body).toMatchObject({ occurrences: 3, resolvedAt: null });
    } finally {
      flags.forOrg = original;
    }
    // Expected refusals are not errors.
    const before = await ctx.prisma.errorEvent.count();
    await ctx.http().get(`${org.base}/journals/00000000-0000-4000-8000-000000000000`).set(owner.auth).expect(404);
    expect(await ctx.prisma.errorEvent.count()).toBe(before);
  });
});

describe('system health', () => {
  it('measures the database, the runners and request timings, for platform staff only', async () => {
    await ctx.http().get('/v1/admin/system').set(owner.auth).expect(403);
    const h = (await ctx.http().get('/v1/admin/system').set(support.auth).expect(200)).body;
    expect(h.database).toMatchObject({ status: expect.stringMatching(/OK|SLOW/) });
    expect(h.database.latencyMs).toBeGreaterThanOrEqual(0);
    // The newest migration in the repository is the last one applied.
    expect(h.database.lastMigration.name).toBe(readdirSync(join(__dirname, '../../../packages/database/prisma/migrations')).filter((d) => /^\d{14}_/.test(d)).sort().at(-1));
    expect(h.runners.map((r: { name: string }) => r.name).sort()).toEqual(['Alert checks', 'Renewals and reminders', 'Workflow runner']);
    expect(h.runners.find((r: { name: string }) => r.name === 'Workflow runner').state).toBe('OFF');
    expect(h.requests.totals.requests).toBeGreaterThan(5);
    expect(h.requests.minutes).toHaveLength(15);
    const route = h.requests.routes.find((r: { route: string }) => r.route === 'GET /v1/orgs/:orgId/flags');
    expect(route).toMatchObject({ serverErrors: 3 });
    expect(route.p95Ms).toBeGreaterThanOrEqual(0);
    expect(h.status).toBe('DEGRADED');
    expect(h.problems.join(' ')).toMatch(/server error/);
  });
});

describe('feature flags', () => {
  it('are on by default, and a switched-off module is refused and hidden', async () => {
    expect((await ctx.http().get(`${org.base}/flags`).set(owner.auth).expect(200)).body).toEqual({ benchmarking: true, 'forecast-lab': true, 'disaster-simulation': true, opportunities: true });
    await ctx.http().get(`${org.base}/benchmarking`).set(owner.auth).expect(200);
    await ctx.http().put('/v1/admin/flags/benchmarking').set(support.auth).send({ enabled: false, rolloutPercent: 100 }).expect(403);
    await ctx.http().put('/v1/admin/flags/no-such-flag').set(admin.auth).send({ enabled: false, rolloutPercent: 100 }).expect(404);
    await ctx.http().put('/v1/admin/flags/benchmarking').set(admin.auth).send({ enabled: true, rolloutPercent: 101 }).expect(400);
    const off = (await ctx.http().put('/v1/admin/flags/benchmarking').set(admin.auth).send({ enabled: false, rolloutPercent: 100, note: 'Peer data being rebuilt' }).expect(200)).body;
    expect(off).toMatchObject({ setting: { enabled: false, note: 'Peer data being rebuilt', updatedBy: 'Ops Admin' }, organisations: { on: 0 } });
    expect((await ctx.http().get(`${org.base}/flags`).set(owner.auth).expect(200)).body.benchmarking).toBe(false);
    expect((await ctx.http().get(`${org.base}/benchmarking`).set(owner.auth).expect(403)).body).toMatchObject({ error: 'FEATURE_OFF', flag: 'benchmarking' });
    // Other modules are untouched.
    await ctx.http().get(`${org.base}/forecast-lab`).set(owner.auth).expect((r) => expect(r.status).not.toBe(403));
  });

  it('can be set for one organisation, which wins over the flag', async () => {
    await ctx.http().put(`/v1/admin/flags/benchmarking/organisations/${org.orgId}`).set(admin.auth).send({ enabled: true, reason: '' }).expect(400);
    const f = (await ctx.http().put(`/v1/admin/flags/benchmarking/organisations/${org.orgId}`).set(admin.auth).send({ enabled: true, reason: 'Pilot customer' }).expect(200)).body;
    expect(f.overrides).toEqual([expect.objectContaining({ orgId: org.orgId, orgName: 'Ops Traders Pvt Ltd', enabled: true, reason: 'Pilot customer' })]);
    await ctx.http().get(`${org.base}/benchmarking`).set(owner.auth).expect(200);
    await ctx.http().get(`${other.base}/benchmarking`).set(owner.auth).expect(403);
    // Kept in the organisation's own audit trail.
    const audit = (await ctx.http().get(`${org.base}/audit-events`).set(owner.auth).expect(200)).body;
    expect(JSON.stringify(audit)).toContain('platform.flag_override_set');
    await ctx.http().delete(`/v1/admin/flags/benchmarking/organisations/${org.orgId}`).set(admin.auth).expect(200);
    await ctx.http().get(`${org.base}/benchmarking`).set(owner.auth).expect(403);
  });

  it('roll out to a stable share and go back to their default', async () => {
    await ctx.http().put('/v1/admin/flags/benchmarking').set(admin.auth).send({ enabled: true, rolloutPercent: 0 }).expect(200);
    await ctx.http().get(`${org.base}/benchmarking`).set(owner.auth).expect(403);
    const all = (await ctx.http().put('/v1/admin/flags/benchmarking').set(admin.auth).send({ enabled: true, rolloutPercent: 100 }).expect(200)).body;
    expect(all.organisations.on).toBe(all.organisations.total);
    await ctx.http().get(`${org.base}/benchmarking`).set(owner.auth).expect(200);
    const reset = (await ctx.http().delete('/v1/admin/flags/benchmarking').set(admin.auth).expect(200)).body;
    expect(reset.setting).toBeNull();
  });
});

describe('maintenance', () => {
  it('announces a scheduled window without pausing anything', async () => {
    await ctx.http().post('/v1/admin/maintenance').set(support.auth).send({ message: 'Database upgrade.' }).expect(403);
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const w = (await ctx.http().post('/v1/admin/maintenance').set(admin.auth).send({ message: 'Database upgrade.', startsAt: at }).expect(201)).body;
    expect(w.state).toBe('SCHEDULED');
    expect((await ctx.http().get('/v1/status').expect(200)).body.maintenance).toMatchObject({ state: 'SCHEDULED', message: 'Database upgrade.' });
    await journal().expect(201);
    await ctx.http().post('/v1/admin/maintenance').set(admin.auth).send({ message: 'Another' }).expect(409);
    await ctx.http().post(`/v1/admin/maintenance/${w.id}/end`).set(admin.auth).expect(201);
    expect((await ctx.http().get('/v1/status').expect(200)).body.maintenance).toBeNull();
  });

  it('pauses changes for everyone but platform staff while in progress, and reading keeps working', async () => {
    await ctx.http().post('/v1/admin/maintenance').set(admin.auth).send({ message: 'x', startsAt: new Date(Date.now() - 3_600_000).toISOString() }).expect(400);
    const w = (await ctx.http().post('/v1/admin/maintenance').set(admin.auth).send({ message: 'We are upgrading the database.', expectedEndAt: new Date(Date.now() + 1_800_000).toISOString() }).expect(201)).body;
    expect(w.state).toBe('IN_PROGRESS');
    const refused = await journal().expect(503);
    expect(refused.body).toMatchObject({ error: 'MAINTENANCE' });
    expect(refused.body.message).toContain('We are upgrading the database.');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(60);
    await ctx.http().get(`${org.base}/journals`).set(owner.auth).expect(200);
    // Signing in, and the person's own account, keep working.
    await ctx.http().post('/v1/auth/refresh').send({ refreshToken: owner.refreshToken }).expect((r) => expect(r.status).not.toBe(503));
    // Platform staff can still make changes (here, to end the maintenance).
    await ctx.http().get('/v1/admin/system').set(admin.auth).expect(200).expect((r) => expect(r.body.maintenance).toMatchObject({ state: 'IN_PROGRESS' }));
    const list = (await ctx.http().get('/v1/admin/maintenance').set(support.auth).expect(200)).body;
    expect(list[0]).toMatchObject({ id: w.id, state: 'IN_PROGRESS', createdBy: 'Ops Admin' });
    await ctx.http().post(`/v1/admin/maintenance/${w.id}/end`).set(admin.auth).expect(201);
    await ctx.http().post(`/v1/admin/maintenance/${w.id}/end`).set(admin.auth).expect(409);
    await journal().expect(201);
  });
});
