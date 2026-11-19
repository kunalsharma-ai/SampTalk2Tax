import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../src/admin/admin.service';
import { loadConfig, mongoUsesTls } from '../src/config';
import { bootApp, Ctx } from './helpers';

/**
 * Encryption in transit (SEC-010), against the real API and database: with HTTPS_ONLY a request
 * that did not reach Talk2Tax over HTTPS is refused (the health check excepted), browsers are
 * told to use HTTPS only, a database connection without TLS is refused at startup unless that is
 * turned off on purpose, and System health shows how each connection is protected.
 */
const base = { MONGODB_URL: 'mongodb://localhost:27017/x?replicaSet=rs0', JWT_SECRET: 'x'.repeat(32) };
let ctx: Ctx;
const HTTPS = { 'X-Forwarded-Proto': 'https' };

beforeAll(async () => {
  ctx = await bootApp({ HTTPS_ONLY: 'true', TRUST_PROXY_HOPS: '1', MONGODB_REQUIRE_TLS: 'false', WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'false', SMTP_URL: 'smtps://robot:pw@mail.example.test:465', EMAIL_FROM: 'Talk2Tax <robot@example.test>' });
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('settings', () => {
  it('is on when the public address is https, and needs a trusted proxy', () => {
    expect(loadConfig({ ...base, APP_URL: 'http://localhost:3000' }).HTTPS_ONLY).toBe(false);
    expect(() => loadConfig({ ...base, APP_URL: 'https://books.example.in' })).toThrow(/HTTPS_ONLY needs TRUST_PROXY_HOPS/);
    expect(() => loadConfig({ ...base, APP_URL: 'https://books.example.in', TRUST_PROXY_HOPS: '1' })).toThrow(/database connection must be encrypted/);
    const c = loadConfig({ ...base, APP_URL: 'https://books.example.in', TRUST_PROXY_HOPS: '1', MONGODB_URL: 'mongodb://db.internal:27017/t2t?replicaSet=rs0&tls=true' });
    expect(c).toMatchObject({ HTTPS_ONLY: true, MONGODB_REQUIRE_TLS: true });
    expect(loadConfig({ ...base, APP_URL: 'https://books.example.in', TRUST_PROXY_HOPS: '1', HTTPS_ONLY: 'false' }).HTTPS_ONLY).toBe(false);
    expect(loadConfig({ ...base, APP_URL: 'https://books.example.in', TRUST_PROXY_HOPS: '1', MONGODB_REQUIRE_TLS: 'false' })).toMatchObject({ HTTPS_ONLY: true, MONGODB_REQUIRE_TLS: false });
  });

  it('knows which database addresses are encrypted', () => {
    expect(mongoUsesTls('mongodb+srv://u:p@cluster0.example.net/t2t')).toBe(true);
    expect(mongoUsesTls('mongodb+srv://u:p@cluster0.example.net/t2t?tls=false')).toBe(false);
    expect(mongoUsesTls('mongodb://db:27017/t2t?replicaSet=rs0&ssl=true')).toBe(true);
    expect(mongoUsesTls('mongodb://db:27017/t2t?replicaSet=rs0')).toBe(false);
  });
});

describe('HTTPS only', () => {
  it('refuses plain HTTP, but answers the health check', async () => {
    const r = await ctx.http().post('/v1/auth/register').send({ email: `${randomUUID()}@example.test`, name: 'Plain Visitor', password: 'a-very-long-test-password' }).expect(403);
    expect(r.body).toEqual({ error: 'HTTPS_REQUIRED', message: 'Talk2Tax accepts requests over HTTPS only. Use the https:// address.' });
    await ctx.http().get('/v1/auth/me').set('X-Forwarded-Proto', 'http').expect(403);
    await ctx.http().get('/health').expect(200);
  });

  it('serves HTTPS requests and tells browsers to keep to HTTPS', async () => {
    const email = `${randomUUID()}@example.test`;
    const r = await ctx.http().post('/v1/auth/register').set(HTTPS).send({ email, name: 'Transit Admin', password: 'a-very-long-test-password' }).expect(201);
    expect(r.headers['strict-transport-security']).toMatch(/max-age=31536000; includeSubDomains/);
    await ctx.app.get(AdminService).grant(email, 'SUPER_ADMIN');
    const auth = { Authorization: `Bearer ${r.body.accessToken}` };
    const h = (await ctx.http().get('/v1/admin/system').set(HTTPS).set(auth).expect(200)).body;
    expect(h.transport).toEqual({
      httpsOnly: true,
      strictTransportSecurity: true,
      requestSecure: true,
      trustProxyHops: 1,
      database: { encrypted: false, required: false },
      email: 'TLS',
      ai: 'HTTPS',
      payments: 'HTTPS',
      webhooks: 'HTTPS_ONLY',
    });
  });
});
