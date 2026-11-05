import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CopilotModel, CopilotRequest, CopilotResponse } from '../src/copilot/copilot.model';
import { CopilotService } from '../src/copilot/copilot.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * The voice assistant and its confirmations against the real API and database: questions asked by
 * voice, and actions the assistant can only propose, carried out when the member confirms. The language model is a scripted
 * stand-in: each test says which tools the "model" calls and checks what the copilot
 * actually sends it (instructions, tools, tool results read from real postings, the replayed
 * history). No request leaves the machine, and nothing scripted here is shown to anyone.
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
function reply(content: unknown[], stop_reason: string, model = 'claude-opus-5-5'): CopilotResponse {
  return {
    id: `msg_test_${++n}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 150, cache_creation_input_tokens: 0, cache_read_input_tokens: 800 },
  } as unknown as CopilotResponse;
}
const thinking = (t: string) => ({ type: 'thinking', thinking: t, signature: `sig-${t.length}-${n}` });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const text = (t: string) => ({ type: 'text', text: t, citations: null });
const apiError = <T extends new (...a: never[]) => Error>(Cls: T, status: number, type: string) =>
  new (Cls as unknown as new (s: number, e: unknown, m: string, h: Headers) => Error)(status, { type: 'error', error: { type, message: 'test' } }, `${status} test`, new Headers());

const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso: string, d: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);

let ctx: Ctx;
const model = new ScriptedModel();
let owner: TestUser;
let viewer: TestUser;
let accountant: TestUser;
let stranger: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let C: string;

interface Action { id: string; kind: string; summary: string; sensitive: boolean; status: string; result: { path: string; label: string } | null; error: string | null; messageId: string }
interface Conversation { id: string; messages: { id: string; role: string; status: string; text: string | null; channel: string; sources: { tool: string; ok: boolean; error?: string }[] }[]; actions: Action[] }

const settle = () => Promise.all([...ctx.app.get(CopilotService).inflight.values()]);
const start = async (question: string, auth = owner.auth, channel = 'TEXT') => {
  const c = (await ctx.http().post(`${C}/conversations`).set(auth).send({ question, channel }).expect(201)).body as Conversation;
  await settle();
  return read(c.id, auth);
};
const follow = async (id: string, question: string, auth = owner.auth) => {
  await ctx.http().post(`${C}/conversations/${id}/messages`).set(auth).send({ question }).expect(201);
  await settle();
  return read(id, auth);
};
const read = async (id: string, auth = owner.auth) => (await ctx.http().get(`${C}/conversations/${id}`).set(auth).expect(200)).body as Conversation;
const raw = (sql: string, ...args: unknown[]) =>
  ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
    return tx.$executeRawUnsafe(sql, ...args);
  });
const audit = async (action: string) => (await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, action }, orderBy: { createdAt: 'desc' } })).map((a) => ({ data: a.data as Record<string, unknown> }));
const toolResult = (req: CopilotRequest) => {
  const last = req.messages[req.messages.length - 1] as { content: { type: string; content?: string }[] };
  return JSON.parse(last.content.find((b) => b.type === 'tool_result')!.content!);
};
let alertId: string;
let alertTitle: string;

beforeAll(async () => {
  ctx = await bootApp({}, { copilotModel: model });
  owner = await registerUser(ctx, 'Voice Owner');
  viewer = await registerUser(ctx, 'Voice Viewer');
  accountant = await registerUser(ctx, 'Voice Accountant');
  stranger = await registerUser(ctx, 'Voice Stranger');
  org = await createOrg(ctx, owner, { name: 'Voice Test Pvt Ltd' });
  C = `${org.base}/copilot`;
  for (const [u, role] of [[viewer, 'VIEWER'], [accountant, 'ACCOUNTANT']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  await ctx.http().put(`${C}/settings`).set(owner.auth).send({ enabled: true }).expect(200);
  // A customer invoice well past its due date, so the checks raise an alert.
  const customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Lotus Retail', isCustomer: true }).expect(201)).body.id;
  await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fiscalYearForDate(T, 4) - 1 });
  await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: customer, issueDate: addDays(T, -80), dueDate: addDays(T, -70), post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '80000.00' }] }).expect(201);
  await ctx.http().post(`${org.base}/alerts/scan`).set(owner.auth).expect(200);
  const alerts = (await ctx.http().get(`${org.base}/alerts?status=ACTIVE`).set(owner.auth).expect(200)).body.alerts as { id: string; title: string; status: string; rule: string }[];
  const a = alerts.find((x) => x.rule === 'OVERDUE_RECEIVABLES' && x.status === 'OPEN') ?? alerts.find((x) => x.status === 'OPEN');
  alertId = a!.id;
  alertTitle = a!.title;
});
afterAll(async () => {
  await settle();
  await ctx?.app.close();
});

describe('voice assistant', () => {
  it('records a spoken question as voice and tells the model it was spoken', async () => {
    model.steps.push(() => reply([text('Revenue this month is ₹80,000.00.')], 'end_turn'));
    const c = await start('what is our revenue this month', owner.auth, 'VOICE');
    expect(c.messages[0]).toMatchObject({ role: 'USER', channel: 'VOICE', text: 'what is our revenue this month' });
    expect(c.messages[1]).toMatchObject({ status: 'COMPLETE', channel: 'TEXT' });
    const req = model.requests[model.requests.length - 1];
    const q = (req.messages[0] as { content: { text: string }[] }).content.map((b) => b.text);
    expect(q[q.length - 1]).toBe('(Asked by voice.) what is our revenue this month');
    expect(req.system).toContain('Asked by voice');
    expect((req.tools ?? []).map((t) => (t as { name: string }).name)).toEqual(expect.arrayContaining(['propose_task', 'propose_alert_update']));
    const asked = await audit('copilot.question_asked');
    expect(asked[0]!.data).toMatchObject({ channel: 'VOICE' });
    await ctx.http().post(`${C}/conversations`).set(owner.auth).send({ question: 'x', channel: 'SMOKE' }).expect(400);
  });

  it('only proposes a task; the member confirms it once, and it is created as them', async () => {
    model.steps.push(() => reply([toolUse('t1', 'propose_task', { title: 'Call Lotus Retail about the overdue invoice', description: null, due_date: addDays(T, 2), for_role: null })], 'tool_use'));
    model.steps.push((req) => {
      expect(toolResult(req)).toMatchObject({ proposed: true, done: false, sensitive: false });
      return reply([text('I have proposed the task. Press Confirm on the card to create it.')], 'end_turn');
    });
    const c = await start('remind me to call Lotus Retail in two days', owner.auth, 'VOICE');
    expect(c.actions).toHaveLength(1);
    const a = c.actions[0]!;
    expect(a).toMatchObject({ kind: 'CREATE_TASK', status: 'PROPOSED', sensitive: false, messageId: c.messages[1]!.id });
    expect(a.summary).toBe(`Create a task "Call Lotus Retail about the overdue invoice" for you, due ${addDays(T, 2)}.`);
    // Nothing happened yet.
    let tasks = (await ctx.http().get(`${org.base}/tasks?scope=mine&status=ALL`).set(owner.auth).expect(200)).body;
    expect(JSON.stringify(tasks)).not.toContain('Call Lotus Retail');
    // Only the member who asked can decide it.
    await ctx.http().post(`${C}/actions/${a.id}/confirm`).set(accountant.auth).expect(404);
    await ctx.http().post(`${C}/actions/${a.id}/confirm`).set(stranger.auth).expect(404);
    const done = (await ctx.http().post(`${C}/actions/${a.id}/confirm`).set(owner.auth).expect(200)).body as Action;
    expect(done).toMatchObject({ status: 'DONE', result: { path: '/tasks', label: 'Task "Call Lotus Retail about the overdue invoice"' } });
    tasks = (await ctx.http().get(`${org.base}/tasks?scope=mine&status=ALL`).set(owner.auth).expect(200)).body;
    expect(JSON.stringify(tasks)).toContain('Call Lotus Retail about the overdue invoice');
    // Never twice.
    expect((await ctx.http().post(`${C}/actions/${a.id}/confirm`).set(owner.auth).expect(409)).body.error).toBe('ACTION_DECIDED');
    await ctx.http().post(`${C}/actions/${a.id}/cancel`).set(owner.auth).expect(409);
    await expect(raw(`UPDATE copilot_actions SET status = 'CANCELLED' WHERE id = $1::uuid`, a.id)).rejects.toThrow(/decided assistant action cannot be changed/);
    expect(await audit('copilot.action_confirmed')).toHaveLength(1);
    expect(await audit('copilot.action_proposed')).toHaveLength(1);
  });

  it('a sensitive dismissal is only proposed with the member\'s reason, and cancelling leaves the alert alone', async () => {
    model.steps.push(() => reply([toolUse('a1', 'propose_alert_update', { alert_ref: alertId, action: 'DISMISS', note: null })], 'tool_use'));
    model.steps.push((req) => {
      expect(toolResult(req).error).toMatch(/needs a reason from the member/);
      return reply([text('Why should it be dismissed?')], 'end_turn');
    });
    const c = await start('dismiss the overdue alert');
    expect(c.actions).toHaveLength(0);
    model.steps.push(() => reply([toolUse('a2', 'propose_alert_update', { alert_ref: alertId, action: 'DISMISS', note: 'Customer paid by cheque, not yet banked' })], 'tool_use'));
    model.steps.push(() => reply([text('Proposed. Confirm on the card.')], 'end_turn'));
    const c2 = await follow(c.id, 'they paid by cheque, not yet banked');
    const a = c2.actions[0]!;
    expect(a).toMatchObject({ kind: 'DISMISS_ALERT', sensitive: true, status: 'PROPOSED' });
    expect(a.summary).toContain(`Dismiss the alert "${alertTitle}"`);
    expect((await ctx.http().post(`${C}/actions/${a.id}/cancel`).set(owner.auth).expect(200)).body.status).toBe('CANCELLED');
    const alert = (await ctx.http().get(`${org.base}/alerts/${alertId}`).set(owner.auth).expect(200)).body;
    expect(alert.status).toBe('OPEN');
    // The next question tells the model what became of it.
    model.steps.push(() => reply([text('Noted.')], 'end_turn'));
    await follow(c.id, 'ok');
    const req = model.requests[model.requests.length - 1];
    const q = (req.messages[req.messages.length - 1] as { content: { text: string }[] }).content.map((b) => b.text).join('\n');
    expect(q).toContain('Status: CANCELLED');
  });

  it('an expired proposal cannot be confirmed and changes nothing', async () => {
    model.steps.push(() => reply([toolUse('a3', 'propose_alert_update', { alert_ref: alertId, action: 'ACKNOWLEDGE', note: 'Looking into it' })], 'tool_use'));
    model.steps.push(() => reply([text('Proposed.')], 'end_turn'));
    const c = await start('acknowledge the overdue alert');
    const a = c.actions[0]!;
    expect(a.summary).toBe(`Acknowledge the alert "${alertTitle}" with the note "Looking into it".`);
    await raw(`UPDATE copilot_actions SET expires_at = now() - interval '1 minute' WHERE id = $1::uuid`, a.id);
    expect((await read(c.id)).actions[0]!.status).toBe('EXPIRED');
    const r = (await ctx.http().post(`${C}/actions/${a.id}/confirm`).set(owner.auth).expect(200)).body as Action;
    expect(r).toMatchObject({ status: 'EXPIRED', error: 'This proposal expired after 15 minutes. Ask again if you still want it.' });
    // Recorded as expired for good.
    await ctx.http().post(`${C}/actions/${a.id}/confirm`).set(owner.auth).expect(409);
    expect((await ctx.http().get(`${org.base}/alerts/${alertId}`).set(owner.auth).expect(200)).body.status).toBe('OPEN');
  });

  it('confirming acknowledges the alert; a change in the meantime fails cleanly', async () => {
    model.steps.push(() => reply([toolUse('a4', 'propose_alert_update', { alert_ref: alertId, action: 'ACKNOWLEDGE', note: null })], 'tool_use'));
    model.steps.push(() => reply([toolUse('a5', 'propose_alert_update', { alert_ref: alertId, action: 'ACKNOWLEDGE', note: 'second' })], 'tool_use'));
    model.steps.push(() => reply([text('Two proposals.')], 'end_turn'));
    const c = await start('acknowledge it');
    const [first, second] = c.actions;
    expect((await ctx.http().post(`${C}/actions/${first!.id}/confirm`).set(owner.auth).expect(200)).body).toMatchObject({ status: 'DONE', result: { path: '/alerts' } });
    expect((await ctx.http().get(`${org.base}/alerts/${alertId}`).set(owner.auth).expect(200)).body.status).toBe('ACKNOWLEDGED');
    const failed = (await ctx.http().post(`${C}/actions/${second!.id}/confirm`).set(owner.auth).expect(200)).body as Action;
    expect(failed).toMatchObject({ status: 'FAILED' });
    expect(failed.error).toMatch(/Only an open alert can be acknowledged/);
  });

  it('never proposes what the member may not do', async () => {
    model.steps.push(() => reply([toolUse('v1', 'propose_alert_update', { alert_ref: alertId, action: 'DISMISS', note: 'not needed' })], 'tool_use'));
    model.steps.push((req) => {
      expect(toolResult(req).error).toBe('This member does not have access to these figures');
      return reply([text('You cannot change alerts.')], 'end_turn');
    });
    const c = await start('dismiss that alert', viewer.auth, 'VOICE');
    expect(c.actions).toHaveLength(0);
    expect(c.messages[1]!.sources[0]).toMatchObject({ tool: 'propose_alert_update', ok: false });
  });
});
