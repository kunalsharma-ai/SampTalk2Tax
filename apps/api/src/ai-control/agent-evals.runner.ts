import Anthropic from '@anthropic-ai/sdk';
import {
  AGENT_EVAL_CASES,
  AgentAnswer,
  AgentEvalCase,
  closeContextForModel,
  contextForModel,
  EvalGrade,
  EvalScore,
  factsForModel,
  gradeAgentAnswer,
  parseAdjustment,
  scoreAgentEvals,
} from '@talk2tax/accounting-engine';
import { BANK_INJECTION_NOTICE, parse as parseBankSuggestion, reconciliationPrompt, SUBMIT_TOOL as BANK_TOOL, untrustedText } from '../bank-ai/bank-ai.service';
import { cfoSummaryPrompt } from '../cfo/cfo.service';
import { closeReviewPrompt, REVIEW_TOOL } from '../close/close.service';
import { COLLECTIONS_INJECTION_NOTICE, collectionsPrompt, parseSubmission, SUBMIT_TOOL as COLLECTIONS_TOOL } from '../collections/collections.service';
import type { CopilotModel, CopilotRequest, CopilotResponse } from '../copilot/copilot.model';
import { injectionSignals } from '../copilot/safety';

/**
 * The live run of the AI agent evaluation (QA-014): each labelled case is sent to a model with the
 * agent's real instructions and tool, the answer is parsed the way the agent's service parses it,
 * and graded (packages/accounting-engine/src/agent-evals.ts). Nothing is stored and nothing touches
 * the books. scripts/agent-evals.mjs runs it against the configured Claude model.
 */
export const EVAL_ORG = { name: 'Eval Test Pvt Ltd', functionalCurrency: 'INR' };
const MAX_TOKENS = { BANKING: 2000, CLOSE: 4000, COLLECTIONS: 2000, CFO: 8000 } as const;

/** The request the agent's service would send for this case. */
export function evalRequest(c: AgentEvalCase, model: string): CopilotRequest {
  const user = (text: string) => [{ role: 'user' as const, content: [{ type: 'text' as const, text }] }];
  switch (c.agent) {
    case 'BANKING': {
      const text = contextForModel(c.context);
      const flagged = injectionSignals(untrustedText(c.context)).length > 0;
      return { model, max_tokens: MAX_TOKENS.BANKING, system: reconciliationPrompt(EVAL_ORG), tools: [BANK_TOOL], tool_choice: { type: 'tool', name: BANK_TOOL.name }, messages: user(flagged ? `${BANK_INJECTION_NOTICE}\n\n${text}` : text) };
    }
    case 'CLOSE':
      return { model, max_tokens: MAX_TOKENS.CLOSE, system: closeReviewPrompt(EVAL_ORG), tools: [REVIEW_TOOL], tool_choice: { type: 'tool', name: REVIEW_TOOL.name }, messages: user(closeContextForModel(c.context)) };
    case 'COLLECTIONS': {
      const facts = factsForModel(c.facts);
      return { model, max_tokens: MAX_TOKENS.COLLECTIONS, system: collectionsPrompt(EVAL_ORG), tools: [COLLECTIONS_TOOL], tool_choice: { type: 'tool', name: COLLECTIONS_TOOL.name }, messages: user(`${injectionSignals(facts).length ? `${COLLECTIONS_INJECTION_NOTICE}\n\n` : ''}Facts from the books:\n\n${facts}`) };
    }
    case 'CFO':
      return { model, max_tokens: MAX_TOKENS.CFO, system: cfoSummaryPrompt(EVAL_ORG, 'BOARD'), thinking: { type: 'adaptive' }, messages: user(`Facts for the board pack:\n\n${c.facts}`) };
  }
}

/** The model's answer, parsed as the agent's service parses it; null when it gave nothing usable. */
export function evalAnswer(c: AgentEvalCase, res: CopilotResponse): AgentAnswer | null {
  if (res.stop_reason === 'max_tokens' || res.stop_reason === 'refusal') return null;
  const tool = (name: string) => res.content.find((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use' && b.name === name)?.input;
  switch (c.agent) {
    case 'BANKING': {
      const p = parseBankSuggestion(tool(BANK_TOOL.name));
      if (!p) return null;
      const { confidence: _c, reason: _r, ...proposal } = p;
      return { agent: 'BANKING', proposal };
    }
    case 'CLOSE': {
      const input = tool(REVIEW_TOOL.name) as Record<string, unknown> | undefined;
      if (!input || !Array.isArray(input.adjustments)) return null;
      return { agent: 'CLOSE', adjustments: input.adjustments.map(parseAdjustment).filter((a) => a !== null) };
    }
    case 'COLLECTIONS': {
      const w = parseSubmission(tool(COLLECTIONS_TOOL.name));
      return w ? { agent: 'COLLECTIONS', risk: w.risk, subject: w.subject, body: w.body } : null;
    }
    case 'CFO': {
      const summary = res.content
        .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n\n')
        .trim();
      return summary ? { agent: 'CFO', summary } : null;
    }
  }
}

export interface AgentEvalReport {
  model: string;
  provider: string;
  minAccuracy: number;
  grades: (EvalGrade & { about: string; error?: string })[];
  score: EvalScore;
  inputTokens: number;
  outputTokens: number;
}

/** Runs every case (or those of the agents named) against the model, one at a time. */
export async function runAgentEvals(model: CopilotModel, opts: { model: string; minAccuracy: number; agents?: string[]; timeoutMs?: number; cases?: readonly AgentEvalCase[] }): Promise<AgentEvalReport> {
  const cases = (opts.cases ?? AGENT_EVAL_CASES).filter((c) => !opts.agents?.length || opts.agents.includes(c.agent));
  const grades: AgentEvalReport['grades'] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  for (const c of cases) {
    try {
      const res = await model.send(evalRequest(c, opts.model), { signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000) });
      inputTokens += res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0);
      outputTokens += res.usage.output_tokens;
      grades.push({ ...gradeAgentAnswer(c, evalAnswer(c, res)), about: c.about });
    } catch (e) {
      grades.push({ ...gradeAgentAnswer(c, null), about: c.about, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { model: opts.model, provider: model.provider, minAccuracy: opts.minAccuracy, grades, score: scoreAgentEvals(grades, opts.minAccuracy), inputTokens, outputTokens };
}
