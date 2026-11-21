import { createHmac, randomUUID } from 'node:crypto';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IS_PUBLIC } from '../src/auth/decorators';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Security test suite (QA-020), against the real API and database. Every route the API serves is
 * found from the controllers themselves, so a route added later is covered without editing this
 * file: each one that is not marked public refuses a request without a valid token, and each
 * organisation route refuses a signed-in person who is not a member, whatever the method. Then the
 * usual attacks on the edges: forged and expired tokens, operator injection in JSON and query
 * strings, oversized and malformed bodies, extra fields that try to grant rights, and error
 * responses that would leak internals.
 */
interface Route {
  method: string;
  path: string;
  public: boolean;
}

let ctx: Ctx;
let owner: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let routes: Route[];

const METHODS: Partial<Record<RequestMethod, string>> = { [RequestMethod.GET]: 'get', [RequestMethod.POST]: 'post', [RequestMethod.PUT]: 'put', [RequestMethod.PATCH]: 'patch', [RequestMethod.DELETE]: 'delete' };

/** Every route, read from the controllers' own metadata. */
function allRoutes(): Route[] {
  const out: Route[] = [];
  for (const mod of ctx.app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const cls = wrapper.metatype as (new (...a: unknown[]) => unknown) | null;
      if (!cls) continue;
      const base = ([] as string[]).concat(Reflect.getMetadata(PATH_METADATA, cls) ?? '');
      const classPublic = !!Reflect.getMetadata(IS_PUBLIC, cls);
      const proto = cls.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const fn = proto[name];
        if (name === 'constructor' || typeof fn !== 'function') continue;
        const paths = Reflect.getMetadata(PATH_METADATA, fn) as string | string[] | undefined;
        const m = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
        if (paths === undefined || m === undefined) continue;
        const method = METHODS[m];
        if (!method) continue;
        for (const b of base) for (const p of ([] as string[]).concat(paths)) {
          out.push({ method, path: `/${[b, p].filter((x) => x && x !== '/').join('/')}`.replace(/\/+/g, '/'), public: classPublic || !!Reflect.getMetadata(IS_PUBLIC, fn) });
        }
      }
    }
  }
  return out;
}

/** A concrete URL: this organisation, and a random id for every other parameter. */
const urlOf = (r: Route, orgId: string) => r.path.replace(':orgId', orgId).replace(/:[A-Za-z]+/g, () => randomUUID());

const PUBLIC_ROUTES = [
  'GET /health',
  'GET /v1/auditor-portal/:token',
  'GET /v1/auditor-portal/:token/files/:attachmentId',
  'GET /v1/crm-api/customers',
  'GET /v1/crm-api/customers/:id',
  'GET /v1/crm-api/deals',
  'GET /v1/crm-api/deals/:id',
  'GET /v1/crm-api/leads',
  'GET /v1/crm-api/leads/:id',
  'GET /v1/crm-api/me',
  'GET /v1/portal/:token',
  'GET /v1/portal/:token/documents/:documentId',
  'GET /v1/portal/:token/statement',
  'GET /v1/region',
  'GET /v1/status',
  'GET /v1/vendor-portal/:token',
  'GET /v1/vendor-portal/:token/statement',
  'POST /v1/auth/login',
  'POST /v1/auth/login/code',
  'POST /v1/auth/logout',
  'POST /v1/auth/refresh',
  'POST /v1/auth/register',
  'POST /v1/auth/sso/finish',
  'POST /v1/auth/sso/start',
  'POST /v1/billing/webhooks/:provider',
  'POST /v1/crm-api/deals',
  'POST /v1/crm-api/deals/:id/stage',
  'POST /v1/crm-api/leads',
  'POST /v1/crm-api/leads/:id/convert',
  'POST /v1/crm-api/leads/:id/status',
  'POST /v1/payment-links/webhooks/:orgId/:provider',
  'POST /v1/vendor-portal/:token/invoices',
  'PUT /v1/crm-api/deals/:id',
  'PUT /v1/crm-api/leads/:id',
  'PUT /v1/vendor-portal/:token/invoices/:id/file',
];

const jwtPart = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const LEAKS = /\bat [\w.<>]+ \(|node_modules|\/src\/|MongoServerError|E11000|stack/;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Suite Owner');
  outsider = await registerUser(ctx, 'Suite Outsider');
  org = await createOrg(ctx, owner, { name: 'Security Suite Pvt Ltd' });
  routes = allRoutes();
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('every route', () => {
  it('finds the whole API from the controllers', () => {
    expect(routes.length).toBeGreaterThan(500);
    const orgRoutes = routes.filter((r) => r.path.startsWith('/v1/orgs/:orgId'));
    expect(orgRoutes.length).toBeGreaterThan(400);
    // The public routes are exactly these. A new one must be added here on purpose, after review.
    const pub = routes.filter((r) => r.public).map((r) => `${r.method.toUpperCase()} ${r.path}`).sort();
    expect(pub).toEqual(PUBLIC_ROUTES);
    expect(orgRoutes.filter((r) => r.public)).toEqual([]);
  });

  it('refuses every route that is not public without a valid token', async () => {
    const failures: string[] = [];
    let sent = 0;
    for (const r of routes.filter((x) => !x.public)) {
      const url = urlOf(r, org.orgId);
      for (const auth of [undefined, 'Bearer not-a-token']) {
        const req = (ctx.http() as unknown as Record<string, (u: string) => { set: (h: Record<string, string>) => Promise<{ status: number; text: string }> }>)[r.method](url);
        const res = await req.set(auth ? { Authorization: auth } : {});
        sent++;
        if (res.status !== 401) failures.push(`${r.method.toUpperCase()} ${r.path} (${auth ? 'bad token' : 'no token'}): ${res.status}`);
        if (LEAKS.test(res.text)) failures.push(`${r.method.toUpperCase()} ${r.path}: leaks internals`);
      }
    }
    expect(failures).toEqual([]);
    expect(sent).toBe((routes.length - PUBLIC_ROUTES.length) * 2);
  });

  it('refuses the public routes that need a secret, without it', async () => {
    const failures: string[] = [];
    const secretRoutes = routes.filter((x) => x.public && /crm-api|portal|webhooks/.test(x.path));
    expect(secretRoutes.length).toBe(25);
    for (const r of secretRoutes) {
      const req = (ctx.http() as unknown as Record<string, (u: string) => { send: (b: unknown) => Promise<{ status: number; text: string }> }>)[r.method](urlOf(r, org.orgId));
      const res = await req.send({ event: 'payment.captured', payload: {} });
      if (res.status < 400 || res.status >= 500) failures.push(`${r.method.toUpperCase()} ${r.path}: ${res.status} ${res.text.slice(0, 120)}`);
      if (LEAKS.test(res.text)) failures.push(`${r.method.toUpperCase()} ${r.path}: leaks internals`);
    }
    expect(failures).toEqual([]);
  });

  it("refuses every organisation route, for every method, to someone who is not a member", async () => {
    const failures: string[] = [];
    const statuses = new Map<number, number>();
    for (const r of routes.filter((x) => x.path.startsWith('/v1/orgs/:orgId'))) {
      const url = urlOf(r, org.orgId);
      const req = (ctx.http() as unknown as Record<string, (u: string) => { set: (h: Record<string, string>) => { send: (b: unknown) => Promise<{ status: number; text: string }> } }>)[r.method](url);
      const res = await req.set(outsider.auth).send({});
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      if (res.status !== 404 && res.status !== 403) failures.push(`${r.method.toUpperCase()} ${r.path}: ${res.status} ${res.text.slice(0, 120)}`);
      if (LEAKS.test(res.text)) failures.push(`${r.method.toUpperCase()} ${r.path}: leaks internals`);
    }
    expect(failures).toEqual([]);
    expect([...statuses.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(800);
    // Nothing the outsider sent was recorded against the organisation.
    expect(await ctx.prisma.auditEvent.count({ where: { orgId: org.orgId, actorId: outsider.id } })).toBe(0);
  });
});

describe('tokens', () => {
  it('refuses forged, re-signed, unsigned and expired tokens', async () => {
    const good = owner.auth.Authorization.slice('Bearer '.length);
    await ctx.http().get('/v1/auth/me').set(owner.auth).expect(200);
    const [h, p, s] = good.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
    const tries = {
      'changed subject': `${h}.${jwtPart({ ...claims, sub: outsider.id })}.${s}`,
      'alg none': `${jwtPart({ alg: 'none', typ: 'JWT' })}.${p}.`,
      'signed with another key': (() => {
        const head = jwtPart({ alg: 'HS256', typ: 'JWT' });
        const body = jwtPart(claims);
        return `${head}.${body}.${createHmac('sha256', 'not-the-server-secret-but-long-enough-0000').update(`${head}.${body}`).digest('base64url')}`;
      })(),
      expired: (() => {
        const head = jwtPart({ alg: 'HS256', typ: 'JWT' });
        const body = jwtPart({ ...claims, iat: 1_600_000_000, exp: 1_600_000_600 });
        return `${head}.${body}.${createHmac('sha256', process.env.JWT_SECRET ?? 'test-secret-that-is-long-enough-for-hs256-signing').update(`${head}.${body}`).digest('base64url')}`;
      })(),
      truncated: good.slice(0, -4),
    };
    for (const [why, token] of Object.entries(tries)) {
      const res = await ctx.http().get('/v1/auth/me').set({ Authorization: `Bearer ${token}` });
      expect(res.status, why).toBe(401);
    }
  });
});

describe('input', () => {
  it('refuses query operators in place of sign-in details', async () => {
    for (const body of [{ email: { $gt: '' }, password: { $gt: '' } }, { email: owner.email, password: { $ne: 'x' } }, { email: { $regex: '.*' }, password: 'a-very-long-test-password' }]) {
      const res = await ctx.http().post('/v1/auth/login').send(body);
      expect([400, 401, 422]).toContain(res.status);
      expect(res.body.accessToken).toBeUndefined();
    }
  });

  it('treats operator-looking query strings as text, never as a query', async () => {
    for (const q of ['status[$ne]=OPEN', 'status=%7B%22%24ne%22%3A%22x%22%7D', 'q[$regex]=.*', 'limit[$gt]=0']) {
      const res = await ctx.http().get(`${org.base}/tasks?${q}`).set(owner.auth);
      expect(res.status, q).toBeLessThan(500);
      expect(LEAKS.test(res.text), q).toBe(false);
    }
  });

  it('refuses malformed and oversized bodies with a plain error', async () => {
    const bad = await ctx.http().post(`${org.base}/contacts`).set(owner.auth).set('Content-Type', 'application/json').send('{"name": "Broken",');
    expect(bad.status).toBe(400);
    expect(LEAKS.test(bad.text)).toBe(false);
    const huge = await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'x'.repeat(4 * 1024 * 1024) });
    expect(huge.status).toBe(413);
    expect(LEAKS.test(huge.text)).toBe(false);
  });

  it('ignores fields that try to grant rights when registering or creating records', async () => {
    const email = `suite-${randomUUID().slice(0, 8)}@example.test`;
    await ctx.http().post('/v1/auth/register').send({ email, name: 'Sneaky', password: 'a-very-long-test-password', platformRole: 'SUPER_ADMIN', role: 'OWNER', isAdmin: true }).expect((r) => expect([201, 400]).toContain(r.status));
    const user = await ctx.db.collection('users').findOne({ email });
    if (user) expect(user.platformRole ?? null).toBeNull();
    // A contact cannot be planted in another organisation by naming it in the body.
    const other = await createOrg(ctx, outsider, { name: 'Elsewhere Pvt Ltd' });
    const made = await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Planted', isCustomer: true, orgId: other.orgId });
    if (made.status === 201) expect((await ctx.db.collection('contacts').findOne({ _id: made.body.id }))?.orgId).toBe(org.orgId);
    expect(await ctx.db.collection('contacts').countDocuments({ orgId: other.orgId, name: 'Planted' })).toBe(0);
  });
});

describe('responses', () => {
  it('never shows internals in an error, and says what the server is not', async () => {
    const missing = await ctx.http().get('/v1/no-such-route').set(owner.auth);
    expect(missing.status).toBe(404);
    expect(LEAKS.test(missing.text)).toBe(false);
    const res = await ctx.http().get('/v1/auth/me').set(owner.auth).expect(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toMatch(/password|passwordHash|totpSecret/i);
  });
});
