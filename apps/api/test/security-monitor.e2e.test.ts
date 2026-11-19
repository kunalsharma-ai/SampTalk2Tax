import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSmtpStandIn, type SmtpStandIn } from '../../../test-support/smtp-stand-in.mjs';
import { AdminService } from '../src/admin/admin.service';
import { AuditService } from '../src/audit/audit.service';
import { SecurityMonitorService } from '../src/security-monitor/security-monitor.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Security event monitoring (SEC-023) against the real API, database and a local SMTP stand-in:
 * the monitor reads the audit trail, opens one alert per finding (repeats add to it), emails
 * platform super admins about each new alert once, and platform admins review the events and
 * acknowledge alerts. Lockouts and role changes come from the real sign-in and admin code; the
 * other findings are written to the audit trail as the code that records them does.
 */
let ctx: Ctx;
let smtp: SmtpStandIn;
let admin: TestUser;
let support: TestUser;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
type Alert = { id: string; rule: string; severity: string; title: string; detail: string; organisation: string | null; person: string | null; count: number; status: string; acknowledgedBy: string | null; note: string | null; emailed: string | null };
type Report = { openAlerts: number; last24Hours: { HIGH: number; MEDIUM: number }; alerts: Alert[]; events: { action: string; severity: string; title: string; person: string | null; ip: string | null; organisation: string | null }[]; monitor: { lastRun: { alertsOpened: number } | null } };
const scan = async () => (await ctx.http().post('/v1/admin/security/scan').set(admin.auth).expect(200)).body as Report;
const record = (data: Parameters<AuditService['append']>[1]) => ctx.prisma.$transaction((tx) => ctx.app.get(AuditService).append(tx, data));

beforeAll(async () => {
  smtp = await startSmtpStandIn();
  ctx = await bootApp({ SMTP_URL: `smtp://127.0.0.1:${smtp.port}`, EMAIL_FROM: 'Talk2Tax <robot@talk2tax.test>', LOGIN_MAX_FAILURES: '1', SECURITY_LOCKOUT_ALERT_COUNT: '3', RATE_LIMIT_AUTH_PER_MINUTE: '1000' });
  admin = await registerUser(ctx, 'Security Admin');
  support = await registerUser(ctx, 'Security Support');
  owner = await registerUser(ctx, 'Security Owner');
  await ctx.app.get(AdminService).grant(admin.email, 'SUPER_ADMIN');
  await ctx.app.get(AdminService).grant(support.email, 'SUPPORT');
  org = await createOrg(ctx, owner, { name: 'Watched Closely Ltd' });
});
afterAll(async () => {
  await ctx?.app.close();
  await smtp?.close();
});

describe('security event monitoring', () => {
  it('opens an alert when many sign-ins are locked within an hour, and emails super admins', async () => {
    const people = [await registerUser(ctx, 'Locked One'), await registerUser(ctx, 'Locked Two'), await registerUser(ctx, 'Locked Three')];
    for (const p of people) await ctx.http().post('/v1/auth/login').set('X-Forwarded-For', '203.0.113.9').send({ email: p.email, password: 'not-the-password-at-all' });
    const r = await scan();
    const hour = new Date().toISOString().slice(0, 13);
    const lockouts = r.alerts.find((a) => a.rule === 'MANY_LOCKOUTS' && a.detail.includes(`on ${hour.slice(0, 10)}`) && a.detail.includes(`${hour.slice(11)}:00`));
    expect(lockouts).toMatchObject({ severity: 'HIGH', title: expect.stringMatching(/sign-ins locked in one hour$/) });
    expect(lockouts!.count).toBeGreaterThanOrEqual(3);
    const row = await ctx.prisma.securityAlert.findUniqueOrThrow({ where: { id: lockouts!.id } });
    const mine = await ctx.prisma.auditEvent.findMany({ where: { action: 'user.sign_in_locked', entityId: { in: people.map((p) => p.id) } } });
    expect(mine).toHaveLength(3);
    for (const e of mine) expect(row.eventIds).toContain(String(e.id));
    // The events are in the feed, with who and from where.
    expect(r.events.find((e) => e.action === 'user.sign_in_locked' && e.person?.startsWith('Locked One'))).toMatchObject({ severity: 'HIGH', title: 'Sign-in locked after failed passwords' });
  });

  it('alerts on a platform role change, emails each super admin once, and keeps one alert per finding', async () => {
    const before = smtp.messages.length;
    const helper = await registerUser(ctx, 'New Support Person');
    await ctx.app.get(AdminService).grant(helper.email, 'SUPPORT');
    const r = await scan();
    const alert = r.alerts.find((a) => a.rule === 'PLATFORM_ROLE_CHANGED' && a.person?.startsWith('New Support Person'))!;
    expect(alert).toMatchObject({ severity: 'HIGH', status: 'OPEN', detail: expect.stringMatching(/from none to SUPPORT/), emailed: expect.any(String) });
    const mail = smtp.messages.slice(before).filter((m) => m.subject === '[Talk2Tax security] High: Platform administrator role changed' && m.to.includes(admin.email.toLowerCase()));
    expect(mail.length).toBeGreaterThanOrEqual(1);
    expect(mail.find((m) => m.text.includes('from none to SUPPORT'))?.text).toMatch(/\/admin\/security/);
    // Support staff are not emailed.
    expect(smtp.messages.slice(before).some((m) => m.to.includes(support.email.toLowerCase()))).toBe(false);
    // Scanning again changes nothing and sends nothing.
    const sent = smtp.messages.length;
    await scan();
    expect(smtp.messages.length).toBe(sent);
    expect(await ctx.prisma.securityAlert.count({ where: { rule: 'PLATFORM_ROLE_CHANGED', userId: helper.id } })).toBe(1);
  });

  it('finds failed two-step codes, an infected upload, and an administrator turning two-step off', async () => {
    const victim = await registerUser(ctx, 'Code Victim');
    await record({ orgId: null, actorId: victim.id, action: 'user.mfa_challenge_failed', entityType: 'user', entityId: victim.id, data: { attempts: 5, ip: '198.51.100.7' } });
    await record({ orgId: org.orgId, actorId: owner.id, action: 'file.refused', entityType: 'file_scan', entityId: 'scan-1', data: { source: 'ATTACHMENT', fileName: 'invoice.pdf', result: 'INFECTED', detail: 'Eicar-Test-Signature' } });
    await record({ orgId: org.orgId, actorId: owner.id, action: 'file.refused', entityType: 'file_scan', entityId: 'scan-2', data: { source: 'ATTACHMENT', fileName: 'macro.pdf', result: 'ACTIVE_CONTENT' } });
    await record({ orgId: null, actorId: admin.id, action: 'user.mfa_disabled', entityType: 'user', entityId: admin.id, data: {} });
    await record({ orgId: null, actorId: owner.id, action: 'user.mfa_disabled', entityType: 'user', entityId: owner.id, data: {} });
    const r = await scan();
    expect(r.alerts.find((a) => a.rule === 'MFA_CODE_FAILURES' && a.person?.startsWith('Code Victim'))).toMatchObject({ severity: 'HIGH', count: 1 });
    expect(r.alerts.find((a) => a.rule === 'INFECTED_UPLOAD' && a.organisation === 'Watched Closely Ltd')).toMatchObject({ detail: 'invoice.pdf was refused: Eicar-Test-Signature. It was not kept.' });
    // A refused macro is an event, not an alert; turning two-step off is an alert only for platform admins.
    expect(r.alerts.filter((a) => a.organisation === 'Watched Closely Ltd')).toHaveLength(1);
    expect(r.alerts.filter((a) => a.rule === 'ADMIN_MFA_OFF' && a.person?.startsWith('Security Admin'))).toHaveLength(1);
    expect(r.alerts.filter((a) => a.rule === 'ADMIN_MFA_OFF' && a.person?.startsWith('Security Owner'))).toHaveLength(0);
    expect(r.events.find((e) => e.action === 'user.mfa_challenge_failed' && e.person?.startsWith('Code Victim'))?.ip).toBe('198.51.100.7');
    expect(r.last24Hours.HIGH).toBeGreaterThanOrEqual(6);
  });

  it('lets only super admins acknowledge, with a note; support staff can read', async () => {
    const r = (await ctx.http().get('/v1/admin/security?severity=HIGH').set(support.auth).expect(200)).body as Report;
    expect(r.events.every((e) => e.severity === 'HIGH')).toBe(true);
    await ctx.http().get('/v1/admin/security').set(owner.auth).expect(403);
    const alert = r.alerts.find((a) => a.rule === 'INFECTED_UPLOAD' && a.organisation === 'Watched Closely Ltd')!;
    await ctx.http().post(`/v1/admin/security/alerts/${alert.id}/acknowledge`).set(support.auth).send({ note: 'Looked at it' }).expect(403);
    await ctx.http().post(`/v1/admin/security/alerts/${alert.id}/acknowledge`).set(admin.auth).send({ note: 'ok' }).expect(400);
    const after = (await ctx.http().post(`/v1/admin/security/alerts/${alert.id}/acknowledge`).set(admin.auth).send({ note: 'Test file from the customer; nothing was kept.' }).expect(200)).body as Report;
    expect(after.alerts.find((a) => a.id === alert.id)).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedBy: expect.stringMatching(/^Security Admin/), note: 'Test file from the customer; nothing was kept.' });
    expect((await ctx.http().post(`/v1/admin/security/alerts/${alert.id}/acknowledge`).set(admin.auth).send({ note: 'Again, twice' }).expect(409)).body.error).toBe('ALERT_ALREADY_ACKNOWLEDGED');
    expect(await ctx.prisma.auditEvent.findFirst({ where: { action: 'security.alert_acknowledged', entityId: alert.id } })).toBeTruthy();
    // What was found is kept as found.
    await expect(ctx.prisma.securityAlert.update({ where: { id: alert.id }, data: { severity: 'MEDIUM' } })).rejects.toThrow();
    await expect(ctx.prisma.securityAlert.update({ where: { id: alert.id }, data: { status: 'OPEN' } })).rejects.toThrow();
    await expect(ctx.prisma.securityAlert.delete({ where: { id: alert.id } })).rejects.toThrow();
  });

  it('runs on its own schedule too', async () => {
    const run = await ctx.app.get(SecurityMonitorService).scan();
    expect(run).toMatchObject({ alertsOpened: 0, eventsRead: expect.any(Number) });
  });
});
