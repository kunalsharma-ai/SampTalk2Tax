import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Organisation setup (UX-004 to UX-006, UX-014, UX-017 to UX-019): the business profile, the AI
 * preference applied to the agents, the setup checks worked out from the books, and activation
 * once every required one is done. Real API and database.
 */
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const gstin = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;

type Check = { id: string; status: 'DONE' | 'TODO'; required: boolean; link: string };
type Overview = {
  countryCode: string;
  canManage: boolean;
  profile: { industry: string | null; size: string | null; framework: string | null; aiPreference: string | null };
  suggestion: { framework: string; aiPreference: string; reasons: string[] };
  options: { frameworks: { id: string }[]; industries: { id: string }[] };
  checks: Check[];
  activation: { ok: boolean; missing: string[]; activatedAt: string | null; activatedById: string | null };
};
const get = async (who: TestUser = owner) => (await ctx.http().get(`${org.base}/setup`).set(who.auth).expect(200)).body as Overview;
const status = (o: Overview, id: string) => o.checks.find((c) => c.id === id)!.status;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Setup Owner');
  accountant = await registerUser(ctx, 'Setup Accountant');
  org = await createOrg(ctx, owner, { name: 'Setup Test Pvt Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: accountant.email, role: 'ACCOUNTANT' }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('organisation setup', () => {
  it('starts with the profile, GST and AI choice to do, and works out the rest from the books', async () => {
    const o = await get();
    expect(o.countryCode).toBe('IN');
    expect(o.profile).toEqual({ industry: null, size: null, framework: null, aiPreference: null });
    expect(o.options.frameworks.map((f) => f.id)).toEqual(['IND_AS', 'INDIAN_GAAP', 'IFRS', 'IFRS_SME', 'LOCAL_GAAP']);
    expect(['periods', 'bank', 'team'].map((id) => status(o, id))).toEqual(['DONE', 'DONE', 'DONE']);
    expect(o.activation).toMatchObject({ ok: false, missing: ['Business profile', 'Accounting framework', 'GST registration', 'AI preferences'], activatedAt: null });
    expect(o.suggestion.framework).toBe('INDIAN_GAAP');
  });

  it('refuses activation while a required step is open', async () => {
    const r = (await ctx.http().post(`${org.base}/setup/activate`).set(owner.auth).expect(422)).body;
    expect(r.error).toBe('SETUP_INCOMPLETE');
    expect(r.message).toMatch(/Business profile/);
  });

  it('saves the profile and applies the AI preference to the agents by action level', async () => {
    await ctx.http().put(`${org.base}/setup/profile`).set(owner.auth).send({ industry: 'SOFTWARE', size: 'SMALL', framework: 'US_GAAP', aiPreference: 'ADVISE' }).expect(422);
    await ctx.http().put(`${org.base}/setup/profile`).set(accountant.auth).send({ industry: 'SOFTWARE', size: 'SMALL', framework: 'INDIAN_GAAP', aiPreference: 'ADVISE' }).expect(403);
    const o = (await ctx.http().put(`${org.base}/setup/profile`).set(owner.auth).send({ industry: 'SOFTWARE', size: 'SMALL', framework: 'INDIAN_GAAP', aiPreference: 'ADVISE' }).expect(200)).body as Overview;
    expect(o.profile).toEqual({ industry: 'SOFTWARE', size: 'SMALL', framework: 'INDIAN_GAAP', aiPreference: 'ADVISE' });
    expect(['profile', 'framework', 'ai'].map((id) => status(o, id))).toEqual(['DONE', 'DONE', 'DONE']);

    const agents = async () => Object.fromEntries(((await ctx.http().get(`${org.base}/ai-control`).set(owner.auth).expect(200)).body.agents as { key: string; enabled: boolean }[]).map((a) => [a.key, a.enabled]));
    expect(await agents()).toEqual({ COPILOT: true, COLLECTIONS: false, BANKING: false, CLOSE: false, CFO: true });
    await ctx.http().put(`${org.base}/setup/profile`).set(owner.auth).send({ industry: 'SOFTWARE', size: 'SMALL', framework: 'INDIAN_GAAP', aiPreference: 'OFF' }).expect(200);
    expect(Object.values(await agents()).every((on) => !on)).toBe(true);
    await ctx.http().put(`${org.base}/setup/profile`).set(owner.auth).send({ industry: 'SOFTWARE', size: 'SMALL', framework: 'INDIAN_GAAP', aiPreference: 'PREPARE' }).expect(200);
    expect(Object.values(await agents()).every((on) => on)).toBe(true);
  });

  it('activates once GST is saved, records who did it, and only once', async () => {
    const fy = (await ctx.http().get(`${org.base}/periods`).set(owner.auth).expect(200)).body.map((p: { startDate: string }) => p.startDate).sort()[0];
    await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: gstin('27', 'ZZZST0001Z'), effectiveFrom: fy }).expect(200);
    const ready = await get();
    expect(ready.activation).toMatchObject({ ok: true, missing: [] });

    await ctx.http().post(`${org.base}/setup/activate`).set(accountant.auth).expect(403);
    const o = (await ctx.http().post(`${org.base}/setup/activate`).set(owner.auth).expect(200)).body as Overview;
    expect(o.activation.activatedById).toBe(owner.id);
    expect(o.activation.activatedAt).toEqual(expect.any(String));
    await ctx.http().post(`${org.base}/setup/activate`).set(owner.auth).expect(409);

    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=org_setup&entityId=${org.orgId}`).set(owner.auth).expect(200)).body;
    const actions = ((audit.items ?? audit) as { action: string }[]).map((e) => e.action);
    expect(actions.filter((a) => a === 'setup.activated')).toHaveLength(1);
    expect(actions.filter((a) => a === 'setup.profile_saved')).toHaveLength(3);
  });

  it('lets an accountant read the checklist without managing it', async () => {
    const o = await get(accountant);
    expect(o.canManage).toBe(false);
    expect(o.activation.activatedAt).toEqual(expect.any(String));
  });
});
