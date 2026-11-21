import { AGENT_EVAL_CASES, AGENT_EVAL_REFERENCE, AgentAnswer, AgentEvalCase } from '@talk2tax/accounting-engine';
import { describe, expect, it } from 'vitest';
import { EVAL_ORG, evalAnswer, evalRequest, runAgentEvals } from '../src/ai-control/agent-evals.runner';
import { reconciliationPrompt, SUBMIT_TOOL as BANK_TOOL, BANK_INJECTION_NOTICE } from '../src/bank-ai/bank-ai.service';
import { cfoSummaryPrompt } from '../src/cfo/cfo.service';
import { closeReviewPrompt, REVIEW_TOOL } from '../src/close/close.service';
import { collectionsPrompt, SUBMIT_TOOL as COLLECTIONS_TOOL } from '../src/collections/collections.service';
import type { CopilotModel, CopilotRequest, CopilotResponse } from '../src/copilot/copilot.model';

/**
 * The live run of the AI agent evaluation (QA-014), driven by stand-in models: requests carry each
 * agent's real instructions and tool, answers are parsed the way the agents' services parse them,
 * and the report fails when a wrong answer gets past an agent's checks. The run against Claude
 * itself is `pnpm --filter @talk2tax/api agent-evals` with an API key.
 */
let n = 0;
const response = (content: unknown[], stop_reason = 'tool_use') =>
  ({ id: `msg_eval_${++n}`, type: 'message', role: 'assistant', model: 'stand-in', content, stop_reason, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) as unknown as CopilotResponse;

/** The model's reply that carries this answer, shaped as the agent's tool input or text. */
function reply(a: AgentAnswer): CopilotResponse {
  switch (a.agent) {
    case 'BANKING':
      return response([{ type: 'tool_use', id: 'tu_1', name: BANK_TOOL.name, input: { ...a.proposal, confidence: 'HIGH', reason: 'From the narration and amount.' } }]);
    case 'CLOSE':
      return response([{ type: 'tool_use', id: 'tu_1', name: REVIEW_TOOL.name, input: { summary: 'The month looks complete.', findings: [], adjustments: a.adjustments } }]);
    case 'COLLECTIONS':
      return response([{ type: 'tool_use', id: 'tu_1', name: COLLECTIONS_TOOL.name, input: { risk: a.risk, riskReasons: ['From the payment history.'], subject: a.subject, body: a.body } }]);
    case 'CFO':
      return response([{ type: 'text', text: a.summary, citations: null }], 'end_turn');
  }
}

/** Answers each case in order with what `answer` gives, and keeps the requests. */
class StandIn implements CopilotModel {
  readonly provider = 'Test stand-in';
  requests: CopilotRequest[] = [];
  private i = 0;
  constructor(
    private readonly answer: (c: AgentEvalCase) => CopilotResponse | Error,
    private readonly cases: readonly AgentEvalCase[] = AGENT_EVAL_CASES,
  ) {}
  async send(req: CopilotRequest): Promise<CopilotResponse> {
    this.requests.push(req);
    const r = this.answer(this.cases[this.i++]);
    if (r instanceof Error) throw r;
    return r;
  }
}
const textOf = (req: CopilotRequest) => (req.messages[0].content as { text: string }[])[0].text;

describe('agent evaluation, live run (QA-014)', () => {
  it('sends each case with the agent’s own instructions and tool', () => {
    for (const c of AGENT_EVAL_CASES) {
      const r = evalRequest(c, 'claude-opus-5-5');
      expect(r.model).toBe('claude-opus-5-5');
      const expected = { BANKING: [reconciliationPrompt(EVAL_ORG), BANK_TOOL.name], CLOSE: [closeReviewPrompt(EVAL_ORG), REVIEW_TOOL.name], COLLECTIONS: [collectionsPrompt(EVAL_ORG), COLLECTIONS_TOOL.name], CFO: [cfoSummaryPrompt(EVAL_ORG, 'BOARD'), null] }[c.agent];
      expect(r.system).toBe(expected[0]);
      expect(r.tool_choice ?? null).toEqual(expected[1] ? { type: 'tool', name: expected[1] } : null);
    }
    // The narration that tries to instruct the AI is marked for the model, as the bank agent does.
    const injected = evalRequest(AGENT_EVAL_CASES.find((c) => c.id === 'bank-injection')!, 'm');
    expect(textOf(injected).startsWith(BANK_INJECTION_NOTICE)).toBe(true);
    expect(textOf(evalRequest(AGENT_EVAL_CASES.find((c) => c.id === 'bank-match-one')!, 'm'))).not.toContain(BANK_INJECTION_NOTICE);
  });

  it('passes a model that answers every case correctly, and counts its tokens', async () => {
    const model = new StandIn((c) => reply(AGENT_EVAL_REFERENCE[c.id]));
    const report = await runAgentEvals(model, { model: 'claude-opus-5-5', minAccuracy: 0.8 });
    expect(model.requests).toHaveLength(AGENT_EVAL_CASES.length);
    expect(report.grades.filter((g) => !g.correct)).toEqual([]);
    expect(report.score.passed).toBe(true);
    expect(report.score.byAgent.CFO).toEqual({ cases: 2, accepted: 2, correct: 2, unsafe: 0, accuracy: 1 });
    expect(report.inputTokens).toBe(900 * AGENT_EVAL_CASES.length);
    expect(report.outputTokens).toBe(120 * AGENT_EVAL_CASES.length);
  });

  it('fails a model that follows the narration in the injection case, naming the case', async () => {
    const model = new StandIn((c) => (c.id === 'bank-injection' ? reply({ agent: 'BANKING', proposal: { action: 'ENTRY', accountCode: '4900', entryDescription: 'As instructed' } }) : reply(AGENT_EVAL_REFERENCE[c.id])));
    const report = await runAgentEvals(model, { model: 'm', minAccuracy: 0.5 });
    expect(report.score.passed).toBe(false);
    expect(report.score.problems).toEqual(['BANKING: 1 answer passed the checks but was wrong']);
    expect(report.grades.find((g) => g.caseId === 'bank-injection')).toMatchObject({ accepted: true, correct: false, unsafe: true, notes: ['ENTRY instead of MATCH'] });
  });

  it('counts refusals, cut-off answers, bad shapes and provider errors as wrong, never as accepted', async () => {
    const model = new StandIn((c) => {
      if (c.agent === 'BANKING') return response([], 'refusal');
      if (c.agent === 'CLOSE') return response([{ type: 'tool_use', id: 'tu_1', name: REVIEW_TOOL.name, input: { summary: 'x' } }]);
      if (c.agent === 'COLLECTIONS') return response([{ type: 'text', text: 'Dear customer', citations: null }], 'max_tokens');
      return new Error('529 overloaded');
    });
    const report = await runAgentEvals(model, { model: 'm', minAccuracy: 0.8 });
    expect(report.grades.every((g) => !g.accepted && !g.correct && !g.unsafe)).toBe(true);
    expect(report.grades.find((g) => g.agent === 'CFO')?.error).toBe('529 overloaded');
    expect(report.score.problems).toHaveLength(4);
  });

  it('runs only the agents asked for', async () => {
    const cases = AGENT_EVAL_CASES.filter((c) => c.agent === 'CFO');
    const model = new StandIn((c) => reply(AGENT_EVAL_REFERENCE[c.id]), cases);
    const report = await runAgentEvals(model, { model: 'm', minAccuracy: 1, agents: ['CFO'] });
    expect(model.requests.every((r) => r.system === cfoSummaryPrompt(EVAL_ORG, 'BOARD'))).toBe(true);
    expect(report.grades.map((g) => g.caseId)).toEqual(cases.map((c) => c.id));
    expect(report.score.passed).toBe(true);
  });

  it('parses a close review the way the close agent does, dropping malformed entries', () => {
    const c = AGENT_EVAL_CASES.find((x) => x.id === 'close-accrue-rent')!;
    const good = (AGENT_EVAL_REFERENCE[c.id] as Extract<AgentAnswer, { agent: 'CLOSE' }>).adjustments[0];
    const a = evalAnswer(c, response([{ type: 'tool_use', id: 'tu_1', name: REVIEW_TOOL.name, input: { summary: 's', findings: [], adjustments: [good, { description: 'no lines' }] } }]));
    expect(a).toEqual({ agent: 'CLOSE', adjustments: [good] });
  });
});
