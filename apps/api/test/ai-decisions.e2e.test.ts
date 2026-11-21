import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRIVATE_ANSWER } from '@talk2tax/accounting-engine';
import type { CopilotModel, CopilotRequest, CopilotResponse } from '../src/copilot/copilot.model';
import { CopilotService } from '../src/copilot/copilot.service';
import { runInOrg } from '../src/common/tenant-context';
import { aiDecisionRecords } from '../src/db/collections/ai-decision-records';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * The explainable AI ledger (AUDIT-018, AUDIT-020, AUDIT-021, AUDIT-027, AUDIT-029, AUDIT-030)
 * against the real API and database, with a scripted stand-in model: every model call gets a
 * decision record naming the agent and the member it acted for, fingerprints of the prompt and
 * tools, the data it read, its timing and its own short explanation; hidden reasoning is never
 * stored or shown; failed calls are recorded too; records are kept as written; permissions and
 * tenant isolation.
 */
type Step = (req: CopilotRequest) => CopilotResponse | Promise<CopilotResponse>;
class ScriptedModel implements CopilotModel {
  readonly provider = 'Test stand-in';
  steps: Step[] = [];
  async send(req: CopilotRequest): Promise<CopilotResponse> {
    const step = this.steps.shift();
    if (!step) throw new Error('The test did not script this step');
    return step(req);
  }
}
let n = 0;
const reply = (content: unknown[], stop_reason: string) =>
  ({ id: `msg_${++n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 } }) as unknown as CopilotResponse;
const SECRET_REASONING = 'Private chain of thought: compare revenue with last month first.';
const thinking = (t: string) => ({ type: 'thinking', thinking: t, signature: `sig-${++n}` });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const text = (t: string) => ({ type: 'text', text: t, citations: null });

type Rec = {
  id: string;
  agent: { id: string; name: string };
  actingFor: { name: string } | null;
  keySource: string;
  modelRequested: string;
  servedModel: string | null;
  promptVersion: string;
  toolsVersion: string;
  toolNames: string[];
  dataSources: string[];
  subject: { type: string; id: string } | null;
  explanation: string | null;
  reasoningWithheld: boolean;
  outcome: string;
  errorName: string | null;
  inputTokens: number;
  outputTokens: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
};

const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
let ctx: Ctx;
const model = new ScriptedModel();
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const D = () => `${org.base}/ai-decisions`;
const settle = () => Promise.all([...ctx.app.get(CopilotService).inflight.values()]);

beforeAll(async () => {
  ctx = await bootApp({ COPILOT_MAX_TOOL_ROUNDS: '3' }, { copilotModel: model });
  owner = await registerUser(ctx, 'Ledger Owner');
  viewer = await registerUser(ctx, 'Ledger Viewer');
  outsider = await registerUser(ctx, 'Ledger Outsider');
  org = await createOrg(ctx, owner, { name: 'AI Ledger Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other AI Ledger Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: `${T.slice(0, 7)}-01`, post: true, memo: 'Capital', lines: [{ accountId: org.acc['1120'], debit: '250000.00' }, { accountId: org.acc['3100'], credit: '250000.00' }] }).expect(201);
  await ctx.http().put(`${org.base}/copilot/settings`).set(owner.auth).send({ enabled: true }).expect(200);
});
afterAll(async () => {
  await settle();
  await ctx?.app.close();
});

describe('explainable AI ledger', () => {
  let answerId: string;
  let conversationId: string;

  it('records each model call with its agent, prompt, data, timing and explanation, never its hidden reasoning', async () => {
    model.steps.push(
      () => reply([thinking(SECRET_REASONING), toolUse('tu_1', 'get_income_statement', { from: `${T.slice(0, 7)}-01`, to: T })], 'tool_use'),
      () => reply([thinking(SECRET_REASONING), text('There is no revenue this month yet; the only posting is the capital introduced.')], 'end_turn'),
    );
    const conv = (await ctx.http().post(`${org.base}/copilot/conversations`).set(owner.auth).send({ question: 'What did we sell this month?' }).expect(201)).body;
    conversationId = conv.id;
    answerId = conv.messages[conv.messages.length - 1].id;
    await settle();

    await ctx.http().get(D()).set(viewer.auth).expect(403);
    const body = (await ctx.http().get(D()).set(owner.auth).expect(200)).body as { records: Rec[]; agents: { id: string }[] };
    expect(body.agents.map((a) => a.id)).toContain('BANK_MATCHING');
    const [second, first] = body.records;
    expect(body.records).toHaveLength(2);
    for (const r of [first!, second!]) {
      expect(r).toMatchObject({ agent: { id: 'COPILOT', name: 'Copilot' }, actingFor: { name: 'Ledger Owner' }, keySource: 'SERVER', servedModel: 'claude-opus-5-5', subject: { type: 'COPILOT_ANSWER', id: answerId }, reasoningWithheld: true, outcome: 'ANSWERED', inputTokens: 1000, outputTokens: 120 });
      expect(r.promptVersion).toMatch(/^[0-9a-f]{12}$/);
      expect(r.toolsVersion).toMatch(/^[0-9a-f]{12}$/);
      expect(r.toolNames).toContain('get_income_statement');
      expect(Date.parse(r.completedAt)).toBeGreaterThanOrEqual(Date.parse(r.startedAt));
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    }
    // The same instructions and tools give the same versions.
    expect(second!.promptVersion).toBe(first!.promptVersion);
    expect(second!.toolsVersion).toBe(first!.toolsVersion);
    // The first call read only the question; the second also read the tool's result.
    expect(first!.dataSources).toEqual(["The member's question and the earlier answers in the conversation"]);
    expect(second!.dataSources).toEqual(["The member's question and the earlier answers in the conversation", 'Tool: get_income_statement']);
    expect(first!.explanation).toBe('Used get_income_statement');
    // The copilot's words stay private to the member: only the fact of the answer is kept.
    expect(second!.explanation).toBe(PRIVATE_ANSWER);
    expect(JSON.stringify(body)).not.toContain('no revenue this month');

    // Hidden reasoning is neither in the ledger nor in anything a member reads.
    const all = JSON.stringify(body);
    expect(all).not.toContain('Private chain of thought');
    const read = await ctx.http().get(`${org.base}/copilot/conversations/${conversationId}`).set(owner.auth).expect(200);
    expect(JSON.stringify(read.body)).not.toContain('Private chain of thought');
    const stored = await runInOrg(org.orgId, () => ctx.store.collection(aiDecisionRecords).find({}));
    expect(JSON.stringify(stored)).not.toContain('Private chain of thought');
  });

  it('records failed calls, filters and keeps records as written', async () => {
    model.steps.push(() => {
      throw new TypeError('connection reset');
    });
    await ctx.http().post(`${org.base}/copilot/conversations`).set(owner.auth).send({ question: 'And last month?' }).expect(201);
    await settle();
    const failed = (await ctx.http().get(`${D()}?outcome=FAILED`).set(owner.auth).expect(200)).body.records as Rec[];
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ outcome: 'FAILED', errorName: 'TypeError', servedModel: null, explanation: null, inputTokens: 0 });
    expect(((await ctx.http().get(`${D()}?subjectId=${answerId}`).set(owner.auth).expect(200)).body.records as Rec[]).length).toBe(2);
    expect(((await ctx.http().get(`${D()}?agent=BANK_MATCHING`).set(owner.auth).expect(200)).body.records as Rec[]).length).toBe(0);
    const page = (await ctx.http().get(`${D()}?limit=2`).set(owner.auth).expect(200)).body as { records: Rec[]; next: string | null };
    expect(page.records).toHaveLength(2);
    expect(page.next).not.toBeNull();
    const rest = (await ctx.http().get(`${D()}?limit=2&before=${encodeURIComponent(page.next!)}`).set(owner.auth).expect(200)).body as { records: Rec[]; next: string | null };
    expect(rest.records).toHaveLength(1);
    expect(rest.next).toBeNull();
    await ctx.http().get(`${D()}?agent=NOBODY`).set(owner.auth).expect(400);

    const one = failed[0]!.id;
    await expect(runInOrg(org.orgId, () => ctx.store.collection(aiDecisionRecords).updateOne({ id: one }, { $set: { explanation: 'Changed' } }))).rejects.toThrow(/kept as written/);
    await expect(runInOrg(org.orgId, () => ctx.store.collection(aiDecisionRecords).deleteOne({ id: one }))).rejects.toThrow(/kept as a record/);
  });

  it('keeps each organisation to its own records', async () => {
    await ctx.http().get(D()).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/ai-decisions`).set(outsider.auth).expect(200)).body.records).toEqual([]);
  });
});
