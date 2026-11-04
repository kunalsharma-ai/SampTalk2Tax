import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CloseService } from '../src/close/close.service';
import { CollectionsService } from '../src/collections/collections.service';
import type { CopilotModel, CopilotRequest, CopilotResponse } from '../src/copilot/copilot.model';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * The AI control center against the real API and database: per-agent switches and monthly
 * token budgets that every agent checks before each model call, the emergency stop (which
 * also stops work already running), resuming, and acceptance rates worked out from what
 * people did with each agent's proposals. The language model is a scripted stand-in.
 */
type Step = (req: CopilotRequest) => CopilotResponse | Promise<CopilotResponse>;
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
const reply = (content: unknown[]) =>
  ({ id: `msg_a_${++n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 900, output_tokens: 250, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) as unknown as CopilotResponse;
const reminder = (name: string) => reply([{ type: 'tool_use', id: `tu_${n}`, name: 'submit_reminder', input: { risk: 'LOW', riskReasons: ['Overdue'], subject: `Reminder for ${name}`, body: `Dear ${name},\n\nPlease pay what is overdue.\n\nAccounts team` } }]);

const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso: string, d: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
const shift = (month: string, by: number) => {
  const m = +month.slice(5, 7) - 1 + by;
  return `${+month.slice(0, 4) + Math.floor(m / 12)}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
};

let ctx: Ctx;
let bare: Ctx;
const model = new ScriptedModel();
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let A: string;
const c: Record<string, string> = {};

interface Agent {
  key: string;
  name: string;
  level: number;
  levelLabel: string;
  approval: string | null;
  enabled: boolean;
  monthlyTokenLimit: number | null;
  usage: { calls: number; inputTokens: number; outputTokens: number; tokens: number; failed: number; percentOfBudget: number | null };
  budgetReached: boolean;
  accuracy: { accepted: number; acceptedWithEdits: number; rejected: number; waiting: number; rate: number | null } | null;
  running: number;
  changedBy: string | null;
}
interface Overview {
  configured: boolean;
  enabled: boolean;
  stopped: boolean;
  offReason: string | null;
  changedBy: string | null;
  canManage: boolean;
  totals: { calls: number; tokens: number; failed: number; running: number; waiting: number };
  agents: Agent[];
}

const settle = () => Promise.all([...ctx.app.get(CollectionsService).inflight.values(), ...ctx.app.get(CloseService).inflight.values()]);
const overview = async (who: TestUser = owner, base = A) => (await ctx.http().get(base).set(who.auth).expect(200)).body as Overview;
const agent = (o: Overview, key: string) => o.agents.find((a) => a.key === key)!;
const setAgent = (key: string, body: Record<string, unknown>, who: TestUser = owner) => ctx.http().put(`${A}/agents/${key}`).set(who.auth).send(body);
const draftReminders = () => ctx.http().post(`${org.base}/collections/runs`).set(owner.auth);
const reminders = async () => (await ctx.http().get(`${org.base}/collections/reminders`).set(owner.auth).expect(200)).body as { id: string; customer: string; status: string; errorCode: string | null; errorMessage: string | null }[];
const audits = async (prefix = 'ai.') => (await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, action: { startsWith: prefix } }, orderBy: { createdAt: 'asc' } })).map((a) => ({ action: a.action, data: a.data as Record<string, unknown> }));

beforeAll(async () => {
  ctx = await bootApp({}, { copilotModel: model });
  bare = await bootApp();
  owner = await registerUser(ctx, 'Control Owner');
  accountant = await registerUser(ctx, 'Control Accountant');
  viewer = await registerUser(ctx, 'Control Viewer');
  outsider = await registerUser(ctx, 'Other Owner');
  org = await createOrg(ctx, owner, { name: 'Control Center Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Someone Else Ltd' });
  A = `${org.base}/ai-control`;
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  // Two customers with overdue invoices; Anchor is the more overdue, so it is drafted first.
  for (const [name, email, amount, due] of [['Anchor Foods', 'ap@anchor.test', '40000.00', -30], ['Birch Hardware', 'pay@birch.test', '15000.00', -8]] as const) {
    c[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, isCustomer: true, email }).expect(201)).body.id;
    await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: c[name], issueDate: addDays(T, due - 15), dueDate: addDays(T, due), post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] }).expect(201);
  }
});
afterAll(async () => {
  await settle();
  await ctx?.app.close();
  await bare?.app.close();
});

describe('AI control center', () => {
  it('lists every agent with its action level, on and without a budget, while AI is off for the organisation', async () => {
    const o = await overview();
    expect(o).toMatchObject({ configured: true, enabled: false, stopped: false, offReason: null, canManage: true, totals: { calls: 0, tokens: 0, failed: 0, running: 0, waiting: 0 } });
    expect(o.agents.map((a) => [a.key, a.level, a.levelLabel])).toEqual([
      ['COPILOT', 0, 'Read-only analysis'],
      ['COLLECTIONS', 2, 'Prepare changes for approval'],
      ['BANKING', 2, 'Prepare changes for approval'],
      ['CLOSE', 2, 'Prepare changes for approval'],
      ['CFO', 1, 'Draft recommendations'],
    ]);
    for (const a of o.agents) expect(a).toMatchObject({ enabled: true, monthlyTokenLimit: null, budgetReached: false, running: 0, changedBy: null });
    expect(agent(o, 'COPILOT').accuracy).toBeNull();
    expect(agent(o, 'COLLECTIONS').approval).toContain('A person sends, edits or rejects');
    expect((await bare.http().get(A).set(owner.auth).expect(200)).body.configured).toBe(false);
  });

  it('lets accountants look but only owners and admins change anything; viewers and other organisations see nothing', async () => {
    expect((await overview(accountant)).canManage).toBe(false);
    await setAgent('COLLECTIONS', { enabled: false, monthlyTokenLimit: null }, accountant).expect(403);
    await ctx.http().post(`${A}/stop`).set(accountant.auth).send({ reason: 'Accountants cannot do this' }).expect(403);
    await ctx.http().get(A).set(viewer.auth).expect(403);
    await ctx.http().get(A).set(outsider.auth).expect(404);
    await setAgent('ROBOT', { enabled: true, monthlyTokenLimit: null }).expect(400);
    await setAgent('COLLECTIONS', { enabled: true, monthlyTokenLimit: 500 }).expect(400);
    await setAgent('COLLECTIONS', { enabled: true, monthlyTokenLimit: 1500.5 }).expect(400);
    await ctx.http().post(`${A}/stop`).set(owner.auth).send({ reason: 'short' }).expect(400);
  });

  it('refuses to start an agent that is switched off, before anything is sent to the AI provider', async () => {
    await ctx.http().put(`${org.base}/copilot/settings`).set(owner.auth).send({ enabled: true }).expect(200);
    const o = (await setAgent('COLLECTIONS', { enabled: false, monthlyTokenLimit: null }).expect(200)).body as Overview;
    expect(agent(o, 'COLLECTIONS')).toMatchObject({ enabled: false, changedBy: 'Control Owner' });
    const r = await draftReminders().expect(409);
    expect((await ctx.http().get(`${org.base}/collections`).set(owner.auth).expect(200)).body.aiNotice).toMatchObject({ code: 'AGENT_OFF' });
    expect(r.body).toMatchObject({ error: 'AGENT_OFF', message: 'The collections agent is turned off in the AI control center.' });
    expect(model.requests).toHaveLength(0);
    await setAgent('COLLECTIONS', { enabled: true, monthlyTokenLimit: null }).expect(200);
    expect(await audits()).toEqual([
      { action: 'ai.agent_updated', data: { agent: 'COLLECTIONS', from: { enabled: true, monthlyTokenLimit: null }, to: { enabled: false, monthlyTokenLimit: null } } },
      { action: 'ai.agent_updated', data: { agent: 'COLLECTIONS', from: { enabled: false, monthlyTokenLimit: null }, to: { enabled: true, monthlyTokenLimit: null } } },
    ]);
  });

  it('stops an agent when it reaches its monthly token budget, even part-way through a run', async () => {
    await setAgent('COLLECTIONS', { enabled: true, monthlyTokenLimit: 1000 }).expect(200);
    model.steps.push(() => reminder('Anchor Foods'));
    await draftReminders().expect(201);
    await settle();
    // Anchor's draft used 1,150 tokens, over the budget of 1,000, so Birch's was never sent to the model.
    expect(model.requests).toHaveLength(1);
    const rs = await reminders();
    expect(rs.find((r) => r.customer === 'Anchor Foods')).toMatchObject({ status: 'READY' });
    const birch = rs.find((r) => r.customer === 'Birch Hardware')!;
    expect(birch).toMatchObject({ status: 'FAILED', errorCode: 'AI_BUDGET_REACHED' });
    expect(birch.errorMessage).toBe('Not done: The collections agent has used its 1,000 tokens for this month. An owner or admin can raise the budget in the AI control center.');

    const o = await overview();
    expect(agent(o, 'COLLECTIONS')).toMatchObject({ monthlyTokenLimit: 1000, budgetReached: true, usage: { calls: 2, inputTokens: 900, outputTokens: 250, tokens: 1150, failed: 1, percentOfBudget: 100 } });
    expect(o.totals).toMatchObject({ calls: 2, tokens: 1150, failed: 1, waiting: 1 });
    expect((await draftReminders().expect(429)).body.error).toBe('AI_BUDGET_REACHED');
    // Each organisation's usage is its own.
    const theirs = await overview(outsider, `${other.base}/ai-control`);
    expect(theirs.totals.tokens).toBe(0);

    // Raising the budget lets it run again.
    expect(agent((await setAgent('COLLECTIONS', { enabled: true, monthlyTokenLimit: 50_000 }).expect(200)).body, 'COLLECTIONS')).toMatchObject({ budgetReached: false, usage: { percentOfBudget: 2.3 } });
    await setAgent('COLLECTIONS', { enabled: true, monthlyTokenLimit: null }).expect(200);
  });

  it('works out how often people accept what an agent proposes', async () => {
    const anchor = (await reminders()).find((r) => r.customer === 'Anchor Foods')!;
    await ctx.http().post(`${org.base}/collections/reminders/${anchor.id}/reject`).set(owner.auth).send({ note: 'Called them instead' }).expect(200);
    const o = await overview();
    expect(agent(o, 'COLLECTIONS').accuracy).toEqual({ accepted: 0, acceptedWithEdits: 0, rejected: 1, waiting: 0, rate: 0 });
    expect(agent(o, 'BANKING').accuracy).toEqual({ accepted: 0, acceptedWithEdits: 0, rejected: 0, waiting: 0, rate: null });
  });

  it('the emergency stop turns AI off at once and stops a run part-way, with the reason shown everywhere', async () => {
    // While Anchor's reminder is being drafted, the owner presses the emergency stop.
    model.steps.push(async () => {
      await ctx.http().post(`${A}/stop`).set(owner.auth).send({ reason: 'Wrong figures were sent in a reminder' }).expect(200);
      return reminder('Anchor Foods');
    });
    await draftReminders().expect(201);
    await settle();
    expect(model.requests).toHaveLength(2);
    const rs = await reminders();
    const birch = rs.find((r) => r.customer === 'Birch Hardware' && r.status === 'FAILED' && r.errorCode === 'AI_STOPPED')!;
    expect(birch.errorMessage).toBe('Not done: AI was stopped for this organisation: Wrong figures were sent in a reminder. An owner or admin can turn it back on in the AI control center.');

    const o = await overview();
    expect(o).toMatchObject({ enabled: false, stopped: true, offReason: 'Wrong figures were sent in a reminder', changedBy: 'Control Owner' });
    const stop = (await audits()).find((a) => a.action === 'ai.emergency_stop')!;
    expect(stop.data).toMatchObject({ reason: 'Wrong figures were sent in a reminder', wasOn: true, running: 2 });
    expect((await draftReminders().expect(409)).body.message).toContain('AI was stopped for this organisation: Wrong figures were sent in a reminder');
    const q = await ctx.http().post(`${org.base}/copilot/conversations`).set(owner.auth).send({ question: 'What is my cash balance?' }).expect(409);
    expect(q.body).toMatchObject({ error: 'COPILOT_OFF' });
    expect(q.body.message).toContain('Wrong figures were sent in a reminder');
    expect((await ctx.http().post(`${A}/stop`).set(owner.auth).send({ reason: 'Pressed it a second time' }).expect(409)).body.error).toBe('AI_ALREADY_STOPPED');
    // Each agent's own page says why, from the control center.
    expect((await ctx.http().get(`${org.base}/collections`).set(owner.auth).expect(200)).body.aiNotice).toMatchObject({ code: 'AI_OFF', message: expect.stringContaining('Wrong figures were sent in a reminder') });
    expect((await ctx.http().get(`${org.base}/copilot/status`).set(owner.auth).expect(200)).body.notice).toMatchObject({ code: 'AI_OFF' });
    expect(model.requests).toHaveLength(2);
  });

  it('turning AI back on clears the stop', async () => {
    const o = (await ctx.http().post(`${A}/resume`).set(owner.auth).expect(200)).body as Overview;
    expect(o).toMatchObject({ enabled: true, stopped: false, offReason: null });
    expect((await audits()).at(-1)).toEqual({ action: 'ai.resumed', data: { stoppedFor: 'Wrong figures were sent in a reminder' } });
    expect((await ctx.http().post(`${A}/resume`).set(owner.auth).expect(409)).body.error).toBe('AI_ALREADY_ON');
    // A stop followed by turning AI on from the copilot settings also clears the reason.
    await ctx.http().post(`${A}/stop`).set(owner.auth).send({ reason: 'Checking the switch works' }).expect(200);
    await ctx.http().put(`${org.base}/copilot/settings`).set(owner.auth).send({ enabled: true }).expect(200);
    expect(await overview()).toMatchObject({ enabled: true, stopped: false, offReason: null });
  });

  it('a stop while the close agent is reviewing a month keeps the usage but shows nothing it proposed', async () => {
    const M = shift(T.slice(0, 7), -1);
    await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fiscalYearForDate(`${M}-01`, 4) });
    const periods = (await ctx.http().get(`${org.base}/periods`).set(owner.auth).expect(200)).body as { id: string; startDate: string }[];
    const periodId = periods.find((p) => p.startDate === `${M}-01`)!.id;
    await ctx.http().post(`${org.base}/close/${periodId}/start`).set(owner.auth).expect(200);
    model.steps.push(async () => {
      await ctx.http().post(`${A}/stop`).set(owner.auth).send({ reason: 'Stopping during the month review' }).expect(200);
      return reply([{ type: 'tool_use', id: 'tu_close', name: 'submit_close_review', input: { summary: 'Rent is missing.', findings: [], adjustments: [{ description: 'Accrue rent', reason: 'Monthly rent', confidence: 'HIGH', reverseNextPeriod: true, lines: [{ accountCode: '6200', debit: '1000.00' }, { accountCode: '2200', credit: '1000.00' }] }] } }]);
    });
    await ctx.http().post(`${org.base}/close/${periodId}/reviews`).set(owner.auth).expect(201);
    await settle();
    const v = (await ctx.http().get(`${org.base}/close/${periodId}`).set(owner.auth).expect(200)).body;
    expect(v.review).toMatchObject({ status: 'FAILED', errorCode: 'AI_STOPPED', inputTokens: 900 });
    expect(v.adjustments).toEqual([]);
    expect(agent(await overview(), 'CLOSE').usage).toMatchObject({ calls: 1, tokens: 1150, failed: 1 });
    await ctx.http().post(`${A}/resume`).set(owner.auth).expect(200);
  });
});
