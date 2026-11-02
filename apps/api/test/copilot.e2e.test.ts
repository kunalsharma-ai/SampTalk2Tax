import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CopilotModel, CopilotRequest, CopilotResponse } from '../src/copilot/copilot.model';
import { CopilotService, QUESTIONS_PER_HOUR } from '../src/copilot/copilot.service';
import { TOOLSET_VERSION } from '../src/copilot/copilot.tools';
import { startAnthropicStandIn } from '../../../test-support/anthropic-stand-in.mjs';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * The AI copilot against the real API and database. The language model is a scripted
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
let bare: Ctx;
const model = new ScriptedModel();
let owner: TestUser;
let viewer: TestUser;
let approver: TestUser;
let employee: TestUser;
let stranger: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let C: string;

interface Message {
  id: string;
  role: 'USER' | 'ASSISTANT';
  status: string;
  text: string | null;
  sources: { tool: string; label: string; path: string; ok: boolean; error?: string; input: Record<string, unknown> }[];
  errorCode: string | null;
  errorMessage: string | null;
  servedModel: string | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } | null;
}
interface Conversation {
  id: string;
  title: string;
  closed: boolean;
  messages: Message[];
}

const settle = () => Promise.all([...ctx.app.get(CopilotService).inflight.values()]);
const start = async (question: string, auth = owner.auth, expectStatus = 201) => (await ctx.http().post(`${C}/conversations`).set(auth).send({ question }).expect(expectStatus)).body as Conversation;
const follow = async (id: string, question: string, auth = owner.auth, expectStatus = 201) => (await ctx.http().post(`${C}/conversations/${id}/messages`).set(auth).send({ question }).expect(expectStatus)).body as Conversation;
const read = async (id: string, auth = owner.auth) => (await ctx.http().get(`${C}/conversations/${id}`).set(auth).expect(200)).body as Conversation;
const lastAnswer = (c: Conversation) => c.messages[c.messages.length - 1];
const raw = (sql: string, ...args: unknown[]) =>
  ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
    return tx.$executeRawUnsafe(sql, ...args);
  });

beforeAll(async () => {
  ctx = await bootApp({ COPILOT_MAX_TOOL_ROUNDS: '3' }, { copilotModel: model });
  bare = await bootApp();
  owner = await registerUser(ctx, 'Copilot Owner');
  viewer = await registerUser(ctx, 'Copilot Viewer');
  approver = await registerUser(ctx, 'Copilot Approver');
  employee = await registerUser(ctx, 'Copilot Employee');
  stranger = await registerUser(ctx, 'Copilot Stranger');
  org = await createOrg(ctx, owner, { name: 'Copilot Test Pvt Ltd' });
  C = `${org.base}/copilot`;
  for (const [u, role] of [[viewer, 'VIEWER'], [approver, 'APPROVER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  // Real postings for the tools to read: capital, and one invoice and one bill this month.
  await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: `${T.slice(0, 7)}-01`, post: true, memo: 'Capital', lines: [{ accountId: org.acc['1120'], debit: '500000.00' }, { accountId: org.acc['3100'], credit: '500000.00' }] }).expect(201);
  const customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Lotus Retail', isCustomer: true }).expect(201)).body.id;
  const vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Banyan Supplies', isVendor: true }).expect(201)).body.id;
  await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: customer, issueDate: `${T.slice(0, 7)}-01`, dueDate: addDays(T, 20), post: true, lines: [{ accountId: org.acc['4100'], quantity: '3', unitPrice: '41234.56' }] }).expect(201);
  await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendor, issueDate: `${T.slice(0, 7)}-01`, reference: 'BS-1', post: true, lines: [{ accountId: org.acc['6400'], quantity: '1', unitPrice: '15000.00' }] }).expect(201);
});
afterAll(async () => {
  await settle();
  await ctx?.app.close();
  await bare?.app.close();
});

describe('setting up', () => {
  it('says clearly when the server has no AI key, and sends nothing', async () => {
    const borg = await createOrg(bare, owner, { name: 'No Key Ltd' });
    const s = (await bare.http().get(`${borg.base}/copilot/status`).set(owner.auth).expect(200)).body;
    expect(s).toMatchObject({ configured: false, provider: 'Anthropic', model: 'claude-opus-5-5', enabled: false, canChange: true });
    await bare.http().put(`${borg.base}/copilot/settings`).set(owner.auth).send({ enabled: true }).expect(200);
    const r = await bare.http().post(`${borg.base}/copilot/conversations`).set(owner.auth).send({ question: 'What is our cash?' }).expect(503);
    expect(r.body).toMatchObject({ error: 'AI_NOT_CONFIGURED' });
    expect(r.body.message).toContain('ANTHROPIC_API_KEY');
    expect(await bare.prisma.copilotConversation.count({ where: { orgId: borg.orgId } })).toBe(0);
  });

  it('is off until an owner or admin turns it on, and only members who read reports can use it', async () => {
    let s = (await ctx.http().get(`${C}/status`).set(viewer.auth).expect(200)).body;
    expect(s).toMatchObject({ configured: true, provider: 'Test stand-in', enabled: false, canChange: false, questionsPerHour: QUESTIONS_PER_HOUR });
    expect(s.tools).toContain('get_income_statement');
    expect((await ctx.http().post(`${C}/conversations`).set(owner.auth).send({ question: 'Hello' }).expect(409)).body.error).toBe('COPILOT_OFF');
    await ctx.http().put(`${C}/settings`).set(viewer.auth).send({ enabled: true }).expect(403);
    await ctx.http().get(`${C}/status`).set(employee.auth).expect(403);
    await ctx.http().get(`${C}/status`).set(stranger.auth).expect(404);
    s = (await ctx.http().put(`${C}/settings`).set(owner.auth).send({ enabled: true }).expect(200)).body;
    expect(s).toMatchObject({ enabled: true, changedBy: 'Copilot Owner' });
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, action: { startsWith: 'copilot.' } } });
    expect(audit.map((a) => a.action)).toEqual(['copilot.turned_on']);
    expect(model.requests).toHaveLength(0);
  });

  it('refuses empty and over-long questions', async () => {
    await ctx.http().post(`${C}/conversations`).set(owner.auth).send({ question: '   ' }).expect(400);
    await ctx.http().post(`${C}/conversations`).set(owner.auth).send({ question: 'x'.repeat(4001) }).expect(400);
  });
});

describe('answering', () => {
  let conv: Conversation;
  const month = T.slice(0, 7);
  const finalContent = [thinking('Revenue 123703.68, Lotus owes it.'), text('Revenue this month is ₹1,23,703.68 (Profit and loss).')];

  it('runs the tools the model asks for on the real books and stores the answer with its sources', async () => {
    model.steps.push(
      () => reply([thinking('Need the P&L for this month and the receivables.'), toolUse('tu_1', 'get_income_statement', { from: `${month}-01`, to: T }), toolUse('tu_2', 'get_ageing', { ledger: 'receivables', as_of: null })], 'tool_use'),
      () => reply(finalContent, 'end_turn'),
    );
    conv = await start('  How much did we sell this month, and who owes us?  ');
    expect(conv.title).toBe('How much did we sell this month, and who owes us?');
    expect(conv.messages.map((m) => [m.role, m.status])).toEqual([['USER', 'COMPLETE'], ['ASSISTANT', 'PENDING']]);
    await settle();
    conv = await read(conv.id);
    const a = lastAnswer(conv);
    expect(a).toMatchObject({ status: 'COMPLETE', text: 'Revenue this month is ₹1,23,703.68 (Profit and loss).', servedModel: 'claude-opus-5-5', errorCode: null });
    expect(a.usage).toEqual({ inputTokens: 4000, outputTokens: 300, cacheReadTokens: 1600 });
    expect(a.sources).toEqual([
      { tool: 'get_income_statement', label: expect.stringMatching(/^Profit and loss, 1 \w{3} \d{4} to \d+ \w{3} \d{4}$/), path: '/reports/income-statement', input: { from: `${month}-01`, to: T }, ok: true },
      { tool: 'get_ageing', label: expect.stringMatching(/^Receivables ageing at /), path: '/sales/ageing', input: { ledger: 'receivables', as_of: null }, ok: true },
    ]);

    // What was sent: the stored instructions, strict tools, adaptive thinking, fallbacks, today's date.
    const [first, second] = model.requests;
    expect(first.model).toBe('claude-opus-5-5');
    expect(first.system).toContain('"Copilot Test Pvt Ltd"');
    expect(first.system).toContain('fiscal year starts in April');
    expect(first.thinking).toEqual({ type: 'adaptive' });
    expect(first).toMatchObject({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', cache_control: { type: 'ephemeral' }, metadata: { user_id: owner.id } });
    expect(first.tool_choice).toBeUndefined();
    expect(first.tools!.every((t) => 'strict' in t && t.strict === true && (t as unknown as { input_schema: { additionalProperties: boolean } }).input_schema.additionalProperties === false)).toBe(true);
    expect(first.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: `Today is ${T} (India time).` }, { type: 'text', text: 'How much did we sell this month, and who owes us?' }] }]);

    // The tool results carry the real figures, both in one user message, without ids.
    expect(second.messages).toHaveLength(3);
    const results = second.messages[2].content as { type: string; tool_use_id: string; content: string; is_error?: boolean }[];
    expect(results.map((r) => [r.type, r.tool_use_id, r.is_error])).toEqual([['tool_result', 'tu_1', undefined], ['tool_result', 'tu_2', undefined]]);
    const pl = JSON.parse(results[0].content);
    expect(pl).toMatchObject({ currency: 'INR', totalRevenue: '123703.68', totalExpenses: '15000.00', netIncome: '108703.68' });
    expect(results[0].content).not.toContain('accountId');
    const ageing = JSON.parse(results[1].content);
    expect(ageing.rows.map((r: { contactName: string; balance: string }) => [r.contactName, r.balance])).toEqual([['Lotus Retail', '123703.68']]);

    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, action: { in: ['copilot.question_asked', 'copilot.answered'] } }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((x) => x.action)).toEqual(['copilot.question_asked', 'copilot.answered']);
    expect(audit[1].data).toMatchObject({ status: 'COMPLETE', tools: ['get_income_statement', 'get_ageing'], servedModel: 'claude-opus-5-5', inputTokens: 4000, outputTokens: 300 });
  });

  it('replays the earlier exchange exactly, thinking included, for a follow-up', async () => {
    const before = model.requests.length;
    const firstTurn = [...model.requests[1].messages];
    model.steps.push(() => reply([text('Your margin is shown in the KPIs.'), toolUse('tu_3', 'get_kpis', { month: null })], 'tool_use'), () => reply([text('Done.')], 'end_turn'));
    await follow(conv.id, 'And the margin?');
    await settle();
    const req = model.requests[before];
    // Earlier turn (question, tool calls, tool results, final answer) unchanged, then the new question.
    expect(req.messages.slice(0, 3)).toEqual(firstTurn);
    // The final answer, thinking block and signature included, is sent back byte for byte.
    expect(req.messages[3]).toEqual({ role: 'assistant', content: finalContent });
    expect(req.messages[4]).toMatchObject({ role: 'user', content: [{ type: 'text', text: `Today is ${T} (India time).` }, { type: 'text', text: 'And the margin?' }] });
    expect(req.messages).toHaveLength(5);
    conv = await read(conv.id);
    expect(conv.messages.map((m) => m.status)).toEqual(['COMPLETE', 'COMPLETE', 'COMPLETE', 'COMPLETE']);
    expect(lastAnswer(conv).sources.map((s) => [s.label, s.path])).toEqual([['KPIs for the last complete month', '/reports/kpis']]);
  });

  it('gives tool failures back to the model as errors instead of failing the answer', async () => {
    model.steps.push(
      () =>
        reply(
          [
            toolUse('tu_a', 'get_income_statement', { from: T, to: addDays(T, -10) }),
            toolUse('tu_b', 'get_balance_sheet', { as_of: '2026-02-30' }),
            toolUse('tu_c', 'post_journal', { amount: '1' }),
            toolUse('tu_d', 'get_compliance_calendar', { from: T, to: addDays(T, 30) }),
          ],
          'tool_use',
        ),
      () => reply([text('Some figures could not be read.')], 'end_turn'),
    );
    const c = await start('Check a few things');
    await settle();
    const results = model.requests.at(-1)!.messages.at(-1)!.content as { content: string; is_error?: boolean }[];
    expect(results.map((r) => r.is_error ?? false)).toEqual([true, true, true, false]);
    expect(JSON.parse(results[0].content).error).toBe('"from" must not be after "to"');
    expect(JSON.parse(results[1].content).error).toMatch(/as_of: Not a real date/);
    expect(JSON.parse(results[2].content).error).toBe('Unknown tool "post_journal"');
    const a = lastAnswer(await read(c.id));
    expect(a.status).toBe('COMPLETE');
    expect(a.sources.map((s) => [s.tool, s.ok])).toEqual([['get_income_statement', false], ['get_balance_sheet', false], ['post_journal', false], ['get_compliance_calendar', true]]);
  });

  it('each read-only tool returns the figures the matching report shows', async () => {
    const calls: [string, Record<string, unknown>][] = [
      ['get_dashboard', { as_of: null }],
      ['get_balance_sheet', { as_of: T }],
      ['get_trial_balance', { as_of: T }],
      ['get_ageing', { ledger: 'payables', as_of: T }],
      ['get_kpis', { month: T.slice(0, 7) }],
      ['get_management_report', { month: T.slice(0, 7) }],
      ['get_cash_forecast', { horizon_days: 30 }],
      ['get_budget_variance', { fiscal_year: null, granularity: 'QUARTER' }],
      ['list_alerts', { status: 'ACTIVE' }],
    ];
    model.steps.push(() => reply(calls.map(([name, input], i) => toolUse(`tu_all_${i}`, name, input)), 'tool_use'), () => reply([text('Summary.')], 'end_turn'));
    await start('Give me everything');
    await settle();
    const results = model.requests.at(-1)!.messages.at(-1)!.content as { content: string; is_error?: boolean }[];
    expect(results.map((r) => r.is_error ?? false)).toEqual(calls.map(() => false));
    const out = results.map((r) => JSON.parse(r.content));
    expect(out[0].balances).toMatchObject({ receivables: '123703.68', payables: '15000.00' });
    expect(out[1]).toMatchObject({ balanced: true });
    expect(out[2]).toMatchObject({ balanced: true });
    expect(out[3].totals.balance).toBe('15000.00');
    expect(out[4].kpis.find((k: { key: string }) => k.key === 'revenue').value).toBe('123703.68');
    expect(out[4].kpis[0].series).toBeUndefined();
    expect(out[5].lines.length).toBeGreaterThan(0);
    expect(out[6]).toMatchObject({ horizonDays: 30, counts: { receivables: 1, payables: 1 } });
    expect(out[6].days).toBeUndefined();
    expect(out[7]).toMatchObject({ approvedBudget: null });
    expect(out[8]).toHaveProperty('summary');
  });
});

describe('when the model does not answer', () => {
  it('stores a refusal, and leaves it out of later turns', async () => {
    model.steps.push(() => reply([], 'refusal'));
    let c = await start('Something the model declines');
    await settle();
    c = await read(c.id);
    expect(lastAnswer(c)).toMatchObject({ status: 'REFUSED', text: null, errorCode: 'REFUSED', errorMessage: 'The AI model declined to answer this question.' });
    model.steps.push(() => reply([text('Fine.')], 'end_turn'));
    await follow(c.id, 'Something else');
    await settle();
    const req = model.requests.at(-1)!;
    expect(req.messages).toHaveLength(1);
    expect((req.messages[0].content as { text: string }[])[1].text).toBe('Something else');
  });

  it('maps provider errors to messages a member can act on', async () => {
    const cases: [() => Error, string, number][] = [
      [() => apiError(Anthropic.RateLimitError, 429, 'rate_limit_error'), 'AI_RATE_LIMITED', 1],
      [() => apiError(Anthropic.AuthenticationError, 401, 'authentication_error'), 'AI_KEY_REJECTED', 1],
      [() => apiError(Anthropic.InternalServerError, 529, 'overloaded_error'), 'AI_OVERLOADED', 1],
      [() => new Anthropic.APIConnectionTimeoutError(), 'AI_TIMEOUT', 1],
      [() => new Anthropic.APIConnectionError({ message: 'down' }), 'AI_UNREACHABLE', 1],
      [() => new Error('boom'), 'INTERNAL', 1],
    ];
    for (const [err, code] of cases) {
      model.steps.push(() => {
        throw err();
      });
      const c = await start(`Fails with ${code}`);
      await settle();
      const a = lastAnswer(await read(c.id));
      expect(a).toMatchObject({ status: 'FAILED', errorCode: code, text: null });
      expect(a.errorMessage).toBeTruthy();
      if (code === 'AI_KEY_REJECTED') expect(a.errorMessage).toContain('ANTHROPIC_API_KEY');
    }
  });

  it('stops after too many steps, and when the answer is cut off', async () => {
    for (let i = 0; i < 3; i++) model.steps.push(() => reply([toolUse(`tu_loop_${i}`, 'get_dashboard', { as_of: null })], 'tool_use'));
    let c = await start('Loop forever');
    await settle();
    expect(lastAnswer(await read(c.id))).toMatchObject({ status: 'INCOMPLETE', errorCode: 'TOO_MANY_STEPS' });
    expect(lastAnswer(await read(c.id)).sources).toHaveLength(2);

    model.steps.push(() => reply([toolUse('tu_cut', 'get_balance_sheet', { as_of: T })], 'max_tokens'));
    c = await start('Cut off in a tool call');
    await settle();
    expect(lastAnswer(await read(c.id))).toMatchObject({ status: 'INCOMPLETE', errorCode: 'CUT_OFF', text: null, sources: [] });

    model.steps.push(() => reply([text('Revenue is')], 'max_tokens'));
    c = await start('Cut off in the text');
    await settle();
    expect(lastAnswer(await read(c.id))).toMatchObject({ status: 'INCOMPLETE', errorCode: 'CUT_OFF', text: 'Revenue is' });
  });

  it('records the model that answered when the provider fell back to another', async () => {
    model.steps.push(() => reply([text('Answered by the fallback model.')], 'end_turn', 'claude-opus-4-8'));
    const c = await start('Fallback');
    await settle();
    expect(lastAnswer(await read(c.id))).toMatchObject({ status: 'COMPLETE', servedModel: 'claude-opus-4-8' });
  });
});

describe('one answer at a time, privacy and guards', () => {
  it('refuses a second question while one is being answered, and deleting while busy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    model.steps.push(async () => {
      await gate;
      return reply([text('Slow answer.')], 'end_turn');
    });
    const c = await start('Slow question');
    expect((await ctx.http().post(`${C}/conversations/${c.id}/messages`).set(owner.auth).send({ question: 'Another' }).expect(409)).body.error).toBe('COPILOT_BUSY');
    expect((await ctx.http().delete(`${C}/conversations/${c.id}`).set(owner.auth).expect(409)).body.error).toBe('COPILOT_BUSY');
    release();
    await settle();
    await ctx.http().delete(`${C}/conversations/${c.id}`).set(owner.auth).expect(204);
    await ctx.http().get(`${C}/conversations/${c.id}`).set(owner.auth).expect(404);
    expect(await ctx.prisma.copilotMessage.count({ where: { conversationId: c.id } })).toBe(0);
  });

  it('closes an answer left pending by a server restart when the next question comes', async () => {
    model.steps.push(() => reply([text('First.')], 'end_turn'));
    const c = await start('Before the restart');
    await settle();
    await raw(`INSERT INTO copilot_messages (id, org_id, conversation_id, seq, role, status, text, api_messages, created_at) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 3, 'USER', 'COMPLETE', 'Lost question', '[]', now() - interval '20 minutes')`, org.orgId, c.id);
    await raw(`INSERT INTO copilot_messages (id, org_id, conversation_id, seq, role, status, created_at) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 4, 'ASSISTANT', 'PENDING', now() - interval '20 minutes')`, org.orgId, c.id);
    model.steps.push(() => reply([text('After.')], 'end_turn'));
    await follow(c.id, 'After the restart');
    await settle();
    const after = await read(c.id);
    expect(after.messages.map((m) => [m.status, m.errorCode])).toEqual([['COMPLETE', null], ['COMPLETE', null], ['COMPLETE', null], ['FAILED', 'INTERRUPTED'], ['COMPLETE', null], ['COMPLETE', null]]);
  });

  it('keeps conversations private to the member who started them', async () => {
    const mine = (await ctx.http().get(`${C}/conversations`).set(owner.auth).expect(200)).body as { id: string }[];
    expect(mine.length).toBeGreaterThan(5);
    expect((await ctx.http().get(`${C}/conversations`).set(viewer.auth).expect(200)).body).toEqual([]);
    await ctx.http().get(`${C}/conversations/${mine[0].id}`).set(viewer.auth).expect(404);
    await ctx.http().post(`${C}/conversations/${mine[0].id}/messages`).set(viewer.auth).send({ question: 'Peek' }).expect(404);
    await ctx.http().delete(`${C}/conversations/${mine[0].id}`).set(viewer.auth).expect(404);
    await ctx.http().get(`${C}/conversations/${mine[0].id}`).set(stranger.auth).expect(404);
    // Row-level security hides them from another member even inside the organisation.
    const seen = await ctx.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', '', true), set_config('t2t.org_id', $1, true), set_config('t2t.user_id', $2, true)`, org.orgId, viewer.id);
      return [await tx.copilotConversation.count(), await tx.copilotMessage.count()];
    });
    expect(seen).toEqual([0, 0]);
    const own = await ctx.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', '', true), set_config('t2t.org_id', $1, true), set_config('t2t.user_id', $2, true)`, org.orgId, owner.id);
      return tx.copilotConversation.count();
    });
    expect(own).toBe(mine.length);
    // A viewer can use it too, and the tools respect what a viewer may see.
    model.steps.push(() => reply([toolUse('tu_v', 'get_ageing', { ledger: 'payables', as_of: null })], 'tool_use'), () => reply([text('Payables.')], 'end_turn'));
    const v = await start('What do we owe?', viewer.auth);
    await settle();
    expect(lastAnswer(await read(v.id, viewer.auth)).sources[0]).toMatchObject({ ok: true, path: '/purchases/ageing' });
  });

  it('closes a conversation started with another model or tool set', async () => {
    const id = randomUUID();
    await raw(`INSERT INTO copilot_conversations (id, org_id, user_id, title, model, toolset_version, system_prompt) VALUES ($1::uuid, $2::uuid, $3::uuid, 'Old', 'claude-old-model', $4, 'Old instructions')`, id, org.orgId, owner.id, TOOLSET_VERSION);
    expect((await read(id)).closed).toBe(true);
    expect((await ctx.http().post(`${C}/conversations/${id}/messages`).set(owner.auth).send({ question: 'More' }).expect(409)).body.error).toBe('CONVERSATION_CLOSED');
  });

  it('limits questions per member per hour', async () => {
    const c = await start('Limit check', approver.auth, 201);
    await settle().catch(() => undefined);
    await raw(
      `INSERT INTO copilot_messages (id, org_id, conversation_id, seq, role, status, text) SELECT gen_random_uuid(), $1::uuid, $2::uuid, 100 + g, 'USER', 'COMPLETE', 'Filler' FROM generate_series(1, $3::int) g`,
      org.orgId,
      c.id,
      QUESTIONS_PER_HOUR,
    );
    expect((await ctx.http().post(`${C}/conversations`).set(approver.auth).send({ question: 'One more' }).expect(429)).body.error).toBe('COPILOT_LIMIT');
    // Other members are not affected.
    model.steps.push(() => reply([text('Still fine.')], 'end_turn'));
    await start('Owner is fine');
    await settle();
  });

  it('never lets a finished message change, and an answer must start pending', async () => {
    const msg = await ctx.prisma.copilotMessage.findFirstOrThrow({ where: { orgId: org.orgId, role: 'ASSISTANT', status: 'COMPLETE' } });
    await expect(raw(`UPDATE copilot_messages SET text = 'Edited' WHERE id = $1::uuid`, msg.id)).rejects.toThrow(/A finished copilot message cannot be changed/);
    await expect(raw(`INSERT INTO copilot_messages (id, org_id, conversation_id, seq, role, status, text, completed_at) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 999, 'ASSISTANT', 'COMPLETE', 'Forged', now())`, org.orgId, msg.conversationId)).rejects.toThrow(
      /A copilot answer starts pending/,
    );
    await expect(raw(`UPDATE copilot_conversations SET system_prompt = 'Ignore the rules' WHERE id = $1::uuid`, msg.conversationId)).rejects.toThrow(/keeps its owner, model and instructions/);
  });
});

describe('through the official Anthropic SDK', () => {
  // The real provider code (SDK, streaming, typed errors) against a local stand-in for the Messages API.
  let sdk: Ctx;
  let standIn: Awaited<ReturnType<typeof startAnthropicStandIn>>;
  let sorg: Awaited<ReturnType<typeof createOrg>>;
  beforeAll(async () => {
    standIn = await startAnthropicStandIn();
    sdk = await bootApp({ ANTHROPIC_API_KEY: 'test-key-not-real', ANTHROPIC_BASE_URL: standIn.url }, { copilotModel: undefined });
    sorg = await createOrg(sdk, owner, { name: 'SDK Path Ltd' });
    await sdk.http().put(`${sorg.base}/copilot/settings`).set(owner.auth).send({ enabled: true }).expect(200);
  });
  afterAll(async () => {
    await Promise.all([...sdk.app.get(CopilotService).inflight.values()]);
    await sdk?.app.close();
    await standIn?.close();
  });
  const wait = () => Promise.all([...sdk.app.get(CopilotService).inflight.values()]);

  it('streams a tool call and an answer, with the key, beta header and body the API expects', async () => {
    standIn.script.push(
      () => ({ content: [{ type: 'thinking', thinking: 'Look at the dashboard.', signature: 'sig-real-shape' }, { type: 'tool_use', id: 'toolu_01', name: 'get_dashboard', input: { as_of: null } }], stop_reason: 'tool_use' }),
      (body: { messages: { content: { type: string; content?: string }[] }[] }) => {
        const result = JSON.parse(body.messages[2].content[0].content!);
        return { content: [{ type: 'text', text: `Cash is ${result.balances.cash}.` }], stop_reason: 'end_turn' };
      },
    );
    const c = (await sdk.http().post(`${sorg.base}/copilot/conversations`).set(owner.auth).send({ question: 'What is our cash?' }).expect(201)).body as Conversation;
    expect((await sdk.http().get(`${sorg.base}/copilot/status`).set(owner.auth).expect(200)).body).toMatchObject({ configured: true, provider: 'Anthropic' });
    await wait();
    const done = (await sdk.http().get(`${sorg.base}/copilot/conversations/${c.id}`).set(owner.auth).expect(200)).body as Conversation;
    expect(lastAnswer(done)).toMatchObject({ status: 'COMPLETE', text: 'Cash is 0.00.', servedModel: 'claude-opus-5-5' });
    const [first, second] = standIn.requests;
    // SDK 1.x sends the API key as a bearer token.
    expect(first.headers.authorization).toBe('Bearer test-key-not-real');
    expect(first.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(first.body).toMatchObject({ model: 'claude-opus-5-5', stream: true, fallbacks: 'default', thinking: { type: 'adaptive' } });
    expect(first.body.betas).toBeUndefined();
    // The thinking block came back from the stream whole and is replayed with its signature.
    expect(second.body.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'thinking', thinking: 'Look at the dashboard.', signature: 'sig-real-shape' }, { type: 'tool_use', id: 'toolu_01', name: 'get_dashboard', input: { as_of: null } }] });
  });

  it('turns HTTP errors from the provider into clear messages', async () => {
    for (const [status, type, code] of [[401, 'authentication_error', 'AI_KEY_REJECTED'], [429, 'rate_limit_error', 'AI_RATE_LIMITED'], [529, 'overloaded_error', 'AI_OVERLOADED'], [400, 'invalid_request_error', 'AI_REQUEST_REJECTED']] as const) {
      standIn.script.push(() => ({ status, type, message: 'scripted' }));
      const c = (await sdk.http().post(`${sorg.base}/copilot/conversations`).set(owner.auth).send({ question: `HTTP ${status}` }).expect(201)).body as Conversation;
      await wait();
      const done = (await sdk.http().get(`${sorg.base}/copilot/conversations/${c.id}`).set(owner.auth).expect(200)).body as Conversation;
      expect(lastAnswer(done)).toMatchObject({ status: 'FAILED', errorCode: code });
    }
  });
});
