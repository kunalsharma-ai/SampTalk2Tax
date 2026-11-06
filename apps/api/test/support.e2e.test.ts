import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSmtpStandIn, type SmtpStandIn } from '../../../test-support/smtp-stand-in.mjs';
import { AdminService } from '../src/admin/admin.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/** Support tickets and controlled support access (M9 slice 4), against the real API and database. */
let ctx: Ctx;
let smtp: SmtpStandIn;
let agent: TestUser;
let admin: TestUser;
let owner: TestUser;
let accountant: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let ticketId: string;

beforeAll(async () => {
  ctx = await bootApp();
  smtp = await startSmtpStandIn();
  agent = await registerUser(ctx, 'Support Agent');
  admin = await registerUser(ctx, 'Support Admin');
  owner = await registerUser(ctx, 'Ticket Owner');
  accountant = await registerUser(ctx, 'Ticket Accountant');
  outsider = await registerUser(ctx, 'No Role');
  const svc = ctx.app.get(AdminService);
  await svc.grant(agent.email, 'SUPPORT');
  await svc.grant(admin.email, 'SUPER_ADMIN');
  org = await createOrg(ctx, owner, { name: 'Helpdesk Traders Pvt Ltd' });
  other = await createOrg(ctx, owner, { name: 'Helpdesk Other Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: accountant.email, role: 'ACCOUNTANT' }).expect(201);
  await ctx.http().put(`${org.base}/integrations/email`).set(owner.auth).send({ host: '127.0.0.1', port: smtp.port, security: 'NONE', username: 'mailer@helpdesk.test', password: 'smtp-secret-pass', fromAddress: 'accounts@helpdesk.test', fromName: 'Helpdesk Traders', enabled: true }).expect(200);
});
afterAll(async () => {
  await ctx.app.close();
  await smtp?.close();
});

describe('tickets', () => {
  it('a member opens a ticket and sees only their own; owners see all', async () => {
    await ctx.http().post(`${org.base}/support/tickets`).set(accountant.auth).send({ subject: 'x', category: 'TAX', body: 'Help' }).expect(400);
    const t = (await ctx.http().post(`${org.base}/support/tickets`).set(accountant.auth).send({ subject: 'GSTR-3B does not match the ledger', category: 'TAX', priority: 'HIGH', body: 'The October return shows a different output tax figure.' }).expect(201)).body;
    ticketId = t.id;
    expect(t).toMatchObject({ status: 'OPEN', priority: 'HIGH', category: 'TAX', openedBy: { email: accountant.email } });
    expect(t.reference).toMatch(/^T-\d{6,}$/);
    expect(t.targets.firstResponse.state).toBe('RUNNING');
    expect(new Date(t.targets.firstResponse.dueAt).getTime() - new Date(t.createdAt).getTime()).toBe(4 * 3_600_000);
    expect(t.messages).toHaveLength(1);

    await ctx.http().post(`${org.base}/support/tickets`).set(owner.auth).send({ subject: 'Owner question about invoices', category: 'BILLING', body: 'Where is my invoice?' }).expect(201);
    expect((await ctx.http().get(`${org.base}/support/tickets`).set(accountant.auth).expect(200)).body).toHaveLength(1);
    expect((await ctx.http().get(`${org.base}/support/tickets`).set(owner.auth).expect(200)).body).toHaveLength(2);
    // Other organisations' members cannot see it, not even by id.
    await ctx.http().get(`${other.base}/support/tickets/${ticketId}`).set(owner.auth).expect(404);
    await ctx.http().get(`${org.base}/support/tickets/${ticketId}`).set(outsider.auth).expect(404);
  });

  it('support sees the queue, notes internally, replies by email and the customer answers', async () => {
    await ctx.http().get('/v1/admin/support/tickets').set(outsider.auth).expect(403);
    const q = (await ctx.http().get('/v1/admin/support/tickets?q=GSTR-3B').set(agent.auth).expect(200)).body;
    expect(q.tickets.map((t: { id: string }) => t.id)).toContain(ticketId);
    expect(q.tickets.find((t: { id: string }) => t.id === ticketId)).toMatchObject({ org: { name: 'Helpdesk Traders Pvt Ltd' }, supportAccessUntil: null, next: { state: 'RUNNING' } });

    const note = (await ctx.http().post(`/v1/admin/support/tickets/${ticketId}/messages`).set(agent.auth).send({ body: 'Probably the reverse-charge lines.', internal: true }).expect(201)).body;
    expect(note.emailed).toBeNull();
    expect(note.ticket).toMatchObject({ status: 'OPEN', firstResponseAt: null, assignee: { name: 'Support Agent' } });

    const sent = smtp.messages.length;
    const r = (await ctx.http().post(`/v1/admin/support/tickets/${ticketId}/messages`).set(agent.auth).send({ body: 'Could you let us look at the books for a day?' }).expect(201)).body;
    expect(r.ticket.status).toBe('PENDING');
    expect(r.ticket.firstResponseAt).not.toBeNull();
    expect(r.ticket.targets.firstResponse.state).toBe('MET');
    expect(r.emailed, JSON.stringify(r.emailed)).toMatchObject({ ok: true, to: accountant.email });
    expect(smtp.messages.length).toBe(sent + 1);
    expect(smtp.messages.at(-1)!.subject).toContain('GSTR-3B does not match the ledger');
    expect(smtp.messages.at(-1)!.text).not.toContain('reverse-charge');

    // The customer never sees the internal note, nor support's email address.
    const seen = (await ctx.http().get(`${org.base}/support/tickets/${ticketId}`).set(accountant.auth).expect(200)).body;
    expect(seen.messages.map((m: { body: string }) => m.body)).toEqual(['The October return shows a different output tax figure.', 'Could you let us look at the books for a day?']);
    expect(seen.messages[1].author).toEqual({ name: 'Support Agent' });
    const back = (await ctx.http().post(`${org.base}/support/tickets/${ticketId}/messages`).set(accountant.auth).send({ body: 'Sure, an owner will grant it.' }).expect(201)).body;
    expect(back.status).toBe('OPEN');
  });

  it('support assigns, re-prioritises and resolves; the customer reopens and then closes for good', async () => {
    await ctx.http().put(`/v1/admin/support/tickets/${ticketId}`).set(agent.auth).send({ assigneeId: outsider.id }).expect(422);
    const a = (await ctx.http().put(`/v1/admin/support/tickets/${ticketId}`).set(agent.auth).send({ assigneeId: admin.id, priority: 'URGENT' }).expect(200)).body;
    expect(a).toMatchObject({ priority: 'URGENT', assignee: { id: admin.id } });
    expect(a.staff.map((s: { email: string }) => s.email)).toEqual(expect.arrayContaining([agent.email, admin.email]));
    await ctx.http().put(`/v1/admin/support/tickets/${ticketId}`).set(agent.auth).send({ action: 'REOPEN' }).expect(409);
    expect((await ctx.http().put(`/v1/admin/support/tickets/${ticketId}`).set(agent.auth).send({ action: 'RESOLVE' }).expect(200)).body.status).toBe('RESOLVED');
    expect((await ctx.http().post(`${org.base}/support/tickets/${ticketId}/reopen`).set(accountant.auth).expect(200)).body.status).toBe('OPEN');
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityId: ticketId }, select: { action: true } });
    expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(['support.ticket_opened', 'support.ticket_updated', 'support.ticket_status']));
  });
});

describe('support access to the books', () => {
  it('is refused without a grant, and only owners and admins can grant it, for at most 72 hours', async () => {
    await ctx.http().get(`${org.base}/accounts`).set(agent.auth).expect(404);
    await ctx.http().post(`${org.base}/support/access`).set(accountant.auth).send({ hours: 24, reason: 'Look at GST' }).expect(403);
    await ctx.http().post(`${org.base}/support/access`).set(owner.auth).send({ hours: 73, reason: 'Look at GST' }).expect(400);
    const g = (await ctx.http().post(`${org.base}/support/access`).set(owner.auth).send({ hours: 24, reason: 'Check the October GST figures', ticketId }).expect(201)).body;
    expect(g.active).toMatchObject({ state: 'ACTIVE', ticketId, reason: 'Check the October GST figures' });
    await ctx.http().post(`${org.base}/support/access`).set(owner.auth).send({ hours: 2, reason: 'Again' }).expect(409);
    // The grant is said on the ticket.
    const t = (await ctx.http().get(`/v1/admin/support/tickets/${ticketId}`).set(agent.auth).expect(200)).body;
    expect(t.supportAccess).toMatchObject({ state: 'ACTIVE' });
    expect(t.messages.at(-1).body).toMatch(/^Granted support read-only access to the books for 24 hours/);
  });

  it('lets support read with viewer rights, never change anything, and logs every request', async () => {
    const o = (await ctx.http().get(org.base).set(agent.auth).expect(200)).body;
    expect(o).toMatchObject({ name: 'Helpdesk Traders Pvt Ltd', role: 'VIEWER' });
    expect(o.viaSupport.expiresAt).toBeTruthy();
    await ctx.http().get(`${org.base}/accounts`).set(agent.auth).expect(200);
    await ctx.http().get(`${org.base}/reports/trial-balance?asOf=2026-11-01`).set(agent.auth).expect(200);
    const write = await ctx.http().post(`${org.base}/journals`).set(agent.auth).send({}).expect(403);
    expect(write.body.error).toBe('SUPPORT_READ_ONLY');
    await ctx.http().post(`${org.base}/support/tickets`).set(agent.auth).send({ subject: 'Not as support', category: 'OTHER', body: 'x' }).expect(403);
    // Viewer rights: nothing beyond what a viewer may read (payroll, the audit log).
    await ctx.http().get(`${org.base}/audit-events`).set(agent.auth).expect(403);
    // A grant for one organisation opens no other.
    await ctx.http().get(`${other.base}/accounts`).set(agent.auth).expect(404);
    // People without a support role get nothing from the grant.
    await ctx.http().get(`${org.base}/accounts`).set(outsider.auth).expect(404);

    const access = (await ctx.http().get(`${org.base}/support/access`).set(owner.auth).expect(200)).body;
    const paths = access.views.map((v: { path: string; by: string }) => `${v.by} ${v.path}`);
    expect(paths).toEqual(expect.arrayContaining(['Support Agent /', 'Support Agent /accounts', 'Support Agent /reports/trial-balance?asOf=2026-11-01']));
    expect(paths.some((p: string) => p.includes('/journals'))).toBe(false);
  });

  it('ends when revoked, and the trail stays', async () => {
    const before = (await ctx.http().get(`${org.base}/support/access`).set(owner.auth).expect(200)).body;
    const r = (await ctx.http().post(`${org.base}/support/access/${before.active.id}/revoke`).set(owner.auth).expect(200)).body;
    expect(r.active).toBeNull();
    expect(r.grants[0]).toMatchObject({ state: 'REVOKED', revokedBy: 'Ticket Owner', grantedBy: 'Ticket Owner' });
    await ctx.http().post(`${org.base}/support/access/${before.active.id}/revoke`).set(owner.auth).expect(409);
    await ctx.http().get(`${org.base}/accounts`).set(agent.auth).expect(404);
    // The database keeps messages, grants and the access log as they were.
    await expect(ctx.prisma.supportAccessView.deleteMany({ where: { orgId: org.orgId } })).rejects.toThrow();
    await expect(ctx.prisma.supportMessage.updateMany({ where: { ticketId }, data: { body: 'changed' } })).rejects.toThrow();
    await expect(ctx.prisma.supportAccessGrant.update({ where: { id: before.active.id }, data: { reason: 'changed' } })).rejects.toThrow(/only be revoked/);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, action: { startsWith: 'support.access' } }, select: { action: true } });
    expect(audit.map((e) => e.action).sort()).toEqual(['support.access_granted', 'support.access_revoked']);
  });

  it('closed tickets are final', async () => {
    expect((await ctx.http().post(`${org.base}/support/tickets/${ticketId}/close`).set(accountant.auth).expect(200)).body.status).toBe('CLOSED');
    expect((await ctx.http().post(`${org.base}/support/tickets/${ticketId}/messages`).set(accountant.auth).send({ body: 'One more thing' }).expect(409)).body.error).toBe('TICKET_CLOSED');
    await ctx.http().post(`/v1/admin/support/tickets/${ticketId}/messages`).set(agent.auth).send({ body: 'Late reply' }).expect(409);
    const q = (await ctx.http().get('/v1/admin/support/tickets?status=CLOSED&q=GSTR-3B').set(agent.auth).expect(200)).body;
    expect(q.tickets.find((t: { id: string }) => t.id === ticketId).targets.resolution.state).toBe('MET');
  });
});
