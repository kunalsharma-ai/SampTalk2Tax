import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await bootApp();
});
afterAll(async () => {
  await ctx.app.close();
});

const PASSWORD = 'a-very-long-test-password';
async function userWithEmail(email: string, name = 'Invitee'): Promise<TestUser> {
  const res = await ctx.http().post('/v1/auth/register').send({ email, name, password: PASSWORD }).expect(201);
  return { id: res.body.user.id, email, token: res.body.accessToken, refreshToken: res.body.refreshToken, auth: { Authorization: `Bearer ${res.body.accessToken}` } };
}
const fresh = () => `invitee-${crypto.randomUUID()}@example.test`;

describe('invitations', () => {
  it('an owner invites by email; the invitee previews and accepts and gets the role', async () => {
    const owner = await registerUser(ctx, 'Owner');
    const { base, orgId } = await createOrg(ctx, owner, { name: 'Invite Co' });
    const email = fresh();
    const res = await ctx.http().post(`${base}/invitations`).set(owner.auth).send({ email: email.toUpperCase(), role: 'ACCOUNTANT' }).expect(201);
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.invitation).toMatchObject({ email, role: 'ACCOUNTANT', status: 'PENDING' });
    const stored = await ctx.prisma.invitation.findUniqueOrThrow({ where: { id: res.body.invitation.id } });
    expect(stored.tokenHash).not.toContain(res.body.token);

    // The invitee may register only after the invitation was sent.
    const invitee = await userWithEmail(email);
    const preview = await ctx.http().get(`/v1/invitations/${res.body.token}`).set(invitee.auth).expect(200);
    expect(preview.body).toMatchObject({ organization: { id: orgId, name: 'Invite Co' }, role: 'ACCOUNTANT', invitedBy: 'Owner', status: 'PENDING', forYou: true, alreadyMember: false });

    await ctx.http().get(`${base}/accounts`).set(invitee.auth).expect(404);
    const accepted = await ctx.http().post(`/v1/invitations/${res.body.token}/accept`).set(invitee.auth).expect(200);
    expect(accepted.body).toEqual({ orgId, role: 'ACCOUNTANT' });
    await ctx.http().get(`${base}/accounts`).set(invitee.auth).expect(200);
    // Accountants cannot manage members.
    await ctx.http().post(`${base}/invitations`).set(invitee.auth).send({ email: fresh(), role: 'VIEWER' }).expect(403);

    // The link works once.
    expect((await ctx.http().post(`/v1/invitations/${res.body.token}/accept`).set(invitee.auth).expect(410)).body.error).toBe('INVITE_ACCEPTED');
    const list = (await ctx.http().get(`${base}/invitations`).set(owner.auth).expect(200)).body;
    expect(list[0]).toMatchObject({ email, status: 'ACCEPTED', invitedBy: 'Owner' });
    expect(await ctx.prisma.auditEvent.findFirst({ where: { orgId, action: 'invitation.accepted' } })).toBeTruthy();
  });

  it('only the invited email can accept, and forwarding the link does not help', async () => {
    const owner = await registerUser(ctx);
    const { base } = await createOrg(ctx, owner);
    const res = await ctx.http().post(`${base}/invitations`).set(owner.auth).send({ email: fresh(), role: 'VIEWER' }).expect(201);
    const stranger = await registerUser(ctx, 'Stranger');
    const preview = await ctx.http().get(`/v1/invitations/${res.body.token}`).set(stranger.auth).expect(200);
    expect(preview.body.forYou).toBe(false);
    expect((await ctx.http().post(`/v1/invitations/${res.body.token}/accept`).set(stranger.auth).expect(403)).body.error).toBe('INVITE_OTHER_EMAIL');
    await ctx.http().get(`${base}/accounts`).set(stranger.auth).expect(404);
  });

  it('unknown, malformed, revoked and expired links are refused', async () => {
    const owner = await registerUser(ctx);
    const { base } = await createOrg(ctx, owner);
    const u = await registerUser(ctx);
    await ctx.http().get('/v1/invitations/not-a-token').set(u.auth).expect(404);
    await ctx.http().post(`/v1/invitations/${'x'.repeat(43)}/accept`).set(u.auth).expect(404);

    const email = fresh();
    const invitee = await userWithEmail(email);
    const a = await ctx.http().post(`${base}/invitations`).set(owner.auth).send({ email, role: 'VIEWER' }).expect(201);
    await ctx.http().post(`${base}/invitations/${a.body.invitation.id}/revoke`).set(owner.auth).expect(200);
    expect((await ctx.http().post(`/v1/invitations/${a.body.token}/accept`).set(invitee.auth).expect(410)).body.error).toBe('INVITE_REVOKED');

    const b = await ctx.http().post(`${base}/invitations`).set(owner.auth).send({ email, role: 'VIEWER' }).expect(201);
    await ctx.prisma.$executeRaw`UPDATE invitations SET expires_at = created_at + interval '1 millisecond' WHERE id = ${b.body.invitation.id}::uuid`;
    const row = await ctx.prisma.invitation.findUniqueOrThrow({ where: { id: b.body.invitation.id } });
    expect(row.expiresAt.getTime()).toBeLessThan(Date.now());
    expect((await ctx.http().post(`/v1/invitations/${b.body.token}/accept`).set(invitee.auth).expect(410)).body.error).toBe('INVITE_EXPIRED');
    // A new invitation for the same email replaces the expired one.
    await ctx.http().post(`${base}/invitations`).set(owner.auth).send({ email, role: 'VIEWER' }).expect(201);
  });

  it('a new link replaces the old one; duplicates and existing members are refused', async () => {
    const owner = await registerUser(ctx);
    const { base } = await createOrg(ctx, owner);
    const email = fresh();
    const first = await ctx.http().post(`${base}/invitations`).set(owner.auth).send({ email, role: 'APPROVER' }).expect(201);
    expect((await ctx.http().post(`${base}/invitations`).set(owner.auth).send({ email, role: 'VIEWER' }).expect(409)).body.error).toBe('INVITE_EXISTS');
    const renewed = await ctx.http().post(`${base}/invitations/${first.body.invitation.id}/renew`).set(owner.auth).expect(200);
    expect(renewed.body.token).not.toBe(first.body.token);
    const invitee = await userWithEmail(email);
    await ctx.http().post(`/v1/invitations/${first.body.token}/accept`).set(invitee.auth).expect(404);
    await ctx.http().post(`/v1/invitations/${renewed.body.token}/accept`).set(invitee.auth).expect(200);
    expect((await ctx.http().post(`${base}/invitations`).set(owner.auth).send({ email, role: 'VIEWER' }).expect(409)).body.error).toBe('ALREADY_MEMBER');
    expect((await ctx.http().post(`${base}/invitations/${first.body.invitation.id}/revoke`).set(owner.auth).expect(409)).body.error).toBe('INVITE_CLOSED');
  });

  it('admins cannot invite owners; invitations stay inside their organisation', async () => {
    const owner = await registerUser(ctx);
    const { base, orgId } = await createOrg(ctx, owner);
    const adminEmail = fresh();
    const inv = await ctx.http().post(`${base}/invitations`).set(owner.auth).send({ email: adminEmail, role: 'ADMIN' }).expect(201);
    const admin = await userWithEmail(adminEmail, 'Admin');
    await ctx.http().post(`/v1/invitations/${inv.body.token}/accept`).set(admin.auth).expect(200);
    await ctx.http().post(`${base}/invitations`).set(admin.auth).send({ email: fresh(), role: 'OWNER' }).expect(403);
    await ctx.http().post(`${base}/invitations`).set(admin.auth).send({ email: fresh(), role: 'EMPLOYEE' }).expect(201);

    const other = await registerUser(ctx);
    const otherOrg = await createOrg(ctx, other);
    await ctx.http().get(`${otherOrg.base}/invitations`).set(owner.auth).expect(404);
    await ctx.http().post(`${otherOrg.base}/invitations/${inv.body.invitation.id}/revoke`).set(other.auth).expect(404);
    expect(await ctx.prisma.invitation.count({ where: { orgId } })).toBe(2);
  });

  it('the database keeps invitations as history', async () => {
    const owner = await registerUser(ctx);
    const { base } = await createOrg(ctx, owner);
    const inv = await ctx.http().post(`${base}/invitations`).set(owner.auth).send({ email: fresh(), role: 'VIEWER' }).expect(201);
    const id = inv.body.invitation.id;
    await expect(ctx.prisma.$executeRaw`DELETE FROM invitations WHERE id = ${id}::uuid`).rejects.toThrow(/cannot be deleted/);
    await expect(ctx.prisma.$executeRaw`UPDATE invitations SET role = 'OWNER' WHERE id = ${id}::uuid`).rejects.toThrow(/cannot change/);
    await ctx.http().post(`${base}/invitations/${id}/revoke`).set(owner.auth).expect(200);
    await expect(ctx.prisma.$executeRaw`UPDATE invitations SET revoked_at = NULL, revoked_by_id = NULL WHERE id = ${id}::uuid`).rejects.toThrow(/already revoked/);
  });
});

describe('member roles and removal', () => {
  async function team() {
    const owner = await registerUser(ctx, 'Owner');
    const org = await createOrg(ctx, owner);
    const join = async (role: string, name: string) => {
      const email = fresh();
      const inv = await ctx.http().post(`${org.base}/invitations`).set(owner.auth).send({ email, role }).expect(201);
      const u = await userWithEmail(email, name);
      await ctx.http().post(`/v1/invitations/${inv.body.token}/accept`).set(u.auth).expect(200);
      return u;
    };
    return { owner, ...org, admin: await join('ADMIN', 'Admin'), viewer: await join('VIEWER', 'Viewer') };
  }

  it('changes roles within what the actor may grant', async () => {
    const t = await team();
    await ctx.http().put(`${t.base}/members/${t.viewer.id}`).set(t.admin.auth).send({ role: 'ACCOUNTANT' }).expect(200);
    await ctx.http().get(`${t.base}/journals`).set(t.viewer.auth).expect(200);
    // An admin cannot promote to owner or change an owner.
    await ctx.http().put(`${t.base}/members/${t.viewer.id}`).set(t.admin.auth).send({ role: 'OWNER' }).expect(403);
    await ctx.http().put(`${t.base}/members/${t.owner.id}`).set(t.admin.auth).send({ role: 'VIEWER' }).expect(403);
    await ctx.http().put(`${t.base}/members/${t.admin.id}`).set(t.viewer.auth).send({ role: 'VIEWER' }).expect(403);
    const members = (await ctx.http().get(`${t.base}/members`).set(t.owner.auth).expect(200)).body as { userId: string; role: string }[];
    expect(members.find((m) => m.userId === t.viewer.id)?.role).toBe('ACCOUNTANT');
  });

  it('keeps at least one owner, in the service and in the database', async () => {
    const t = await team();
    expect((await ctx.http().put(`${t.base}/members/${t.owner.id}`).set(t.owner.auth).send({ role: 'ADMIN' }).expect(409)).body.error).toBe('LAST_OWNER');
    expect((await ctx.http().delete(`${t.base}/members/${t.owner.id}`).set(t.owner.auth).expect(409)).body.error).toBe('LAST_OWNER');
    await expect(ctx.prisma.$executeRaw`DELETE FROM memberships WHERE org_id = ${t.orgId}::uuid AND role = 'OWNER'`).rejects.toThrow(/at least one owner/);
    // With a second owner, the first can step down.
    await ctx.http().put(`${t.base}/members/${t.admin.id}`).set(t.owner.auth).send({ role: 'OWNER' }).expect(200);
    await ctx.http().put(`${t.base}/members/${t.owner.id}`).set(t.owner.auth).send({ role: 'ADMIN' }).expect(200);
  });

  it('removing a member ends their access to the organisation', async () => {
    const t = await team();
    await ctx.http().delete(`${t.base}/members/${t.viewer.id}`).set(t.admin.auth).expect(204);
    await ctx.http().get(`${t.base}/accounts`).set(t.viewer.auth).expect(404);
    await ctx.http().delete(`${t.base}/members/${t.viewer.id}`).set(t.admin.auth).expect(404);
    expect(await ctx.prisma.auditEvent.findFirst({ where: { orgId: t.orgId, action: 'member.removed' } })).toBeTruthy();
  });
});
