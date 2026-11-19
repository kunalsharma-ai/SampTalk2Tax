import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../src/admin/admin.service';
import { AiControlService } from '../src/ai-control/ai-control.service';
import type { CopilotModel, CopilotRequest, CopilotResponse } from '../src/copilot/copilot.model';
import { CopilotService } from '../src/copilot/copilot.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * AI safety controls against the real API and database, with a scripted stand-in for the model:
 * copilot tool permissions (SEC-030), where tools an owner or admin turns off are never offered to
 * the model and are refused if it asks for them anyway, and the platform-wide AI emergency
 * shutdown (SEC-038), which stops every organisation's agents before any model call.
 */
type Step = (req: CopilotRequest) => CopilotResponse;
class ScriptedModel implements CopilotModel {
  readonly provider = 'Test stand-in';
  requests: CopilotRequest[] = [];
  steps: Step[] = [];
  async send(req: CopilotRequest): Promise<CopilotResponse> {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift();
    if (!step) throw new Error('The test did not script this step');
    return step(req);
  }
}
let n = 0;
const reply = (content: unknown[], stop_reason: string) =>
  ({ id: `msg_s_${++n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) as unknown as CopilotResponse;
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const text = (t: string) => ({ type: 'text', text: t, citations: null });

let ctx: Ctx;
const model = new ScriptedModel();
let admin: TestUser;
let support: TestUser;
let owner: TestUser;
let accountant: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let C: string;
const settle = () => Promise.all([...ctx.app.get(CopilotService).inflight.values()]);
type Conversation = { id: string; messages: { role: string; status: string; text: string | null; errorCode: string | null; errorMessage: string | null; sources: { tool: string; ok: boolean; error?: string }[] }[] };
const ask = async (question: string, status = 201) => (await ctx.http().post(`${C}/conversations`).set(owner.auth).send({ question }).expect(status)).body as Conversation;
const read = async (id: string) => (await ctx.http().get(`${C}/conversations/${id}`).set(owner.auth).expect(200)).body as Conversation;
const resumeIfStopped = async () => {
  const svc = ctx.app.get(AiControlService);
  if (await svc.platformShutdown()) await svc.platformResume({ id: admin.id }, 'Test clean-up after a stop');
};

beforeAll(async () => {
  ctx = await bootApp({}, { copilotModel: model });
  admin = await registerUser(ctx, 'Safety Admin');
  support = await registerUser(ctx, 'Safety Support');
  owner = await registerUser(ctx, 'Safety Owner');
  accountant = await registerUser(ctx, 'Safety Accountant');
  await ctx.app.get(AdminService).grant(admin.email, 'SUPER_ADMIN');
  await ctx.app.get(AdminService).grant(support.email, 'SUPPORT');
  await resumeIfStopped();
  org = await createOrg(ctx, owner, { name: 'Safety First Pvt Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: accountant.email, role: 'ACCOUNTANT' }).expect(201);
  C = `${org.base}/copilot`;
  await ctx.http().put(`${C}/settings`).set(owner.auth).send({ enabled: true }).expect(200);
});
afterAll(async () => {
  await settle();
  await resumeIfStopped();
  await ctx?.app.close();
});

describe('copilot tool permissions (SEC-030)', () => {
  it('lists every tool with what it needs, all on to start with', async () => {
    const s = (await ctx.http().get(`${C}/status`).set(accountant.auth).expect(200)).body;
    expect(s.disabledTools).toEqual([]);
    expect(s.toolCatalog.find((t: { name: string }) => t.name === 'get_balance_sheet')).toEqual({ name: 'get_balance_sheet', title: 'Balance sheet', permission: 'reports.read', enabled: true, youCanUse: true });
  });

  it('lets only owners and admins turn tools off, and only real tools', async () => {
    await ctx.http().put(`${C}/tools`).set(accountant.auth).send({ disabled: ['get_balance_sheet'] }).expect(403);
    expect((await ctx.http().put(`${C}/tools`).set(owner.auth).send({ disabled: ['delete_everything'] }).expect(422)).body.error).toBe('UNKNOWN_TOOL');
    const s = (await ctx.http().put(`${C}/tools`).set(owner.auth).send({ disabled: ['get_trial_balance', 'get_balance_sheet', 'get_balance_sheet'] }).expect(200)).body;
    expect(s.disabledTools).toEqual(['get_balance_sheet', 'get_trial_balance']);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, action: 'copilot.tools_changed' } });
    expect(audit.map((a) => a.data)).toEqual([{ from: [], to: ['get_balance_sheet', 'get_trial_balance'] }]);
  });

  it('never offers a tool that is off, and refuses it when the model asks anyway', async () => {
    model.steps.push(
      () => reply([toolUse('tu_1', 'get_balance_sheet', { as_of: null }), toolUse('tu_2', 'get_dashboard', { as_of: null })], 'tool_use'),
      () => reply([text('The balance sheet tool is turned off; here is the dashboard.')], 'end_turn'),
    );
    const c = await ask('What are our assets?');
    await settle();
    const a = (await read(c.id)).messages.at(-1)!;
    expect(a.status).toBe('COMPLETE');
    const offered = model.requests[0]!.tools!.map((t) => (t as { name: string }).name);
    expect(offered).not.toContain('get_balance_sheet');
    expect(offered).not.toContain('get_trial_balance');
    expect(offered).toContain('get_dashboard');
    expect(a.sources.map((s) => [s.tool, s.ok, s.error ?? null])).toEqual([
      ['get_balance_sheet', false, 'This tool is turned off for this organisation in the AI control center'],
      ['get_dashboard', true, null],
    ]);
    const results = model.requests[1]!.messages.at(-1)!.content as { tool_use_id: string; is_error?: boolean; content: string }[];
    expect(results[0]).toMatchObject({ tool_use_id: 'tu_1', is_error: true });
    expect(results[0]!.content).toContain('turned off');
    await ctx.http().put(`${C}/tools`).set(owner.auth).send({ disabled: [] }).expect(200);
  });
});

describe('platform-wide AI emergency shutdown (SEC-038)', () => {
  it('only platform administrators stop and resume it, with a reason', async () => {
    await ctx.http().get('/v1/admin/ai').set(owner.auth).expect(403);
    expect((await ctx.http().get('/v1/admin/ai').set(support.auth).expect(200)).body).toMatchObject({ stopped: false, reason: null });
    await ctx.http().post('/v1/admin/ai/stop').set(support.auth).send({ reason: 'Support cannot stop AI' }).expect(403);
    await ctx.http().post('/v1/admin/ai/stop').set(admin.auth).send({ reason: 'short' }).expect(400);
    await ctx.http().post('/v1/admin/ai/resume').set(admin.auth).send({ reason: 'Nothing is stopped yet' }).expect(409);
  });

  it('stops every organisation before any model call, and shows why', async () => {
    const s = (await ctx.http().post('/v1/admin/ai/stop').set(admin.auth).send({ reason: 'Provider incident under investigation' }).expect(200)).body;
    expect(s).toMatchObject({ stopped: true, reason: 'Provider incident under investigation' });
    expect(s.history[0]).toMatchObject({ action: 'STOPPED', by: 'Safety Admin' });
    await ctx.http().post('/v1/admin/ai/stop').set(admin.auth).send({ reason: 'Stopping a second time' }).expect(409);
    const before = model.requests.length;
    const r = (await ctx.http().post(`${C}/conversations`).set(owner.auth).send({ question: 'What is our cash?' }).expect(503)).body;
    expect(r.error).toBe('AI_SHUTDOWN');
    expect(r.message).toContain('AI is stopped across Talk2Tax by the people who run it: Provider incident under investigation');
    expect(model.requests.length).toBe(before);
    const o = (await ctx.http().get(`${org.base}/ai-control`).set(owner.auth).expect(200)).body;
    expect(o.platformShutdown).toMatchObject({ reason: 'Provider incident under investigation' });
    expect((await ctx.http().get(`${C}/status`).set(owner.auth).expect(200)).body.notice).toMatchObject({ code: 'AI_SHUTDOWN' });
    // An organisation's own resume does not lift it.
    expect((await ctx.app.get(AiControlService).check(org.orgId, 'COPILOT'))?.code).toBe('AI_SHUTDOWN');
  });

  it('resumes, keeps the history, and audits both', async () => {
    const s = (await ctx.http().post('/v1/admin/ai/resume').set(admin.auth).send({ reason: 'Provider confirmed the incident is over' }).expect(200)).body;
    expect(s).toMatchObject({ stopped: false, reason: null });
    expect(s.history.slice(0, 2).map((h: { action: string; reason: string }) => `${h.action} ${h.reason}`)).toEqual(['RESUMED Provider confirmed the incident is over', 'STOPPED Provider incident under investigation']);
    model.steps.push(() => reply([text('Cash is fine.')], 'end_turn'));
    await ask('What is our cash?');
    await settle();
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: null, action: { in: ['platform.ai_stopped', 'platform.ai_resumed'] }, actorId: admin.id }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['platform.ai_stopped', 'platform.ai_resumed']);
    await expect(ctx.prisma.platformAiSwitch.update({ where: { id: s.history[0].id }, data: { reason: 'Rewritten history' } })).rejects.toThrow();
    await expect(ctx.prisma.platformAiSwitch.delete({ where: { id: s.history[0].id } })).rejects.toThrow();
  });
});
