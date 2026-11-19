import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../src/admin/admin.service';
import { AiControlService } from '../src/ai-control/ai-control.service';
import type { CopilotModel, CopilotRequest, CopilotResponse } from '../src/copilot/copilot.model';
import { CopilotService } from '../src/copilot/copilot.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Model access policies (SEC-034) against the real API and database, with a scripted stand-in for
 * the model: platform administrators choose the AI models allowed across Talk2Tax, an
 * organisation's owners and admins can narrow that, and a model that is not allowed is never
 * called, whether by the copilot, the connection test, or a saved setting.
 */
class ScriptedModel implements CopilotModel {
  readonly provider = 'Test stand-in';
  requests: CopilotRequest[] = [];
  async send(req: CopilotRequest): Promise<CopilotResponse> {
    this.requests.push(structuredClone(req));
    return { id: `msg_m_${this.requests.length}`, type: 'message', role: 'assistant', model: req.model, content: [{ type: 'text', text: 'Answered.', citations: null }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } as unknown as CopilotResponse;
  }
}

let ctx: Ctx;
const model = new ScriptedModel();
let admin: TestUser;
let owner: TestUser;
let accountant: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let A: string;
const settle = () => Promise.all([...ctx.app.get(CopilotService).inflight.values()]);
const allowEverything = (reason: string) => ctx.app.get(AiControlService).platformSetModels({ id: admin.id }, null, reason);
/** A question to the copilot: its answer, or the refusal when it was not even started. */
const ask = async () => {
  const res = await ctx.http().post(`${org.base}/copilot/conversations`).set(owner.auth).send({ question: 'How are we doing?' });
  if (res.status !== 201) return { status: `HTTP ${res.status}`, errorCode: res.body.error as string, errorMessage: res.body.message as string };
  const conv = res.body;
  await settle();
  return (await ctx.http().get(`${org.base}/copilot/conversations/${conv.id}`).set(owner.auth).expect(200)).body.messages[1] as { status: string; errorCode: string | null; errorMessage: string | null };
};

beforeAll(async () => {
  ctx = await bootApp({}, { copilotModel: model });
  admin = await registerUser(ctx, 'Models Admin');
  owner = await registerUser(ctx, 'Models Owner');
  accountant = await registerUser(ctx, 'Models Accountant');
  await ctx.app.get(AdminService).grant(admin.email, 'SUPER_ADMIN');
  // A limit left by an earlier run is lifted first.
  await allowEverything('Start of the model access test');
  org = await createOrg(ctx, owner, { name: 'Model Rules Pvt Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: accountant.email, role: 'ACCOUNTANT' }).expect(201);
  A = `${org.base}/ai-control`;
  await ctx.http().put(`${org.base}/copilot/settings`).set(owner.auth).send({ enabled: true }).expect(200);
});
afterAll(async () => {
  await settle();
  if (admin) await allowEverything('End of the model access test');
  await ctx?.app.close();
});

describe('organisation model access', () => {
  it('allows every model to start with', async () => {
    const v = (await ctx.http().get(A).set(accountant.auth).expect(200)).body.modelAccess;
    expect(v).toMatchObject({ organisation: [], platformLimited: false, inUse: 'claude-opus-5-5', inUseAllowed: true });
    expect(v.models.map((m: { id: string; allowed: boolean }) => [m.id, m.allowed])).toEqual([
      ['claude-opus-5-5', true],
      ['claude-sonnet-5-5', true],
      ['claude-haiku-5-5', true],
    ]);
    expect((await ask()).status).toBe('COMPLETE');
  });

  it('lets owners and admins narrow the models, and refuses a model that is not allowed', async () => {
    await ctx.http().put(`${A}/models`).set(accountant.auth).send({ allowed: ['claude-haiku-5-5'] }).expect(403);
    expect((await ctx.http().put(`${A}/models`).set(owner.auth).send({ allowed: ['gpt-9'] }).expect(422)).body.error).toBe('UNKNOWN_MODEL');
    const v = (await ctx.http().put(`${A}/models`).set(owner.auth).send({ allowed: ['claude-sonnet-5-5', 'claude-haiku-5-5'] }).expect(200)).body.modelAccess;
    expect(v).toMatchObject({ organisation: ['claude-haiku-5-5', 'claude-sonnet-5-5'], inUse: 'claude-opus-5-5', inUseAllowed: false });
    const audit = await ctx.prisma.auditEvent.findFirst({ where: { orgId: org.orgId, action: 'ai.models_allowed_changed' } });
    expect(audit?.data).toEqual({ from: [], to: ['claude-haiku-5-5', 'claude-sonnet-5-5'] });

    // The server's default model is no longer allowed here: nothing reaches the model.
    const before = model.requests.length;
    const m = await ask();
    expect(m).toMatchObject({ status: 'HTTP 409', errorCode: 'MODEL_NOT_ALLOWED' });
    expect(m.errorMessage).toMatch(/claude-opus-5-5 is not allowed for this organisation/);
    expect(model.requests.length).toBe(before);
    expect((await ctx.http().get(A).set(owner.auth).expect(200)).body.agents).toBeDefined();

    // Nor can it be chosen in Settings → Integrations.
    const saved = await ctx.http().put(`${org.base}/integrations/ai`).set(owner.auth).send({ apiKey: 'sk-ant-test-key-that-is-long-enough', model: 'claude-opus-5-5', enabled: true }).expect(422);
    expect(saved.body.error).toBe('MODEL_NOT_ALLOWED');
    const card = (await ctx.http().get(`${org.base}/integrations`).set(owner.auth).expect(200)).body.ai;
    expect(card.models.map((x: { id: string; allowed: boolean }) => [x.id, x.allowed])).toEqual([
      ['claude-opus-5-5', false],
      ['claude-sonnet-5-5', true],
      ['claude-haiku-5-5', true],
    ]);
    expect(card.modelInUseAllowed).toBe(false);

    await ctx.http().put(`${A}/models`).set(owner.auth).send({ allowed: [] }).expect(200);
    expect((await ask()).status).toBe('COMPLETE');
  });
});

describe('platform model access', () => {
  it('lets only platform administrators limit the models across Talk2Tax, with a reason', async () => {
    await ctx.http().post('/v1/admin/ai/models').set(owner.auth).send({ allowed: ['claude-haiku-5-5'], reason: 'Cost control for everyone' }).expect(403);
    await ctx.http().post('/v1/admin/ai/models').set(admin.auth).send({ allowed: [], reason: 'Cost control for everyone' }).expect(400);
    await ctx.http().post('/v1/admin/ai/models').set(admin.auth).send({ allowed: ['claude-haiku-5-5'], reason: 'short' }).expect(400);
    const r = (await ctx.http().post('/v1/admin/ai/models').set(admin.auth).send({ allowed: ['claude-haiku-5-5', 'claude-sonnet-5-5'], reason: 'Provider review of the largest model' }).expect(200)).body;
    expect(r.models.limited).toBe(true);
    expect(r.models.history[0]).toMatchObject({ allowed: ['claude-haiku-5-5', 'claude-sonnet-5-5'], reason: 'Provider review of the largest model', by: 'Models Admin' });
    expect(r.models.available.map((m: { id: string; allowed: boolean }) => [m.id, m.allowed])).toEqual([
      ['claude-opus-5-5', false],
      ['claude-sonnet-5-5', true],
      ['claude-haiku-5-5', true],
    ]);
    const audit = await ctx.prisma.auditEvent.findFirst({ where: { action: 'platform.ai_models_changed', entityId: r.models.history[0].id } });
    expect(audit?.data).toMatchObject({ to: ['claude-haiku-5-5', 'claude-sonnet-5-5'], reason: 'Provider review of the largest model' });
    // The history cannot be rewritten.
    await expect(ctx.prisma.platformModelPolicy.update({ where: { id: r.models.history[0].id }, data: { reason: 'Rewritten history' } })).rejects.toThrow();
    await expect(ctx.prisma.platformModelPolicy.delete({ where: { id: r.models.history[0].id } })).rejects.toThrow();
  });

  it('stops every organisation using a model the platform does not allow, and organisations cannot allow it back', async () => {
    const v = (await ctx.http().get(A).set(owner.auth).expect(200)).body.modelAccess;
    expect(v).toMatchObject({ platformLimited: true, inUseAllowed: false });
    expect(v.models.find((m: { id: string }) => m.id === 'claude-opus-5-5')).toMatchObject({ platformAllowed: false, allowed: false });
    const m = await ask();
    expect(m).toMatchObject({ status: 'HTTP 409', errorCode: 'MODEL_NOT_ALLOWED' });
    expect(m.errorMessage).toMatch(/not allowed on Talk2Tax by the people who run it/);
    expect((await ctx.http().put(`${A}/models`).set(owner.auth).send({ allowed: ['claude-opus-5-5'] }).expect(422)).body.error).toBe('MODEL_NOT_ALLOWED');

    // Allowed again: the copilot answers.
    const r = (await ctx.http().post('/v1/admin/ai/models').set(admin.auth).send({ allowed: null, reason: 'Review finished, every model allowed' }).expect(200)).body;
    expect(r.models.limited).toBe(false);
    expect((await ask()).status).toBe('COMPLETE');
  });
});
