/**
 * AI agent evaluation (QA-014): labelled cases for the agents that prepare work for people
 * (bank reconciliation, month-end close, collections, virtual CFO), and how an answer to a case
 * is graded.
 *
 * Each case is the input an agent is shown and what a correct answer does. An answer is graded
 * twice: `accepted` is whether it passes the agent's own checks (the ones that decide whether a
 * person can apply it with one click), and `correct` is whether it does what the case expects.
 * An answer that is accepted but not correct is `unsafe`: the checks let through something wrong,
 * and only the person reviewing it stands in the way. For the bank and close agents that means a
 * wrong match, payment or entry; for the writing agents (collections, CFO) the checks already
 * hold every amount and invoice number to the books, so an accepted text that misses something
 * the case needs is counted as not correct, not unsafe.
 *
 * The same grading serves two runs: the fixed candidate answers in the tests (do the checks
 * catch what they must?) and a live run that sends each case to the configured AI model with the
 * agent's real instructions (how often does the model get it right?).
 * No framework or database code. Money is decimal strings.
 */
import { BankAiAction, BankLineContext, BankProposalInput, checkProposal } from './bank-ai';
import { AdjustmentInput, checkAdjustment, CloseReviewContext } from './close';
import { checkSummaryFigures } from './cfo';
import { checkDraft, CustomerFacts, draftPasses, RiskLevel } from './collections';
import { D } from './money';

export const EVAL_AGENTS = ['BANKING', 'CLOSE', 'COLLECTIONS', 'CFO'] as const;
export type EvalAgent = (typeof EVAL_AGENTS)[number];

interface CaseBase {
  /** Stable id, such as bank-rent-entry. */
  id: string;
  /** What the case tests, in one line. */
  about: string;
}

export interface BankEvalCase extends CaseBase {
  agent: 'BANKING';
  context: BankLineContext;
  /** What a correct suggestion does. Fields left out are not graded. */
  expect: { action: BankAiAction; ledgerRefs?: string[]; contactRef?: string; documentRefs?: string[]; accountCode?: string };
}

export interface CloseEvalCase extends CaseBase {
  agent: 'CLOSE';
  context: CloseReviewContext;
  /** The adjusting entries the month needs, each by the accounts it uses and its total; [] when none. */
  expect: { entries: { accounts: string[]; total: string }[] };
}

export interface CollectionsEvalCase extends CaseBase {
  agent: 'COLLECTIONS';
  facts: CustomerFacts;
  /** Text the reminder must contain (beyond what the checks already hold it to), and the risk levels that are reasonable. */
  expect: { mustMention: string[]; risk: RiskLevel[] };
}

export interface CfoEvalCase extends CaseBase {
  agent: 'CFO';
  /** The facts the summary is written from, as the CFO agent is given them. */
  facts: string;
  expect: { mustMention: string[] };
}

export type AgentEvalCase = BankEvalCase | CloseEvalCase | CollectionsEvalCase | CfoEvalCase;

/** An agent's answer to a case, after the same parsing the agent's service does. */
export type AgentAnswer =
  | { agent: 'BANKING'; proposal: BankProposalInput }
  | { agent: 'CLOSE'; adjustments: AdjustmentInput[] }
  | { agent: 'COLLECTIONS'; risk: RiskLevel; subject: string; body: string }
  | { agent: 'CFO'; summary: string };

export interface EvalGrade {
  caseId: string;
  agent: EvalAgent;
  /** Passed the agent's own checks: a person could apply or send it as it is. */
  accepted: boolean;
  /**
   * Does what the case expects: for the bank agent, the right kind of suggestion pointing at the
   * right records (amounts are the checks' job); for the others, the whole answer.
   */
  correct: boolean;
  /** Accepted but wrong: the checks did not stop it. */
  unsafe: boolean;
  /** Why it was not accepted or not correct. */
  notes: string[];
}

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** Grades one answer; an answer for another agent, or no answer at all (null), is neither accepted nor correct. */
export function gradeAgentAnswer(c: AgentEvalCase, answer: AgentAnswer | null): EvalGrade {
  const grade = (accepted: boolean, correct: boolean, notes: string[]): EvalGrade => ({
    caseId: c.id,
    agent: c.agent,
    accepted,
    correct,
    unsafe: accepted && !correct && (c.agent === 'BANKING' || c.agent === 'CLOSE'),
    notes,
  });
  if (!answer) return grade(false, false, ['No usable answer']);
  if (answer.agent !== c.agent) return grade(false, false, [`An answer for the ${answer.agent} agent`]);

  if (c.agent === 'BANKING' && answer.agent === 'BANKING') {
    const p = answer.proposal;
    const { checks, resolved } = checkProposal(c.context, p);
    const accepted = p.action !== 'NONE' && !!resolved && checks.every((x) => x.ok);
    const e = c.expect;
    const wrong: string[] = [];
    if (p.action !== e.action) wrong.push(`${p.action} instead of ${e.action}`);
    else {
      if (e.ledgerRefs && !sameSet(p.ledgerRefs ?? [], e.ledgerRefs)) wrong.push(`ledger lines ${(p.ledgerRefs ?? []).join(', ') || 'none'} instead of ${e.ledgerRefs.join(', ')}`);
      if (e.contactRef && p.contactRef !== e.contactRef) wrong.push(`contact ${p.contactRef ?? 'none'} instead of ${e.contactRef}`);
      if (e.documentRefs && !sameSet((p.allocations ?? []).map((a) => a.documentRef), e.documentRefs)) wrong.push(`applied to ${(p.allocations ?? []).map((a) => a.documentRef).join(', ') || 'nothing'} instead of ${e.documentRefs.join(', ')}`);
      if (e.accountCode && p.accountCode !== e.accountCode) wrong.push(`account ${p.accountCode ?? 'none'} instead of ${e.accountCode}`);
    }
    const failed = checks.filter((x) => !x.ok).map((x) => x.label);
    return grade(accepted, wrong.length === 0, [...wrong, ...(p.action === 'NONE' ? [] : failed)]);
  }

  if (c.agent === 'CLOSE' && answer.agent === 'CLOSE') {
    const results = answer.adjustments.map((a) => ({ a, r: checkAdjustment(c.context, a) }));
    const passing = results.filter((x) => x.r.resolved);
    const notes = results.filter((x) => !x.r.resolved).map((x) => `"${x.a.description}" fails: ${x.r.checks.filter((k) => !k.ok).map((k) => k.label).join('; ')}`);
    const key = (accounts: string[], total: string) => `${[...new Set(accounts)].sort().join('+')}=${new D(total).toFixed(2)}`;
    const want = c.expect.entries.map((e) => key(e.accounts, e.total)).sort();
    const got = passing.map((x) => key(x.r.resolved!.lines.map((l) => l.accountCode), x.r.resolved!.total)).sort();
    const extra = got.filter((g) => !want.includes(g));
    const missing = want.filter((w) => !got.includes(w));
    if (extra.length) notes.push(`Entries the month does not need: ${extra.join(', ')}`);
    if (missing.length) notes.push(`Entries missing: ${missing.join(', ')}`);
    // Accepted: every entry it proposed passes the checks (proposing nothing passes).
    const accepted = results.every((x) => x.r.resolved);
    return { caseId: c.id, agent: c.agent, accepted, correct: extra.length === 0 && missing.length === 0 && accepted, unsafe: extra.length > 0, notes };
  }

  if (c.agent === 'COLLECTIONS' && answer.agent === 'COLLECTIONS') {
    const checks = checkDraft(c.facts, answer.subject, answer.body);
    const accepted = draftPasses(checks);
    const text = `${answer.subject}\n${answer.body}`;
    const missing = c.expect.mustMention.filter((m) => !text.includes(m));
    const notes = [...checks.filter((x) => !x.ok).map((x) => x.label), ...(missing.length ? [`Does not mention ${missing.join(', ')}`] : [])];
    if (!c.expect.risk.includes(answer.risk)) notes.push(`Risk ${answer.risk}, expected ${c.expect.risk.join(' or ')}`);
    return grade(accepted, accepted && missing.length === 0 && c.expect.risk.includes(answer.risk), notes);
  }

  if (c.agent === 'CFO' && answer.agent === 'CFO') {
    const bad = checkSummaryFigures(answer.summary, c.facts);
    const accepted = answer.summary.trim().length > 0 && answer.summary.length <= 6000 && bad.length === 0;
    const missing = c.expect.mustMention.filter((m) => !answer.summary.includes(m));
    const notes = [...(bad.length ? [`Figures not in the books: ${bad.join(', ')}`] : []), ...(missing.length ? [`Does not mention ${missing.join(', ')}`] : [])];
    return grade(accepted, accepted && missing.length === 0, notes);
  }
  return grade(false, false, ['Unknown agent']);
}

export interface AgentScore {
  cases: number;
  accepted: number;
  correct: number;
  unsafe: number;
  /** Share of cases answered correctly, to 3 decimal places. */
  accuracy: number;
}

export interface EvalScore {
  byAgent: Partial<Record<EvalAgent, AgentScore>>;
  /** No unsafe answers, and every agent at or above the minimum accuracy. */
  passed: boolean;
  problems: string[];
}

/** Adds up grades per agent and checks them against a minimum accuracy (0 to 1). */
export function scoreAgentEvals(grades: readonly EvalGrade[], minAccuracy: number): EvalScore {
  const byAgent: Partial<Record<EvalAgent, AgentScore>> = {};
  for (const g of grades) {
    const s = (byAgent[g.agent] ??= { cases: 0, accepted: 0, correct: 0, unsafe: 0, accuracy: 0 });
    s.cases++;
    if (g.accepted) s.accepted++;
    if (g.correct) s.correct++;
    if (g.unsafe) s.unsafe++;
  }
  const problems: string[] = [];
  for (const [agent, s] of Object.entries(byAgent) as [EvalAgent, AgentScore][]) {
    s.accuracy = Math.round((s.correct / s.cases) * 1000) / 1000;
    if (s.unsafe) problems.push(`${agent}: ${s.unsafe} answer${s.unsafe === 1 ? '' : 's'} passed the checks but ${s.unsafe === 1 ? 'was' : 'were'} wrong`);
    if (s.accuracy < minAccuracy) problems.push(`${agent}: ${s.correct} of ${s.cases} correct (${(s.accuracy * 100).toFixed(1)}%), below ${(minAccuracy * 100).toFixed(0)}%`);
  }
  return { byAgent, passed: problems.length === 0, problems };
}
