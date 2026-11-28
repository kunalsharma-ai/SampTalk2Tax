import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_PROFILE_KEYS } from '@talk2tax/accounting-engine';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * DEMO-001 to DEMO-021 against the real API and database: each of the six made-up companies is
 * built through the ordinary services into an organisation the person owns, flagged isDemo and
 * named "(SYNTHETIC DATA)", with balanced books, open and settled documents, projects,
 * departments, payroll (India), a matched bank statement, tax set-up, a submitted budget and
 * the CFO's recommendations. Every name says synthetic; one person has at most three; other
 * people cannot read it; a real organisation has no demo summary.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let outsider: TestUser;
const built: Record<string, { organisation: { id: string; name: string }; status: string; counts: Record<string, number>; failure: string | null }> = {};

const create = async (user: TestUser, profile: string, status = 201) => (await ctx.http().post('/v1/demo-organisations').set(user.auth).send({ profile }).expect(status)).body;
const base = (profile: string) => `/v1/orgs/${built[profile]!.organisation.id}`;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Demo Explorer');
  outsider = await registerUser(ctx, 'Demo Outsider');
}, 120_000);
afterAll(async () => ctx?.app.close());

describe('demonstration profiles', () => {
  it('lists the six made-up companies to anyone signed in', async () => {
    const r = (await ctx.http().get('/v1/demo-organisations/profiles').set(outsider.auth).expect(200)).body;
    expect(r.perPerson).toBe(3);
    expect(r.profiles.map((p: { key: string }) => p.key)).toEqual([...DEMO_PROFILE_KEYS]);
    expect(r.profiles.map((p: { title: string }) => p.title)).toEqual([
      'Indian consulting SME',
      'US professional services company',
      'UK trading business',
      'UAE multinational subsidiary',
      'Global manufacturing group',
      'Market research agency',
    ]);
    expect(r.profiles.every((p: { orgName: string }) => p.orgName.endsWith('(SYNTHETIC DATA)'))).toBe(true);
    await ctx.http().get('/v1/demo-organisations/profiles').expect(401);
  });

  it('refuses an unknown profile', async () => {
    const r = await create(owner, 'REAL_COMPANY', 400);
    expect(r.error).toBe('VALIDATION_FAILED');
  });
});

describe('building demonstration organisations', () => {
  it('builds the UK trading business with VAT, stock and cost of sales', async () => {
    const r = await create(owner, 'UK_TRADING');
    built.UK_TRADING = r;
    expect(r.failure).toBeNull();
    expect(r.status).toBe('READY');
    expect(r.organisation.name).toBe('Harbourside Trading Ltd (SYNTHETIC DATA)');
    expect(r.counts).toMatchObject({ customers: 4, vendors: 3, departments: 2, projects: 2, budgets: 1, taxRegistrations: 1, employees: 3 });
    expect(r.counts.invoices).toBeGreaterThanOrEqual(20);
    expect(r.counts.bills).toBe(18);
    const org = (await ctx.http().get(base('UK_TRADING')).set(owner.auth).expect(200)).body;
    expect(org).toMatchObject({ isDemo: true, countryCode: 'GB', functionalCurrency: 'GBP', role: 'OWNER', timeZone: 'Europe/London' });
    const vat = (
      await ctx
        .http()
        .get(`${base('UK_TRADING')}/tax/vat/settings`)
        .set(owner.auth)
        .expect(200)
    ).body;
    expect(vat.settings.vrn).toMatch(/^GB\d{9}$/);
    const tb = (
      await ctx
        .http()
        .get(`${base('UK_TRADING')}/reports/trial-balance?asOf=${T}`)
        .set(owner.auth)
        .expect(200)
    ).body;
    expect(tb.balanced).toBe(true);
    expect(JSON.stringify(tb)).toContain('Cost of Sales');
  }, 180_000);

  it('labels every name synthetic and leaves receivables open and overdue', async () => {
    const contacts = (
      await ctx
        .http()
        .get(`${base('UK_TRADING')}/contacts`)
        .set(owner.auth)
        .expect(200)
    ).body;
    const list = (Array.isArray(contacts) ? contacts : contacts.contacts) as { name: string }[];
    expect(list).toHaveLength(7);
    expect(list.every((c) => c.name.includes('(synthetic)'))).toBe(true);
    const dims = (
      await ctx
        .http()
        .get(`${base('UK_TRADING')}/dimensions`)
        .set(owner.auth)
        .expect(200)
    ).body.values as { name: string; type: string; lines: number }[];
    expect(dims.every((d) => d.name.includes('(synthetic)'))).toBe(true);
    expect(dims.filter((d) => d.type === 'PROJECT').every((d) => d.lines > 0)).toBe(true);
    expect(dims.filter((d) => d.type === 'DEPARTMENT').every((d) => d.lines > 0)).toBe(true);
    const ageing = (
      await ctx
        .http()
        .get(`${base('UK_TRADING')}/sales/ageing?asOf=${T}`)
        .set(owner.auth)
        .expect(200)
    ).body;
    expect(JSON.stringify(ageing)).toContain('Severn Gift Co. (synthetic)');
  });

  it('matches a synthetic bank statement and submits a budget for approval', async () => {
    const r = built.UK_TRADING!;
    expect(r.counts.bankLines).toBeGreaterThan(2);
    expect(r.counts.bankMatched).toBeGreaterThan(0);
    const budgets = (
      await ctx
        .http()
        .get(`${base('UK_TRADING')}/budgets`)
        .set(owner.auth)
        .expect(200)
    ).body;
    const list = (Array.isArray(budgets) ? budgets : budgets.budgets) as { name: string; status: string }[];
    expect(list).toEqual([expect.objectContaining({ name: 'Plan (synthetic)', status: 'SUBMITTED' })]);
  });

  it('shows what was made, the synthetic notice and the CFO recommendations', async () => {
    const s = (
      await ctx
        .http()
        .get(`${base('UK_TRADING')}/demo-organisation`)
        .set(owner.auth)
        .expect(200)
    ).body;
    expect(s.profile).toMatchObject({ key: 'UK_TRADING', title: 'UK trading business', countryCode: 'GB' });
    expect(s.status).toBe('READY');
    expect(s.synthetic).toContain('made up');
    expect(typeof s.headline).toBe('string');
    expect(Array.isArray(s.recommendations)).toBe(true);
    expect(s.counts.invoices).toBe(built.UK_TRADING!.counts.invoices);
  });

  it('builds the Indian consulting SME with GST, payroll and filed returns', async () => {
    const r = await create(owner, 'IN_CONSULTING');
    built.IN_CONSULTING = r;
    expect(r.failure).toBeNull();
    expect(r.status).toBe('READY');
    expect(r.counts).toMatchObject({ customers: 4, vendors: 4, employees: 4, projects: 3, departments: 2 });
    expect(r.counts.payRuns).toBe(5);
    expect(r.counts.filings).toBeGreaterThan(0);
    const gst = (
      await ctx
        .http()
        .get(`${base('IN_CONSULTING')}/gst/registration`)
        .set(owner.auth)
        .expect(200)
    ).body;
    expect(JSON.stringify(gst)).toMatch(/27ZZZCD9001Z1Z/);
    const emps = (
      await ctx
        .http()
        .get(`${base('IN_CONSULTING')}/payroll/employees`)
        .set(owner.auth)
        .expect(200)
    ).body;
    const list = (Array.isArray(emps) ? emps : emps.employees) as { name: string }[];
    expect(list.map((e) => e.name).every((n) => n.endsWith('(synthetic)'))).toBe(true);
    const tb = (
      await ctx
        .http()
        .get(`${base('IN_CONSULTING')}/reports/trial-balance?asOf=${T}`)
        .set(owner.auth)
        .expect(200)
    ).body;
    expect(tb.balanced).toBe(true);
  }, 180_000);

  it('allows three per person', async () => {
    const r = await create(owner, 'US_SERVICES');
    built.US_SERVICES = r;
    expect(r.status).toBe('READY');
    expect(r.counts.taxRegistrations ?? 0).toBe(0);
    const refused = await create(owner, 'AE_SUBSIDIARY', 409);
    expect(refused.error).toBe('DEMO_LIMIT');
  }, 180_000);

  it.each(['AE_SUBSIDIARY', 'GLOBAL_MANUFACTURING', 'MARKET_RESEARCH'])(
    'builds %s with balanced books',
    async (profile) => {
      const someone = await registerUser(ctx, `Demo ${profile}`);
      const r = await create(someone, profile);
      built[profile] = r;
      expect(r.failure).toBeNull();
      expect(r.status).toBe('READY');
      expect(r.organisation.name).toMatch(/\(SYNTHETIC DATA\)$/);
      const tb = (await ctx.http().get(`/v1/orgs/${r.organisation.id}/reports/trial-balance?asOf=${T}`).set(someone.auth).expect(200)).body;
      expect(tb.balanced).toBe(true);
    },
    180_000,
  );
});

describe('isolation', () => {
  it('keeps a demonstration organisation to its owner, and real organisations have no demo summary', async () => {
    await ctx
      .http()
      .get(`${base('UK_TRADING')}/demo-organisation`)
      .set(outsider.auth)
      .expect(404);
    await ctx
      .http()
      .get(`${base('UK_TRADING')}/contacts`)
      .set(outsider.auth)
      .expect(404);
    const real = await createOrg(ctx, outsider, { name: 'Real Books Ltd' });
    const r = (await ctx.http().get(`${real.base}/demo-organisation`).set(outsider.auth).expect(404)).body;
    expect(r.error).toBe('NOT_DEMO');
    const orgs = (await ctx.http().get('/v1/orgs').set(owner.auth).expect(200)).body as { name: string; isDemo: boolean }[];
    expect(
      orgs
        .filter((o) => o.isDemo)
        .map((o) => o.name)
        .sort(),
    ).toEqual(['Harbourside Trading Ltd (SYNTHETIC DATA)', 'Juniper Ridge Consulting LLC (SYNTHETIC DATA)', 'Kestrel Advisory Partners (SYNTHETIC DATA)']);
  });
});
