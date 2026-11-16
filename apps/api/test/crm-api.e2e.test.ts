import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantStorage } from '../src/common/tenant-context';
import { CrmWebhooksService } from '../src/crm-api/crm-webhooks.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * CRM slice 6 against the real API and database: API keys made in the app (shown once, hashed,
 * scoped, revoked), the CRM API used with a key (leads, deals, customers, idempotent creation by
 * external id, the key in the audit trail), and webhooks that send signed CRM events with retries.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let receiver: http.Server;
let hookUrl: string;
const received: { headers: http.IncomingHttpHeaders; body: string; json: any }[] = [];
const replies: number[] = [];
let readKey: string;
let writeKey: string;
let writeKeyId: string;
let customerId: string;

const api = (key: string) => ({
  get: (p: string) => ctx.http().get(`/v1/crm-api${p}`).set('authorization', `Bearer ${key}`),
  post: (p: string, b: object) => ctx.http().post(`/v1/crm-api${p}`).set('authorization', `Bearer ${key}`).send(b),
});
const tick = () => tenantStorage.run({}, () => ctx.app.get(CrmWebhooksService).tick());

beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (b: Buffer) => chunks.push(b));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({ headers: req.headers, body, json: JSON.parse(body) });
      const status = replies.shift() ?? 200;
      res.writeHead(status, { 'content-type': 'text/plain' }).end(status === 200 ? 'ok' : `nope ${status}`);
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/talk2tax`;
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Connector Owner');
  accountant = await registerUser(ctx, 'Connector Accountant');
  viewer = await registerUser(ctx, 'Connector Viewer');
  outsider = await registerUser(ctx, 'Connector Outsider');
  org = await createOrg(ctx, owner, { name: 'Connected Traders Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Connections Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: accountant.email, role: 'ACCOUNTANT' }).expect(201);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  customerId = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Asha Traders', isCustomer: true }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx.app.close();
  await new Promise<void>((r) => receiver.close(() => r()));
});

describe('API keys', () => {
  it('are made by people who manage the organisation, shown once and kept only as a hash', async () => {
    await ctx.http().post(`${org.base}/crm-connection/keys`).set(viewer.auth).send({ name: 'HubSpot', scopes: ['crm.read'] }).expect(403);
    await ctx.http().post(`${org.base}/crm-connection/keys`).set(owner.auth).send({ name: 'HubSpot', scopes: [] }).expect(400);
    const r = (await ctx.http().post(`${org.base}/crm-connection/keys`).set(owner.auth).send({ name: 'Website form', scopes: ['crm.read'] }).expect(201)).body;
    expect(r.key).toMatch(/^t2t_[a-z0-9]{8}_[A-Za-z0-9]{40}$/);
    expect(r).toMatchObject({ name: 'Website form', scopes: ['crm.read'], status: 'ACTIVE', createdBy: 'Connector Owner', lastUsedAt: null });
    readKey = r.key;
    const w = (await ctx.http().post(`${org.base}/crm-connection/keys`).set(owner.auth).send({ name: 'Sales CRM', scopes: ['crm.write', 'crm.read'] }).expect(201)).body;
    writeKey = w.key;
    writeKeyId = w.id;
    const list = (await ctx.http().get(`${org.base}/crm-connection/keys`).set(owner.auth).expect(200)).body;
    expect(list.keys).toHaveLength(2);
    expect(JSON.stringify(list)).not.toContain(readKey);
    const stored = await ctx.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
      return tx.$queryRawUnsafe<{ key_hash: string }[]>(`SELECT key_hash FROM api_keys WHERE id = '${r.id}'`);
    });
    expect(stored[0]!.key_hash).toHaveLength(64);
    expect(stored[0]!.key_hash).not.toContain(readKey.slice(13));
  });

  it('let another system read and write CRM records within their scopes', async () => {
    await ctx.http().get('/v1/crm-api/me').expect(401);
    await api('t2t_nothere1_' + 'x'.repeat(40)).get('/me').expect(401);
    await api(owner.auth.Authorization.slice(7) ?? 'nope').get('/me').expect(401);
    expect((await api(readKey).get('/me').expect(200)).body).toMatchObject({ organisationId: org.orgId, key: { scopes: ['crm.read'] }, actsAs: { name: 'Connector Owner', role: 'OWNER' } });
    await api(readKey).post('/leads', { name: 'Ravi Kumar', source: 'WEBSITE' }).expect(403);

    // Creating a lead twice with the same external id gives the same lead.
    const first = await api(writeKey).post('/leads', { name: 'Ravi Kumar', company: 'Kumar Foods', email: 'ravi@kumar.example', source: 'WEBSITE', externalRef: 'hs-1001' }).expect(201);
    const again = await api(writeKey).post('/leads', { name: 'Ravi K', source: 'WEBSITE', externalRef: 'hs-1001' }).expect(200);
    expect(again.body.id).toBe(first.body.id);
    expect(first.body).toMatchObject({ reference: 'LD-0001', externalRef: 'hs-1001', name: 'Ravi Kumar' });
    await api(writeKey).post('/leads', { name: 'No source' }).expect(400);

    await api(writeKey).post(`/leads/${first.body.id}/status`, { status: 'QUALIFIED' }).expect(201);
    const converted = (await api(writeKey).post(`/leads/${first.body.id}/convert`, { deal: { name: 'Cold store', amount: '250000.00', expectedCloseDate: T } }).expect(201)).body;
    expect(converted.status).toBe('CONVERTED');

    const deal = await api(writeKey).post('/deals', { name: 'Racking', contactId: customerId, amount: '90000.00', expectedCloseDate: T, externalRef: 'hs-deal-7' }).expect(201);
    await api(writeKey).post('/deals', { name: 'Racking', contactId: customerId, amount: '90000.00', expectedCloseDate: T, externalRef: 'hs-deal-7' }).expect(200);
    await api(writeKey).post(`/deals/${deal.body.id}/stage`, { stage: 'WON' }).expect(201);
    expect((await api(readKey).get(`/deals/${deal.body.id}`).expect(200)).body).toMatchObject({ stage: 'WON', externalRef: 'hs-deal-7' });
    expect((await api(readKey).get('/leads').expect(200)).body.leads.map((l: { name: string }) => l.name)).toEqual(['Ravi Kumar']);
    const customers = (await api(readKey).get('/customers').expect(200)).body;
    expect(customers.map((c: { name: string }) => c.name).sort()).toEqual(['Asha Traders', 'Kumar Foods']);

    // The audit trail names the key next to its creator.
    const ev = await ctx.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
      return tx.auditEvent.findFirst({ where: { orgId: org.orgId, action: 'crm.deal.won' } });
    });
    expect(ev?.data).toMatchObject({ viaApiKey: { id: writeKeyId } });

    // Keys never reach another organisation's records.
    await api(readKey).get(`/deals/${deal.body.id}`).expect(200);
    const outsiderKey = (await ctx.http().post(`${other.base}/crm-connection/keys`).set(outsider.auth).send({ name: 'Other', scopes: ['crm.read'] }).expect(201)).body.key;
    await api(outsiderKey).get(`/deals/${deal.body.id}`).expect(404);
    expect((await api(outsiderKey).get('/leads').expect(200)).body.leads).toEqual([]);
  });

  it('stop working when revoked, or when their creator loses the role or leaves', async () => {
    // An admin's key follows the admin: read-only once they are a viewer, dead once they leave.
    const admin = await registerUser(ctx, 'Connector Admin');
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: admin.email, role: 'ADMIN' }).expect(201);
    const adminKey = (await ctx.http().post(`${org.base}/crm-connection/keys`).set(admin.auth).send({ name: 'Admin sync', scopes: ['crm.read', 'crm.write'] }).expect(201)).body.key;
    await api(adminKey).post('/leads', { name: 'Via admin', source: 'OTHER' }).expect(201);
    await ctx.http().put(`${org.base}/members/${admin.id}`).set(owner.auth).send({ role: 'VIEWER' }).expect(200);
    expect((await api(adminKey).post('/leads', { name: 'Via viewer', source: 'OTHER' }).expect(403)).body.message).toMatch(/no longer has crm.manage/);
    await api(adminKey).get('/leads').expect(200);
    await ctx.http().delete(`${org.base}/members/${admin.id}`).set(owner.auth).expect(204);
    expect((await api(adminKey).get('/leads').expect(401)).body.message).toMatch(/left the organisation/);

    await ctx.http().post(`${org.base}/crm-connection/keys`).set(viewer.auth).send({ name: 'x', scopes: ['crm.read'] }).expect(403);
    await ctx.http().post(`${org.base}/crm-connection/keys/${writeKeyId}/revoke`).set(owner.auth).expect(201);
    await ctx.http().post(`${org.base}/crm-connection/keys/${writeKeyId}/revoke`).set(owner.auth).expect(409);
    expect((await api(writeKey).get('/me').expect(401)).body.message).toMatch(/revoked/);
    const list = (await ctx.http().get(`${org.base}/crm-connection/keys`).set(owner.auth).expect(200)).body;
    expect(list.keys.find((k: { id: string }) => k.id === writeKeyId)).toMatchObject({ status: 'REVOKED', revokedBy: 'Connector Owner' });
    await expect(
      ctx.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
        return tx.$executeRawUnsafe(`DELETE FROM api_keys WHERE id = '${writeKeyId}'`);
      }),
    ).rejects.toThrow(/never deleted/);
  });
});

describe('CRM webhooks', () => {
  let hookId: string;
  let secret: string;

  it('send signed events for what they subscribe to, from when they are made', async () => {
    await ctx.http().post(`${org.base}/crm-connection/webhooks`).set(owner.auth).send({ name: 'Sales CRM', url: 'ftp://example.com', events: ['deal.won'] }).expect(422);
    const h = (await ctx.http().post(`${org.base}/crm-connection/webhooks`).set(owner.auth).send({ name: 'Sales CRM', url: hookUrl, events: ['lead.created', 'deal.won', 'customer.created'] }).expect(201)).body;
    hookId = h.id;
    secret = h.secret;
    expect(secret).toMatch(/^whsec_/);
    expect((await ctx.http().get(`${org.base}/crm-connection/webhooks`).set(owner.auth).expect(200)).body.webhooks[0]).not.toHaveProperty('secret');

    // Nothing from before the webhook existed is sent.
    expect(await tick()).toEqual({ queued: 0, sent: 0 });

    const lead = (await ctx.http().post(`${org.base}/crm/leads`).set(owner.auth).send({ name: 'Meena Iyer', source: 'REFERRAL' }).expect(201)).body;
    await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Teak Supplies', isVendor: true }).expect(201);
    await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Banyan Retail', isCustomer: true }).expect(201);
    const deal = (await ctx.http().post(`${org.base}/crm/deals`).set(owner.auth).send({ name: 'Shelving', contactId: customerId, amount: '40000.00', expectedCloseDate: T }).expect(201)).body;
    await ctx.http().post(`${org.base}/crm/deals/${deal.id}/stage`).set(owner.auth).send({ stage: 'WON' }).expect(201);

    expect(await tick()).toEqual({ queued: 3, sent: 3 });
    expect(received.map((r) => r.json.event)).toEqual(['lead.created', 'customer.created', 'deal.won']);
    const won = received[2]!;
    expect(won.json).toMatchObject({ event: 'deal.won', organisationId: org.orgId, test: false, data: { id: deal.id, from: 'PROSPECTING', to: 'WON' }, object: { id: deal.id, stage: 'WON' } });
    expect(received[0]!.json.object).toMatchObject({ id: lead.id, name: 'Meena Iyer' });
    expect(received[1]!.json.object).toMatchObject({ name: 'Banyan Retail' });
    // The signature is HMAC-SHA256 of "<t>.<body>" with the secret.
    const sig = String(won.headers['t2t-signature']);
    const t = /t=(\d+)/.exec(sig)![1];
    expect(sig).toContain(`v1=${createHmac('sha256', secret).update(`${t}.${won.body}`).digest('hex')}`);
    expect(won.headers['t2t-event']).toBe('deal.won');
    expect(await tick()).toEqual({ queued: 0, sent: 0 });
  });

  it('try again after a failure, and can be tested, rotated and turned off', async () => {
    replies.push(503);
    await ctx.http().post(`${org.base}/crm/leads`).set(owner.auth).send({ name: 'Kiran Rao', source: 'EVENT' }).expect(201);
    await tick();
    let d = (await ctx.http().get(`${org.base}/crm-connection/webhooks/${hookId}/deliveries`).set(owner.auth).expect(200)).body.deliveries[0];
    expect(d).toMatchObject({ event: 'lead.created', status: 'PENDING', attempts: 1, statusCode: 503 });
    // Due again after a minute: brought forward here instead of waiting.
    await ctx.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
      await tx.$executeRawUnsafe(`UPDATE crm_webhook_deliveries SET next_attempt_at = now() WHERE id = '${d.id}'`);
    });
    await tick();
    d = (await ctx.http().get(`${org.base}/crm-connection/webhooks/${hookId}/deliveries`).set(owner.auth).expect(200)).body.deliveries[0];
    expect(d).toMatchObject({ status: 'SUCCEEDED', attempts: 2, statusCode: 200 });
    expect(received.at(-1)!.headers['t2t-attempt']).toBe('2');
    expect(received.at(-1)!.body).toBe(received.at(-2)!.body);

    const test = (await ctx.http().post(`${org.base}/crm-connection/webhooks/${hookId}/test`).set(owner.auth).expect(201)).body;
    expect(test).toMatchObject({ ok: true, statusCode: 200 });
    expect(received.at(-1)!.json).toMatchObject({ event: 'ping', test: true });

    const rotated = (await ctx.http().post(`${org.base}/crm-connection/webhooks/${hookId}/rotate-secret`).set(owner.auth).expect(201)).body;
    expect(rotated.secret).not.toBe(secret);

    await ctx.http().put(`${org.base}/crm-connection/webhooks/${hookId}`).set(owner.auth).send({ name: 'Sales CRM', url: hookUrl, events: ['lead.created'], enabled: false }).expect(200);
    await ctx.http().post(`${org.base}/crm/leads`).set(owner.auth).send({ name: 'While off', source: 'EVENT' }).expect(201);
    expect(await tick()).toEqual({ queued: 0, sent: 0 });
    await ctx.http().put(`${org.base}/crm-connection/webhooks/${hookId}`).set(owner.auth).send({ name: 'Sales CRM', url: hookUrl, events: ['lead.created'], enabled: true }).expect(200);
    expect(await tick()).toEqual({ queued: 0, sent: 0 });

    await ctx.http().get(`${org.base}/crm-connection/webhooks`).set(accountant.auth).expect(403);
    await ctx.http().get(`${other.base}/crm-connection/webhooks/${hookId}/deliveries`).set(outsider.auth).expect(404);
    await ctx.http().delete(`${org.base}/crm-connection/webhooks/${hookId}`).set(owner.auth).expect(200);
  });
});
