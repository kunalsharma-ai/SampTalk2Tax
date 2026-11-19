import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RetentionService } from '../src/retention/retention.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Data retention policies (SEC-020) against the real API and database: the records the law
 * requires are listed and never deleted; working data is kept until an owner or admin sets a
 * period; then old copilot conversations and finished CRM webhook deliveries are deleted (not
 * ones still in use), each run is recorded and audited, and other organisations are untouched.
 */
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let R: string;
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
let hookId: string;

const conversation = async (o: { orgId: string }, user: TestUser, daysAgo: number, pending = false) => {
  const id = randomUUID();
  await ctx.prisma.copilotConversation.create({ data: { id, orgId: o.orgId, userId: user.id, title: `Asked ${daysAgo} days ago`, model: 'claude-opus-5-5', toolsetVersion: 1, systemPrompt: 'x', createdAt: ago(daysAgo), updatedAt: ago(daysAgo) } });
  await ctx.prisma.copilotMessage.create({ data: { orgId: o.orgId, conversationId: id, seq: 1, role: 'USER', status: 'COMPLETE', text: 'What is our cash?' } });
  if (pending) await ctx.prisma.copilotMessage.create({ data: { orgId: o.orgId, conversationId: id, seq: 2, role: 'ASSISTANT', status: 'PENDING' } });
  return id;
};
const delivery = (status: string, daysAgo: number | null) =>
  ctx.prisma.crmWebhookDelivery.create({ data: { orgId: org.orgId, webhookId: hookId, eventId: null, event: 'ping', body: '', status, attempts: 1, createdAt: ago(daysAgo ?? 0), finishedAt: daysAgo === null ? null : ago(daysAgo), nextAttemptAt: status === 'PENDING' ? new Date(Date.now() + 3_600_000) : null } });

beforeAll(async () => {
  ctx = await bootApp({ WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'true' });
  owner = await registerUser(ctx, 'Retention Owner');
  accountant = await registerUser(ctx, 'Retention Accountant');
  outsider = await registerUser(ctx, 'Retention Outsider');
  org = await createOrg(ctx, owner, { name: 'Retention Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Retention Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: accountant.email, role: 'ACCOUNTANT' }).expect(201);
  R = `${org.base}/retention`;
  hookId = (await ctx.http().post(`${org.base}/crm-connection/webhooks`).set(owner.auth).send({ name: 'CRM', url: 'http://127.0.0.1:9/hook', events: ['deal.won'] }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('data retention', () => {
  it('lists the records the law requires, and keeps working data until a period is set', async () => {
    const o = (await ctx.http().get(R).set(accountant.auth).expect(200)).body;
    expect(o.canManage).toBe(false);
    expect(o.statutory.map((s: { basis: string }) => s.basis)).toContain('Companies Act, 2013, section 128(5)');
    expect(o.categories.map((c: { key: string; days: number | null }) => [c.key, c.days])).toEqual([
      ['COPILOT_CONVERSATIONS', null],
      ['CRM_WEBHOOK_DELIVERIES', null],
    ]);
    await ctx.http().get(R).set(outsider.auth).expect(404);
  });

  it('lets only owners and admins set a period, within limits', async () => {
    await ctx.http().put(R).set(accountant.auth).send({ category: 'COPILOT_CONVERSATIONS', days: 180 }).expect(403);
    expect((await ctx.http().put(R).set(owner.auth).send({ category: 'COPILOT_CONVERSATIONS', days: 30 }).expect(422)).body.message).toBe('Copilot conversations: the shortest period is 90 days');
    await ctx.http().put(R).set(owner.auth).send({ category: 'JOURNALS', days: 365 }).expect(422);
    const o = (await ctx.http().put(R).set(owner.auth).send({ category: 'COPILOT_CONVERSATIONS', days: 180 }).expect(200)).body;
    expect(o.categories[0]).toMatchObject({ key: 'COPILOT_CONVERSATIONS', days: 180 });
    await ctx.http().put(R).set(owner.auth).send({ category: 'CRM_WEBHOOK_DELIVERIES', days: 30 }).expect(200);
  });

  it('deletes only what is older than the period and not in use, here and nowhere else', async () => {
    const old = await conversation(org, owner, 200);
    const recent = await conversation(org, owner, 10);
    const busy = await conversation(org, owner, 200, true);
    const theirs = await conversation(other, outsider, 400);
    const oldDone = await delivery('SUCCEEDED', 40);
    const oldFailed = await delivery('FAILED', 31);
    const recentDone = await delivery('SUCCEEDED', 5);
    const retrying = await delivery('PENDING', null);

    await ctx.http().post(`${R}/run`).set(accountant.auth).expect(403);
    const o = (await ctx.http().post(`${R}/run`).set(owner.auth).expect(200)).body;
    expect(o.runs[0]).toMatchObject({ trigger: 'MANUAL', deleted: { COPILOT_CONVERSATIONS: 1, CRM_WEBHOOK_DELIVERIES: 2 } });

    const left = (await ctx.prisma.copilotConversation.findMany({ where: { id: { in: [old, recent, busy, theirs] } }, select: { id: true } })).map((c) => c.id).sort();
    expect(left).toEqual([recent, busy, theirs].sort());
    expect(await ctx.prisma.copilotMessage.count({ where: { conversationId: old } })).toBe(0);
    const deliveries = (await ctx.prisma.crmWebhookDelivery.findMany({ where: { id: { in: [oldDone.id, oldFailed.id, recentDone.id, retrying.id] } }, select: { id: true } })).map((d) => d.id).sort();
    expect(deliveries).toEqual([recentDone.id, retrying.id].sort());
  });

  it('runs on a schedule for organisations with a period, records it, and audits every change', async () => {
    await conversation(org, owner, 300);
    const r = await ctx.app.get(RetentionService).runAll();
    expect(r.organisations).toBeGreaterThanOrEqual(1);
    const o = (await ctx.http().get(R).set(owner.auth).expect(200)).body;
    expect(o.runs[0]).toMatchObject({ trigger: 'SCHEDULE', deleted: { COPILOT_CONVERSATIONS: 1, CRM_WEBHOOK_DELIVERIES: 0 } });
    // Turning a period off keeps the data from then on.
    const off = (await ctx.http().put(R).set(owner.auth).send({ category: 'CRM_WEBHOOK_DELIVERIES', days: null }).expect(200)).body;
    expect(off.categories[1].days).toBeNull();
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, action: { startsWith: 'retention.' } }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['retention.policy_changed', 'retention.policy_changed', 'retention.purged', 'retention.purged', 'retention.policy_changed']);
    expect(audit[4]!.data).toEqual({ category: 'CRM_WEBHOOK_DELIVERIES', from: 30, to: null });
    const run = await ctx.prisma.retentionRun.findFirstOrThrow({ where: { orgId: org.orgId } });
    await expect(ctx.prisma.retentionRun.update({ where: { id: run.id }, data: { trigger: 'MANUAL' } })).rejects.toThrow();
    await expect(ctx.prisma.retentionRun.delete({ where: { id: run.id } })).rejects.toThrow();
  });
});
