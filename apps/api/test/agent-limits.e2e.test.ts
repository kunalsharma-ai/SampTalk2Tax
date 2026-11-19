import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CopilotModel, CopilotRequest, CopilotResponse } from '../src/copilot/copilot.model';
import { CopilotService } from '../src/copilot/copilot.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Agent execution limits (SEC-037) against the real API and database, with a scripted stand-in
 * for the model: each agent may start a limited number of AI tasks in any 60 minutes, by the
 * server's default or the organisation's own limit; new work over the limit is refused before
 * anything is sent, while work already running finishes its steps.
 */
class ScriptedModel implements CopilotModel {
  readonly provider = 'Test stand-in';
  requests: CopilotRequest[] = [];
  steps: ((req: CopilotRequest) => CopilotResponse)[] = [];
  async send(req: CopilotRequest): Promise<CopilotResponse> {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift();
    if (step) return step(req);
    return reply([{ type: 'text', text: 'Answered.', citations: null }], 'end_turn');
  }
}
let n = 0;
const reply = (content: unknown[], stop_reason: string) =>
  ({ id: `msg_l_${++n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) as unknown as CopilotResponse;

let ctx: Ctx;
const model = new ScriptedModel();
let owner: TestUser;
let accountant: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let A: string;
const settle = () => Promise.all([...ctx.app.get(CopilotService).inflight.values()]);
const ask = (question = 'How are we doing?') => ctx.http().post(`${org.base}/copilot/conversations`).set(owner.auth).send({ question });
type Agent = { key: string; hourlyTaskLimit: number | null; tasksPerHour: { limit: number | null; own: boolean; started: number; reached: boolean } };
const copilot = async () => ((await ctx.http().get(A).set(owner.auth).expect(200)).body.agents as Agent[]).find((a) => a.key === 'COPILOT')!;

beforeAll(async () => {
  ctx = await bootApp({ AI_AGENT_TASKS_PER_HOUR: '2' }, { copilotModel: model });
  owner = await registerUser(ctx, 'Limits Owner');
  accountant = await registerUser(ctx, 'Limits Accountant');
  org = await createOrg(ctx, owner, { name: 'Steady Pace Pvt Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: accountant.email, role: 'ACCOUNTANT' }).expect(201);
  A = `${org.base}/ai-control`;
  await ctx.http().put(`${org.base}/copilot/settings`).set(owner.auth).send({ enabled: true }).expect(200);
});
afterAll(async () => {
  await settle();
  await ctx?.app.close();
});

describe('agent execution limits (SEC-037)', () => {
  it('limits the AI tasks an agent starts in an hour to the server default', async () => {
    expect((await copilot()).tasksPerHour).toEqual({ limit: 2, own: false, started: 0, reached: false });
    // The first answer reads a report in a second step: work already running is not cut off by its own count.
    model.steps.push(
      () => reply([{ type: 'tool_use', id: 'tu_1', name: 'get_kpis', input: { as_of: null } }], 'tool_use'),
      () => reply([{ type: 'text', text: 'KPIs read.', citations: null }], 'end_turn'),
    );
    await ask('What are our KPIs?').expect(201);
    await settle();
    await ask().expect(201);
    await settle();
    expect((await copilot()).tasksPerHour).toEqual({ limit: 2, own: false, started: 2, reached: true });
    const before = model.requests.length;
    const refused = await ask().expect(429);
    expect(refused.body).toMatchObject({ error: 'AI_TASK_LIMIT', message: expect.stringMatching(/started its 2 AI tasks for the last hour/) });
    expect(model.requests.length).toBe(before);
    expect(model.requests.length).toBe(3);
    // The copilot page says so before anyone asks.
    expect((await ctx.http().get(`${org.base}/copilot/status`).set(owner.auth).expect(200)).body.notice).toMatchObject({ code: 'AI_TASK_LIMIT' });
  });

  it('lets owners and admins set an agent its own limit, audited', async () => {
    await ctx.http().put(`${A}/agents/COPILOT`).set(accountant.auth).send({ enabled: true, monthlyTokenLimit: null, hourlyTaskLimit: 10 }).expect(403);
    await ctx.http().put(`${A}/agents/COPILOT`).set(owner.auth).send({ enabled: true, monthlyTokenLimit: null, hourlyTaskLimit: 0 }).expect(400);
    await ctx.http().put(`${A}/agents/COPILOT`).set(owner.auth).send({ enabled: true, monthlyTokenLimit: null, hourlyTaskLimit: 3 }).expect(200);
    expect((await copilot())).toMatchObject({ hourlyTaskLimit: 3, tasksPerHour: { limit: 3, own: true, started: 2, reached: false } });
    await ask().expect(201);
    await settle();
    expect((await ask().expect(429)).body.error).toBe('AI_TASK_LIMIT');
    // Saving without the field keeps the limit (older clients only send the switch and budget).
    await ctx.http().put(`${A}/agents/COPILOT`).set(owner.auth).send({ enabled: true, monthlyTokenLimit: 50_000 }).expect(200);
    expect((await copilot()).hourlyTaskLimit).toBe(3);
    const audit = await ctx.prisma.auditEvent.findFirst({ where: { orgId: org.orgId, action: 'ai.agent_updated' }, orderBy: { createdAt: 'asc' } });
    expect(audit?.data).toMatchObject({ agent: 'COPILOT', from: { hourlyTaskLimit: null }, to: { hourlyTaskLimit: 3 } });
    // Back to the server's default.
    await ctx.http().put(`${A}/agents/COPILOT`).set(owner.auth).send({ enabled: true, monthlyTokenLimit: null, hourlyTaskLimit: null }).expect(200);
    expect((await copilot()).tasksPerHour).toMatchObject({ limit: 2, own: false, reached: true });
  });

  it('counts each agent on its own', async () => {
    const agents = (await ctx.http().get(A).set(owner.auth).expect(200)).body.agents as Agent[];
    expect(agents.find((a) => a.key === 'COLLECTIONS')!.tasksPerHour).toEqual({ limit: 2, own: false, started: 0, reached: false });
  });
});
