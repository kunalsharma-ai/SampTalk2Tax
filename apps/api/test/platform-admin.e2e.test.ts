import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../src/admin/admin.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/** Platform administration, against the real API and database. */
let ctx: Ctx;
let admin: TestUser;
let support: TestUser;
let owner: TestUser;
let member: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;

beforeAll(async () => {
  ctx = await bootApp();
  admin = await registerUser(ctx, 'Platform Admin');
  support = await registerUser(ctx, 'Platform Support');
  owner = await registerUser(ctx, 'Tenant Owner');
  member = await registerUser(ctx, 'Tenant Member');
  // Only this suite's administrators exist on the test database (earlier runs leave theirs).
  await ctx.prisma.user.updateMany({ where: { platformRole: { not: null } }, data: { platformRole: null } });
  const svc = ctx.app.get(AdminService);
  await svc.grant(admin.email, 'SUPER_ADMIN');
  await svc.grant(support.email, 'SUPPORT');
  org = await createOrg(ctx, owner, { name: 'Admin Watch Traders' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: member.email, role: 'ACCOUNTANT' }).expect(201);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('who can open platform administration', () => {
  it('only people with a platform role, and support only reads', async () => {
    await ctx.http().get('/v1/admin/overview').set(owner.auth).expect(403);
    await ctx.http().get('/v1/admin/overview').expect(401);
    expect((await ctx.http().get('/v1/auth/me').set(admin.auth).expect(200)).body.user.platformRole).toBe('SUPER_ADMIN');
    expect((await ctx.http().get('/v1/auth/me').set(owner.auth).expect(200)).body.user.platformRole).toBeNull();
    const o = (await ctx.http().get('/v1/admin/overview').set(support.auth).expect(200)).body;
    expect(o.organisations.total).toBeGreaterThan(0);
    expect(o.administrators.map((a: { email: string }) => a.email).sort()).toEqual([admin.email, support.email].sort());
    await ctx.http().post(`/v1/admin/organisations/${org.orgId}/suspend`).set(support.auth).send({ reason: 'Support cannot do this' }).expect(403);
  });

  it("never opens an organisation's books: a platform role is not membership", async () => {
    await ctx.http().get(`${org.base}/accounts`).set(admin.auth).expect(404);
    await ctx.http().get(`${org.base}/journals`).set(admin.auth).expect(404);
    // The admin views carry metadata only: no amounts, accounts or documents.
    const detail = (await ctx.http().get(`/v1/admin/organisations/${org.orgId}`).set(admin.auth).expect(200)).body;
    expect(Object.keys(detail).sort()).toEqual(['countryCode', 'createdAt', 'dataRegion', 'functionalCurrency', 'history', 'id', 'isDemo', 'legalName', 'members', 'name', 'suspended']);
    expect(detail.members.map((m: { email: string; role: string }) => [m.email, m.role])).toEqual([[owner.email, 'OWNER'], [member.email, 'ACCOUNTANT']]);
  });
});

describe('organisations', () => {
  it('are found by name, owner email or id', async () => {
    const byName = (await ctx.http().get('/v1/admin/organisations?q=admin watch').set(support.auth).expect(200)).body;
    expect(byName.map((o: { id: string }) => o.id)).toContain(org.orgId);
    const byEmail = (await ctx.http().get(`/v1/admin/organisations?q=${encodeURIComponent(owner.email)}`).set(support.auth).expect(200)).body;
    expect(byEmail).toHaveLength(1);
    expect(byEmail[0]).toMatchObject({ id: org.orgId, members: 2, owners: [owner.email], suspended: null });
    expect((await ctx.http().get(`/v1/admin/organisations?q=${org.orgId}`).set(support.auth).expect(200)).body).toHaveLength(1);
  });

  it('can be suspended: readable and exportable by members, not changeable, and its members see why', async () => {
    await ctx.http().post(`/v1/admin/organisations/${org.orgId}/suspend`).set(admin.auth).send({ reason: 'no' }).expect(422);
    const s = (await ctx.http().post(`/v1/admin/organisations/${org.orgId}/suspend`).set(admin.auth).send({ reason: 'Payment overdue since October' }).expect(201)).body;
    expect(s.suspended.reason).toBe('Payment overdue since October');
    await ctx.http().post(`/v1/admin/organisations/${org.orgId}/suspend`).set(admin.auth).send({ reason: 'Payment overdue since October' }).expect(409);

    await ctx.http().get(`${org.base}/accounts`).set(member.auth).expect(200);
    await ctx.http().get(`${org.base}/reports/trial-balance?asOf=2026-11-01`).set(member.auth).expect(200);
    const refused = await ctx.http().post(`${org.base}/accounts`).set(owner.auth).send({ code: '9998', name: 'Blocked', type: 'EXPENSE' }).expect(423);
    expect(refused.body).toMatchObject({ error: 'ORG_SUSPENDED' });
    expect(refused.body.message).toMatch(/Payment overdue since October.*read and exported but not changed/);
    const mine = (await ctx.http().get('/v1/orgs').set(owner.auth).expect(200)).body.find((o: { id: string }) => o.id === org.orgId);
    expect(mine.suspended.reason).toBe('Payment overdue since October');
    // In the organisation's own audit trail.
    const audit = await ctx.prisma.auditEvent.findFirstOrThrow({ where: { orgId: org.orgId, action: 'platform.org_suspended' } });
    expect(audit.actorId).toBe(admin.id);

    await ctx.http().post(`/v1/admin/organisations/${org.orgId}/reinstate`).set(admin.auth).send({ note: 'Paid' }).expect(201);
    await ctx.http().post(`${org.base}/accounts`).set(owner.auth).send({ code: '9998', name: 'Allowed again', type: 'EXPENSE' }).expect(201);
    await ctx.http().post(`/v1/admin/organisations/${org.orgId}/reinstate`).set(admin.auth).send({}).expect(409);
    const detail = (await ctx.http().get(`/v1/admin/organisations/${org.orgId}`).set(support.auth).expect(200)).body;
    expect(detail.history.map((h: { action: string; by: string }) => [h.action, h.by])).toEqual([
      ['platform.org_reinstated', 'Platform Admin'],
      ['platform.org_suspended', 'Platform Admin'],
    ]);
  });
});

describe('people', () => {
  it('lists people with their organisations and last sign-in', async () => {
    const list = (await ctx.http().get(`/v1/admin/people?q=${encodeURIComponent(member.email)}`).set(support.auth).expect(200)).body;
    expect(list).toEqual([expect.objectContaining({ id: member.id, active: true, platformRole: null, organisations: 1, openSessions: 1, lastSeenAt: expect.any(String) })]);
  });

  it('can be signed out everywhere, disabled and enabled', async () => {
    const extra = await registerUser(ctx, 'Disable Me');
    expect((await ctx.http().post(`/v1/admin/people/${extra.id}/sign-out`).set(admin.auth).expect(201)).body.sessionsEnded).toBe(1);
    await ctx.http().get('/v1/auth/me').set(extra.auth).expect(401);

    await ctx.http().post(`/v1/admin/people/${member.id}/disable`).set(admin.auth).send({ reason: 'x' }).expect(422);
    await ctx.http().post(`/v1/admin/people/${admin.id}/disable`).set(admin.auth).send({ reason: 'Trying myself' }).expect(409);
    const d = (await ctx.http().post(`/v1/admin/people/${member.id}/disable`).set(admin.auth).send({ reason: 'Reported compromised account' }).expect(201)).body;
    expect(d).toEqual({ userId: member.id, active: false, sessionsEnded: 1 });
    await ctx.http().get(`${org.base}/accounts`).set(member.auth).expect(401);
    const memberEmail = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: member.id } })).email;
    await ctx.http().post('/v1/auth/login').send({ email: memberEmail, password: 'a-very-long-test-password' }).expect(401);

    await ctx.http().post(`/v1/admin/people/${member.id}/enable`).set(admin.auth).expect(201);
    await ctx.http().post('/v1/auth/login').send({ email: memberEmail, password: 'a-very-long-test-password' }).expect(200);
    const actions = (await ctx.prisma.auditEvent.findMany({ where: { entityId: member.id, action: { startsWith: 'platform.user_' } }, orderBy: { createdAt: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(['platform.user_disabled', 'platform.user_enabled']);
  });

  it('gets and loses platform roles, keeping at least one super admin', async () => {
    await ctx.http().put(`/v1/admin/people/${owner.id}/platform-role`).set(support.auth).send({ platformRole: 'SUPPORT' }).expect(403);
    await ctx.http().put(`/v1/admin/people/${admin.id}/platform-role`).set(admin.auth).send({ platformRole: null }).expect(409);
    await ctx.http().put(`/v1/admin/people/${owner.id}/platform-role`).set(admin.auth).send({ platformRole: 'SUPER_ADMIN' }).expect(200);
    // With a second super admin, the first may step down.
    await ctx.http().put(`/v1/admin/people/${admin.id}/platform-role`).set(admin.auth).send({ platformRole: 'SUPPORT' }).expect(200);
    await ctx.http().post(`/v1/admin/organisations/${org.orgId}/suspend`).set(admin.auth).send({ reason: 'No longer allowed' }).expect(403);
    await ctx.http().put(`/v1/admin/people/${owner.id}/platform-role`).set(owner.auth).send({ platformRole: null }).expect(409);
    await ctx.http().put(`/v1/admin/people/${admin.id}/platform-role`).set(owner.auth).send({ platformRole: 'SUPER_ADMIN' }).expect(200);
    await ctx.http().put(`/v1/admin/people/${owner.id}/platform-role`).set(admin.auth).send({ platformRole: null }).expect(200);
    await ctx.http().put(`/v1/admin/people/${owner.id}/platform-role`).set(admin.auth).send({ platformRole: 'OWNER' }).expect(400);
  });
});

describe('announcements', () => {
  it('are shown to everyone signed in while current, and can be withdrawn', async () => {
    const now = Date.now();
    await ctx.http().post('/v1/admin/announcements').set(admin.auth).send({ message: 'Ended', endsAt: new Date(now - 1000).toISOString() }).expect(422);
    const showing = (await ctx.http().post('/v1/admin/announcements').set(admin.auth).send({ message: 'Maintenance on Sunday 02:00-03:00 IST', tone: 'WARNING' }).expect(201)).body;
    const later = (await ctx.http().post('/v1/admin/announcements').set(admin.auth).send({ message: 'Next week', startsAt: new Date(now + 7 * 86_400_000).toISOString() }).expect(201)).body;
    const current = (await ctx.http().get('/v1/announcements').set(owner.auth).expect(200)).body as { id: string }[];
    expect(current.map((a) => a.id)).toContain(showing.id);
    expect(current.map((a) => a.id)).not.toContain(later.id);
    const all = (await ctx.http().get('/v1/admin/announcements').set(support.auth).expect(200)).body as { id: string; state: string }[];
    expect(all.find((a) => a.id === later.id)?.state).toBe('SCHEDULED');
    await ctx.http().post(`/v1/admin/announcements/${showing.id}/withdraw`).set(admin.auth).expect(201);
    await ctx.http().post(`/v1/admin/announcements/${showing.id}/withdraw`).set(admin.auth).expect(409);
    expect(((await ctx.http().get('/v1/announcements').set(owner.auth).expect(200)).body as { id: string }[]).map((a) => a.id)).not.toContain(showing.id);
    await ctx.http().post(`/v1/admin/announcements/${later.id}/withdraw`).set(admin.auth).expect(201);
  });
});
