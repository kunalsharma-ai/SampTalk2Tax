import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CopilotModel, CopilotRequest, CopilotResponse } from '../src/copilot/copilot.model';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * The onboarding assistant (UX-020 to UX-022) against the real API and database: the owner
 * describes the business, the assistant recommends the profile and setup steps (from word rules,
 * or from an AI model that a scripted stand-in plays here), nothing is applied until a person
 * accepts it, findings quoting words the owner did not write are dropped, and activation waits
 * for every recommendation to be decided.
 */
class ScriptedModel implements CopilotModel {
  readonly provider = 'Test stand-in';
  requests: CopilotRequest[] = [];
  steps: ((req: CopilotRequest) => CopilotResponse)[] = [];
  async send(req: CopilotRequest): Promise<CopilotResponse> {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift();
    if (!step) throw new Error('The test did not script this step');
    return step(req);
  }
}
const reply = (input: unknown) =>
  ({ id: 'msg_setup', type: 'message', role: 'assistant', model: 'test-model', content: [{ type: 'tool_use', id: 'toolu_setup', name: 'record_reading', input }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 400, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) as unknown as CopilotResponse;

type Rec = { id: string; kind: string; field: string | null; value: string | null; status: string; link: string | null };
type Overview = {
  profile: Record<string, string | null>;
  checks: { id: string; status: string; required: boolean }[];
  activation: { ok: boolean; missing: string[] };
  assistant: { ai: { configured: boolean; available: boolean }; reading: { source: string; model: string | null; dropped: string[]; recommendations: Rec[] } | null };
};

let ctx: Ctx;
let bare: Ctx;
const model = new ScriptedModel();
let owner: TestUser;
let accountant: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const DESCRIPTION = 'We are a SaaS company with 14 employees. Customers pay a monthly subscription, some of them overseas in USD, and we pay a few freelancers.';

beforeAll(async () => {
  ctx = await bootApp({}, { copilotModel: model });
  bare = await bootApp();
  owner = await registerUser(ctx, 'Assistant Owner');
  accountant = await registerUser(ctx, 'Assistant Accountant');
  org = await createOrg(ctx, owner, { name: 'Assistant Test Pvt Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: accountant.email, role: 'ACCOUNTANT' }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
  await bare?.app.close();
});

const read = (body: unknown, who: TestUser = owner, status = 200) => ctx.http().post(`${org.base}/setup/assistant`).set(who.auth).send(body as object).expect(status);
const decide = (id: string, decision: string, status = 200) => ctx.http().post(`${org.base}/setup/assistant/recommendations/${id}`).set(owner.auth).send({ decision }).expect(status);

describe('onboarding assistant', () => {
  it('recommends from the owner’s words without applying anything', async () => {
    await read({ description: 'short' }, owner, 400);
    await read({ description: DESCRIPTION }, accountant, 403);
    const o = (await read({ description: DESCRIPTION })).body as Overview;
    expect(o.assistant.reading).toMatchObject({ source: 'RULES', model: null, dropped: [] });
    expect(o.assistant.reading!.recommendations.map((r) => r.id)).toEqual(['profile:industry', 'profile:size', 'profile:framework', 'profile:aiPreference', 'step:payroll', 'step:tds', 'step:fx', 'step:contracts']);
    expect(o.assistant.reading!.recommendations.every((r) => r.status === 'PENDING')).toBe(true);
    expect(o.profile).toEqual({ industry: null, size: null, framework: null, aiPreference: null });
    expect(o.checks.find((c) => c.id === 'assistant')).toMatchObject({ status: 'TODO', required: true });
    expect(o.activation.missing).toContain('Assistant recommendations');
  });

  it('applies a profile recommendation only when accepted, once', async () => {
    let o = (await decide('profile:industry', 'ACCEPTED')).body as Overview;
    expect(o.profile.industry).toBe('SOFTWARE');
    await decide('profile:industry', 'DISMISSED', 409);
    await decide('step:nothing', 'ACCEPTED', 404);
    await decide('profile:size', 'MAYBE', 400);
    o = (await decide('profile:size', 'DISMISSED')).body as Overview;
    expect(o.profile.size).toBeNull();
  });

  it('reads with the AI model and keeps only findings that quote the owner', async () => {
    model.steps.push(() =>
      reply({
        industry: { value: 'SOFTWARE', quote: 'SaaS company' },
        size: { value: 'SMALL', quote: '14 employees' },
        signals: [
          { value: 'EMPLOYEES', quote: '14 employees' },
          { value: 'LOANS', quote: 'our term loan' },
          { value: 'RECURRING_BILLING', quote: 'monthly subscription' },
        ],
      }),
    );
    expect((await read({ description: DESCRIPTION, useAi: true }, owner, 409)).body.error).toBe('AI_OFF');
    expect(model.requests).toHaveLength(0);
    await ctx.http().put(`${org.base}/copilot/settings`).set(owner.auth).send({ enabled: true }).expect(200);
    const o = (await read({ description: DESCRIPTION, useAi: true })).body as Overview;
    expect(model.requests[0]!.messages[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: DESCRIPTION }] });
    expect(o.assistant.reading).toMatchObject({ source: 'AI', model: 'test-model', dropped: ['Has loans or borrowing: the words it quoted are not in the description'] });
    const ids = o.assistant.reading!.recommendations.map((r) => r.id);
    expect(ids).toEqual(['profile:industry', 'profile:size', 'profile:framework', 'profile:aiPreference', 'step:payroll', 'step:contracts']);
    expect(o.assistant.reading!.recommendations.every((r) => r.status === 'PENDING')).toBe(true);

    const none = await registerUser(bare, 'No AI Owner');
    const noneOrg = await createOrg(bare, none, { name: 'No AI Pvt Ltd' });
    const r = await bare.http().post(`${noneOrg.base}/setup/assistant`).set(none.auth).send({ description: DESCRIPTION, useAi: true }).expect(503);
    expect(r.body.error).toBe('AI_NOT_CONFIGURED');
    expect(((await bare.http().get(`${noneOrg.base}/setup`).set(none.auth).expect(200)).body as Overview).assistant.ai).toMatchObject({ configured: false, available: false });
  });

  it('holds activation until every recommendation is decided, then closes the assistant', async () => {
    const o0 = (await ctx.http().get(`${org.base}/setup`).set(owner.auth).expect(200)).body as Overview;
    // All at once, as quick clicks send them: none of the decisions may be lost.
    await Promise.all(o0.assistant.reading!.recommendations.map((r) => decide(r.id, r.kind === 'PROFILE' ? 'ACCEPTED' : 'DISMISSED')));
    expect(((await ctx.http().get(`${org.base}/setup`).set(owner.auth).expect(200)).body as Overview).assistant.reading!.recommendations.filter((r) => r.status === 'PENDING')).toEqual([]);
    const fy = (await ctx.http().get(`${org.base}/periods`).set(owner.auth).expect(200)).body.map((p: { startDate: string }) => p.startDate).sort()[0];
    const base = '27ZZZSA0001Z1Z';
    await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: `${base}${gstinCheckCharacter(base)}`, effectiveFrom: fy }).expect(200);
    const o = (await ctx.http().get(`${org.base}/setup`).set(owner.auth).expect(200)).body as Overview;
    expect(o.profile).toEqual({ industry: 'SOFTWARE', size: 'SMALL', framework: 'INDIAN_GAAP', aiPreference: 'ADVISE' });
    expect(o.activation).toMatchObject({ ok: true, missing: [] });
    const agents = (await ctx.http().get(`${org.base}/ai-control`).set(owner.auth).expect(200)).body.agents as { key: string; enabled: boolean }[];
    expect(Object.fromEntries(agents.map((a) => [a.key, a.enabled]))).toEqual({ COPILOT: true, COLLECTIONS: false, BANKING: false, CLOSE: false, CFO: true });

    await ctx.http().post(`${org.base}/setup/activate`).set(owner.auth).expect(200);
    expect((await read({ description: DESCRIPTION }, owner, 409)).body.error).toBe('ALREADY_ACTIVE');

    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=org_setup&entityId=${org.orgId}`).set(owner.auth).expect(200)).body;
    const actions = ((audit.items ?? audit) as { action: string }[]).map((e) => e.action);
    expect(actions.filter((a) => a === 'setup.assistant_read')).toHaveLength(2);
    expect(actions.filter((a) => a === 'setup.recommendation_accepted')).toHaveLength(5);
    expect(actions.filter((a) => a === 'setup.recommendation_dismissed')).toHaveLength(3);
  });
});
