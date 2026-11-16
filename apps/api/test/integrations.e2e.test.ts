import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAnthropicStandIn } from '../../../test-support/anthropic-stand-in.mjs';
import { startSmtpStandIn, type SmtpStandIn } from '../../../test-support/smtp-stand-in.mjs';
import { SecretBox } from '../src/integrations/secret-box';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Integrations set up in the app: an organisation's own Claude key and model and its own mail
 * server, stored encrypted, tested for real against local stand-ins (the official SDK and
 * nodemailer), used by the copilot and by automations, falling back to the server's settings,
 * and kept to owners and admins and to their organisation.
 */
let ctx: Ctx;
let standIn: Awaited<ReturnType<typeof startAnthropicStandIn>>;
let smtp: SmtpStandIn;
let owner: TestUser;
let accountant: TestUser;
type Org = Awaited<ReturnType<typeof createOrg>>;
let org: Org;
let other: Org;
const KEY = 'sk-ant-test-0123456789-abcdefWXYZ';

beforeAll(async () => {
  standIn = await startAnthropicStandIn();
  smtp = await startSmtpStandIn();
  // No server-wide key or mail server: everything comes from the organisation's own settings.
  ctx = await bootApp({ ANTHROPIC_BASE_URL: standIn.url, SMTP_URL: '', EMAIL_FROM: '' }, { copilotModel: undefined });
  owner = await registerUser(ctx, 'Integrations Owner');
  accountant = await registerUser(ctx, 'Integrations Accountant');
  org = await createOrg(ctx, owner, { name: 'Own Keys Ltd' });
  other = await createOrg(ctx, owner, { name: 'Other Keys Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: accountant.email, role: 'ACCOUNTANT' }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
  await standIn?.close();
  await smtp?.close();
});

describe('integrations', () => {
  it('starts with nothing set up, and only owners and admins see the page', async () => {
    const v = (await ctx.http().get(`${org.base}/integrations`).set(owner.auth).expect(200)).body;
    expect(v.ai).toMatchObject({ configured: false, inUse: 'NONE', serverFallback: false, modelInUse: 'claude-opus-5-5' });
    expect(v.ai.models.map((m: { id: string }) => m.id)).toContain('claude-sonnet-5-5');
    expect(v.email).toMatchObject({ configured: false, inUse: 'NONE', fromInUse: null });
    await ctx.http().get(`${org.base}/integrations`).set(accountant.auth).expect(403);
    await ctx.http().put(`${org.base}/integrations/ai`).set(accountant.auth).send({ apiKey: KEY, model: 'claude-sonnet-5-5', enabled: true }).expect(403);
    expect((await ctx.http().get(`${org.base}/copilot/status`).set(owner.auth).expect(200)).body).toMatchObject({ configured: false, source: 'NONE' });
  });

  it('stores the AI key encrypted, never returns it, and tests it through the SDK', async () => {
    await ctx.http().put(`${org.base}/integrations/ai`).set(owner.auth).send({ model: 'claude-sonnet-5-5', enabled: true }).expect(422);
    const v = (await ctx.http().put(`${org.base}/integrations/ai`).set(owner.auth).send({ apiKey: KEY, model: 'claude-sonnet-5-5', enabled: true }).expect(200)).body;
    expect(v.ai).toMatchObject({ configured: true, enabled: true, secretHint: '…WXYZ', testStatus: 'NOT_TESTED', inUse: 'ORGANISATION', modelInUse: 'claude-sonnet-5-5', settings: { model: 'claude-sonnet-5-5' } });
    expect(JSON.stringify(v)).not.toContain(KEY);
    const row = await ctx.prisma.orgIntegration.findFirstOrThrow({ where: { orgId: org.orgId, kind: 'AI_ANTHROPIC' } });
    expect(row.secretCipher).not.toContain('sk-ant');
    expect(new SecretBox({ jwtSecret: process.env.JWT_SECRET ?? 'test-secret-that-is-long-enough-for-hs256-signing' }).open(row.secretCipher!, row.keyId!)).toBe(KEY);
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=integration&limit=10`).set(owner.auth).expect(200)).body;
    expect(JSON.stringify(audit)).not.toContain(KEY);

    standIn.script.push(() => ({ status: 401, type: 'authentication_error', message: 'invalid x-api-key' }));
    const bad = (await ctx.http().post(`${org.base}/integrations/ai/test`).set(owner.auth).expect(200)).body;
    expect(bad).toMatchObject({ ok: false, message: 'Anthropic rejected the API key. Check that it is copied in full and still active.' });
    expect(bad.integrations.ai).toMatchObject({ testStatus: 'FAILED', testedBy: 'Integrations Owner' });

    standIn.script.push((body: { model: string }) => ({ model: body.model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }));
    const good = (await ctx.http().post(`${org.base}/integrations/ai/test`).set(owner.auth).expect(200)).body;
    expect(good).toMatchObject({ ok: true, message: 'Connected: claude-sonnet-5-5 answered.' });
    const req = standIn.requests[standIn.requests.length - 1]!;
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 16 });

    // Saving without a new key keeps the stored one; changing the model resets the test.
    const kept = (await ctx.http().put(`${org.base}/integrations/ai`).set(owner.auth).send({ model: 'claude-opus-5-5', enabled: true }).expect(200)).body;
    expect(kept.ai).toMatchObject({ secretHint: '…WXYZ', testStatus: 'NOT_TESTED', modelInUse: 'claude-opus-5-5' });
  });

  it('the copilot uses the organisation’s own key and model; other organisations stay not set up', async () => {
    await ctx.http().put(`${org.base}/integrations/ai`).set(owner.auth).send({ model: 'claude-haiku-5-5', enabled: true }).expect(200);
    await ctx.http().put(`${org.base}/copilot/settings`).set(owner.auth).send({ enabled: true }).expect(200);
    expect((await ctx.http().get(`${org.base}/copilot/status`).set(owner.auth).expect(200)).body).toMatchObject({ configured: true, source: 'ORGANISATION', model: 'claude-haiku-5-5' });
    standIn.script.push(() => ({ content: [{ type: 'text', text: 'Hello from your own key.' }], stop_reason: 'end_turn' }));
    const before = standIn.requests.length;
    await ctx.http().post(`${org.base}/copilot/conversations`).set(owner.auth).send({ question: 'Hello?' }).expect(201);
    for (let i = 0; i < 50 && standIn.requests.length === before; i++) await new Promise((r) => setTimeout(r, 50));
    const req = standIn.requests[before]!;
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.body.model).toBe('claude-haiku-5-5');

    expect((await ctx.http().get(`${other.base}/copilot/status`).set(owner.auth).expect(200)).body).toMatchObject({ configured: false, source: 'NONE' });
    // Turning the integration off stops its use without deleting it.
    await ctx.http().put(`${org.base}/integrations/ai`).set(owner.auth).send({ model: 'claude-haiku-5-5', enabled: false }).expect(200);
    expect((await ctx.http().get(`${org.base}/copilot/status`).set(owner.auth).expect(200)).body).toMatchObject({ configured: false, source: 'NONE' });
  });

  it('sets up a mail server, tests it with a real email, and automations send through it', async () => {
    const mail = { host: '127.0.0.1', port: smtp.port, security: 'NONE', username: 'mailer@ownkeys.test', password: 'smtp-secret-pass', fromAddress: 'accounts@ownkeys.test', fromName: 'Own Keys Accounts', replyTo: 'help@ownkeys.test', enabled: true };
    await ctx.http().put(`${org.base}/integrations/email`).set(owner.auth).send({ ...mail, fromAddress: 'not an email' }).expect(400);
    const v = (await ctx.http().put(`${org.base}/integrations/email`).set(owner.auth).send(mail).expect(200)).body;
    expect(v.email).toMatchObject({ configured: true, secretHint: '…pass', inUse: 'ORGANISATION', fromInUse: '"Own Keys Accounts" <accounts@ownkeys.test>', settings: { host: '127.0.0.1', username: 'mailer@ownkeys.test' } });
    expect(JSON.stringify(v)).not.toContain('smtp-secret-pass');

    smtp.settings.refuseLogins = true;
    const refused = (await ctx.http().post(`${org.base}/integrations/email/test`).set(owner.auth).expect(200)).body;
    expect(refused).toMatchObject({ ok: false, message: 'The mail server refused the username or password.' });
    smtp.settings.refuseLogins = false;

    const sent = smtp.messages.length;
    const ok = (await ctx.http().post(`${org.base}/integrations/email/test`).set(owner.auth).expect(200)).body;
    expect(ok).toMatchObject({ ok: true, message: `Connected to 127.0.0.1:${smtp.port} and sent a test email to ${owner.email}.` });
    expect(smtp.logins[smtp.logins.length - 1]).toEqual({ user: 'mailer@ownkeys.test', pass: 'smtp-secret-pass' });
    const m = smtp.messages[sent]!;
    expect(m).toMatchObject({ from: 'accounts@ownkeys.test', to: [owner.email.toLowerCase()], subject: 'Talk2Tax: test email' });
    expect(m.headers['reply-to']).toBe('help@ownkeys.test');

    const cat = (await ctx.http().get(`${org.base}/workflows/catalogue`).set(owner.auth).expect(200)).body;
    expect(cat.email).toEqual({ ready: true, from: '"Own Keys Accounts" <accounts@ownkeys.test>', source: 'ORGANISATION' });
    expect((await ctx.http().get(`${other.base}/workflows/catalogue`).set(owner.auth).expect(200)).body.email).toEqual({ ready: false, from: null, source: 'NONE' });

    // Removing it puts the organisation back to not set up.
    const gone = (await ctx.http().delete(`${org.base}/integrations/email`).set(owner.auth).expect(200)).body;
    expect(gone.email).toMatchObject({ configured: false, inUse: 'NONE' });
    await ctx.http().delete(`${org.base}/integrations/email`).set(owner.auth).expect(404);
  });

  it('reports a stored secret sealed with another key as needing to be entered again', async () => {
    await ctx.prisma.orgIntegration.updateMany({ where: { orgId: org.orgId, kind: 'AI_ANTHROPIC' }, data: { keyId: 'old-key-0000', enabled: true } });
    const v = (await ctx.http().get(`${org.base}/integrations`).set(owner.auth).expect(200)).body;
    expect(v.ai).toMatchObject({ configured: true, secretUnreadable: true, inUse: 'NONE' });
    const r = await ctx.http().put(`${org.base}/integrations/ai`).set(owner.auth).send({ model: 'claude-haiku-5-5', enabled: true }).expect(422);
    expect(r.body.message).toBe('The stored key can no longer be read; enter it again');
    const fixed = (await ctx.http().put(`${org.base}/integrations/ai`).set(owner.auth).send({ apiKey: KEY, model: 'claude-haiku-5-5', enabled: true }).expect(200)).body;
    expect(fixed.ai).toMatchObject({ secretUnreadable: false, inUse: 'ORGANISATION' });
  });

  it('falls back to the server’s settings when an organisation has none of its own', async () => {
    const server = await bootApp({ ANTHROPIC_API_KEY: 'server-key-not-real', ANTHROPIC_BASE_URL: standIn.url, SMTP_URL: smtp.url, EMAIL_FROM: 'Server <server@talk2tax.test>', WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'false' }, { copilotModel: undefined });
    try {
      const v = (await server.http().get(`${other.base}/integrations`).set(owner.auth).expect(200)).body;
      expect(v.ai).toMatchObject({ configured: false, inUse: 'SERVER', serverFallback: true });
      expect(v.email).toMatchObject({ configured: false, inUse: 'SERVER', serverFallback: true, fromInUse: 'Server <server@talk2tax.test>' });
      // The organisation's own key wins over the server's.
      expect((await server.http().get(`${org.base}/integrations`).set(owner.auth).expect(200)).body.ai.inUse).toBe('ORGANISATION');
      // A public server refuses unencrypted mail and mail servers on private networks.
      const mail = { host: 'smtp.example.com', port: 587, security: 'STARTTLS', fromAddress: 'a@ownkeys.test', enabled: true };
      expect((await server.http().put(`${org.base}/integrations/email`).set(owner.auth).send({ ...mail, security: 'NONE' }).expect(422)).body.message).toMatch(/Choose TLS or STARTTLS/);
      expect((await server.http().put(`${org.base}/integrations/email`).set(owner.auth).send({ ...mail, host: '10.0.0.5' }).expect(422)).body.message).toMatch(/private network/);
      await server.http().put(`${org.base}/integrations/email`).set(owner.auth).send({ ...mail, host: 'localhost' }).expect(200);
      expect((await server.http().post(`${org.base}/integrations/email/test`).set(owner.auth).expect(200)).body).toMatchObject({ ok: false, message: 'The mail server localhost is on a private network, which this server does not allow' });
      await server.http().delete(`${org.base}/integrations/email`).set(owner.auth).expect(200);
    } finally {
      await server.app.close();
    }
  });
});
