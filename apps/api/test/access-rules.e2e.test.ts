import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inHours, inNetworks, localTime, parseNetwork, refusal } from '../src/security/access-rules.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Attribute-based access control (SEC-004), against the real API and database: access rules
 * bind roles or people to networks, days and hours, on top of their role. A rule that is not met
 * refuses the request (403 ACCESS_RULE), owners are never bound, a rule that would lock out the
 * person saving it is refused, and every change is audited.
 */
let ctx: Ctx;
let owner: TestUser;
let admin: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let base: string;
const OFFICE = { 'X-Forwarded-For': '203.0.113.25' };
const HOME = { 'X-Forwarded-For': '198.51.100.7' };
const TZ = 'Asia/Kolkata';

beforeAll(async () => {
  ctx = await bootApp({ TRUST_PROXY_HOPS: '1' });
  owner = await registerUser(ctx, 'Rules Owner');
  admin = await registerUser(ctx, 'Rules Admin');
  accountant = await registerUser(ctx, 'Rules Accountant');
  viewer = await registerUser(ctx, 'Rules Viewer');
  ({ base } = await createOrg(ctx, owner));
  for (const [u, role] of [[admin, 'ADMIN'], [accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) {
    await ctx.http().post(`${base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  }
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('the conditions', () => {
  it('matches addresses and ranges, IPv4 and IPv6', () => {
    expect(parseNetwork('10.0.0.0/8')).toEqual({ address: '10.0.0.0', prefix: 8, family: 'ipv4' });
    expect(parseNetwork('2001:db8::/32')?.family).toBe('ipv6');
    expect(parseNetwork('10.0.0.0/33')).toBeNull();
    expect(parseNetwork('office wifi')).toBeNull();
    expect(inNetworks('10.4.5.6', ['10.0.0.0/8'])).toBe(true);
    expect(inNetworks('::ffff:10.4.5.6', ['10.0.0.0/8'])).toBe(true);
    expect(inNetworks('11.0.0.1', ['10.0.0.0/8', '203.0.113.25'])).toBe(false);
    expect(inNetworks('2001:db8::1', ['2001:db8::/32'])).toBe(true);
    expect(inNetworks(null, ['10.0.0.0/8'])).toBe(false);
    expect(inNetworks('11.0.0.1', [])).toBe(true);
  });

  it('reads days and hours in the organisation time zone, with windows past midnight', () => {
    // 2026-11-20 is a Friday; 03:30 UTC is 09:00 in India.
    expect(localTime(new Date('2026-11-20T03:30:00Z'), TZ)).toEqual({ day: 5, minute: 540 });
    expect(localTime(new Date('2026-11-20T03:30:00Z'), 'America/New_York')).toEqual({ day: 4, minute: 1350 });
    expect(inHours(540, 540, 1080)).toBe(true);
    expect(inHours(1080, 540, 1080)).toBe(false);
    expect(inHours(60, 1320, 360)).toBe(true);
    expect(inHours(720, 1320, 360)).toBe(false);
    const rule = { id: 'r', name: 'Office hours', roles: ['ACCOUNTANT'], userIds: [], appliesTo: 'ALL' as const, networks: [], days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1080, active: true };
    const at = (iso: string) => ({ userId: 'u', role: 'ACCOUNTANT', ip: '1.2.3.4', at: new Date(iso), timeZone: TZ, writes: false });
    expect(refusal(rule, at('2026-11-20T03:30:00Z'))).toBeNull();
    expect(refusal(rule, at('2026-11-21T05:00:00Z'))).toMatch(/only on Monday, Tuesday, Wednesday, Thursday, Friday/);
    expect(refusal(rule, at('2026-11-20T13:00:00Z'))).toMatch(/only from 09:00 to 18:00 \(Asia\/Kolkata\)/);
    expect(refusal(rule, { ...at('2026-11-21T05:00:00Z'), role: 'OWNER' })).toBeNull();
    expect(refusal({ ...rule, active: false }, at('2026-11-21T05:00:00Z'))).toBeNull();
  });
});

describe('access rules on the API', () => {
  it('limits a role to the office network, and leaves others and owners alone', async () => {
    const r = await ctx.http().post(`${base}/access-rules`).set(owner.auth).set(HOME).send({ name: 'Office only', roles: ['ACCOUNTANT', 'VIEWER'], networks: ['203.0.113.0/24'] }).expect(201);
    expect(r.body).toMatchObject({ name: 'Office only', roles: ['ACCOUNTANT', 'VIEWER'], appliesTo: 'ALL', networks: ['203.0.113.0/24'], active: true });
    const refused = await ctx.http().get(`${base}/accounts`).set(accountant.auth).set(HOME).expect(403);
    expect(refused.body).toMatchObject({ error: 'ACCESS_RULE', rule: 'Office only' });
    expect(refused.body.message).toMatch(/only from the organisation's listed networks \(this request came from 198\.51\.100\.7\)/);
    await ctx.http().get(`${base}/accounts`).set(accountant.auth).set(OFFICE).expect(200);
    // The list of organisations says so, for the web app to explain instead of showing empty pages.
    const listed = (await ctx.http().get('/v1/orgs').set(accountant.auth).set(HOME).expect(200)).body.find((o: { id: string }) => base.endsWith(o.id));
    expect(listed.accessRefused).toMatch(/^This organisation's access rule "Office only" allows access only from/);
    expect((await ctx.http().get('/v1/orgs').set(accountant.auth).set(OFFICE).expect(200)).body.find((o: { id: string }) => base.endsWith(o.id)).accessRefused).toBeNull();
    await ctx.http().get(`${base}/accounts`).set(viewer.auth).set(HOME).expect(403);
    // Not named by the rule, and the owner is never bound.
    await ctx.http().get(`${base}/accounts`).set(admin.auth).set(HOME).expect(200);
    await ctx.http().get(`${base}/accounts`).set(owner.auth).set(HOME).expect(200);
    await ctx.http().delete(`${base}/access-rules/${r.body.id}`).set(owner.auth).expect(200);
    await ctx.http().get(`${base}/accounts`).set(accountant.auth).set(HOME).expect(200);
  });

  it('can bind changes only, and one person rather than a role', async () => {
    const { localTime: lt } = { localTime };
    const today = lt(new Date(), TZ).day;
    const r = await ctx.http().post(`${base}/access-rules`).set(owner.auth).send({ name: 'No changes today', userIds: [accountant.id], appliesTo: 'CHANGES', days: [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== today) }).expect(201);
    await ctx.http().get(`${base}/accounts`).set(accountant.auth).expect(200);
    const refused = await ctx.http().post(`${base}/accounts`).set(accountant.auth).send({ code: '1999', name: 'Probe', type: 'ASSET' }).expect(403);
    expect(refused.body.message).toMatch(/"No changes today" allows changes only on/);
    // Switched off, it binds nobody.
    await ctx.http().put(`${base}/access-rules/${r.body.id}`).set(owner.auth).send({ name: 'No changes today', userIds: [accountant.id], appliesTo: 'CHANGES', days: [today === 0 ? 1 : 0], active: false }).expect(200);
    await ctx.http().post(`${base}/accounts`).set(accountant.auth).send({ code: '1999', name: 'Allowed now', type: 'ASSET' }).expect(201);
  });

  it('refuses rules that lock out their author, bind owners, or say nothing', async () => {
    const locks = await ctx.http().post(`${base}/access-rules`).set(admin.auth).set(HOME).send({ name: 'Admins in the office', roles: ['ADMIN'], networks: ['203.0.113.0/24'] }).expect(409);
    expect(locks.body.error).toBe('ACCESS_RULE_LOCKS_YOU_OUT');
    // From the office it is fine; saved switched off it is fine too.
    await ctx.http().post(`${base}/access-rules`).set(admin.auth).set(OFFICE).send({ name: 'Admins in the office', roles: ['ADMIN'], networks: ['203.0.113.0/24'], active: false }).expect(201);
    await ctx.http().post(`${base}/access-rules`).set(owner.auth).send({ name: 'Bad', userIds: [owner.id], networks: ['10.0.0.0/8'] }).expect(422);
    await ctx.http().post(`${base}/access-rules`).set(owner.auth).send({ name: 'Bad', roles: ['OWNER'], networks: ['10.0.0.0/8'] }).expect(400);
    const v = await ctx.http().post(`${base}/access-rules`).set(owner.auth).send({ name: 'Bad', roles: ['VIEWER'], networks: ['office wifi'], startMinute: 540 }).expect(422);
    expect(v.body.message).toMatch(/Not an IP address or range: office wifi.*Give both a start and an end time/);
    await ctx.http().post(`${base}/access-rules`).set(owner.auth).send({ name: 'Bad', roles: ['VIEWER'] }).expect(422);
    // Viewers and accountants cannot manage rules; admins and owners can read them.
    await ctx.http().post(`${base}/access-rules`).set(accountant.auth).send({ name: 'Mine', roles: ['VIEWER'], networks: ['10.0.0.0/8'] }).expect(403);
  });

  it('lists the rules with whether each would refuse the person looking, and audits every change', async () => {
    const list = (await ctx.http().get(`${base}/access-rules`).set(admin.auth).set(HOME).expect(200)).body;
    expect(list.you).toMatchObject({ ip: '198.51.100.7', role: 'ADMIN', timeZone: TZ });
    const office = list.rules.find((r: { name: string }) => r.name === 'Admins in the office');
    expect(office).toMatchObject({ active: false, refusesYou: { access: null, changes: null } });
    expect(list.members.map((m: { role: string }) => m.role).sort()).toEqual(['ACCOUNTANT', 'ADMIN', 'VIEWER']);
    const audit = (await ctx.http().get(`${base}/audit-events?limit=100`).set(owner.auth).expect(200)).body;
    const actions = (Array.isArray(audit) ? audit : audit.events ?? audit.items).map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['access_rule.created', 'access_rule.updated', 'access_rule.deleted']));
  });
});
