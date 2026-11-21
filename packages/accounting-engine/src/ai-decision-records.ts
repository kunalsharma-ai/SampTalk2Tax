/**
 * The explainable AI ledger's decision record (AUDIT-018, AUDIT-020, AUDIT-021, AUDIT-027,
 * AUDIT-029, AUDIT-030): for every call to an AI model, which agent made it and for whom, the
 * prompt and tools it ran with, the data it was given, when it ran, and a short explanation of
 * what it decided. The model's hidden reasoning (thinking blocks) is never copied into the
 * record or shown: only whether there was any.
 *
 * Works on plain request and response shapes, so it has no dependency on a provider SDK.
 */

export const AI_AGENTS = {
  COPILOT: { name: 'Copilot', does: 'Answers questions from the books with read-only report tools' },
  BANK_MATCHING: { name: 'Bank line assistant', does: 'Suggests a match, payment or entry for a bank statement line' },
  CLOSE_REVIEW: { name: 'Month-end reviewer', does: 'Reviews a month-end close and proposes adjusting entries' },
  COLLECTIONS: { name: 'Collections assistant', does: 'Drafts payment reminders from what a customer owes' },
  CFO_SUMMARY: { name: 'CFO report writer', does: 'Writes the summary of a management or board report' },
  POLICY_DRAFTER: { name: 'Policy drafter', does: 'Drafts an approval or spending policy from a description' },
  DASHBOARD_DRAFTER: { name: 'Dashboard drafter', does: 'Drafts a dashboard from a description' },
  REPORT_DESIGNER: { name: 'Report designer', does: 'Drafts a report layout from a description' },
  SETUP_ASSISTANT: { name: 'Setup assistant', does: 'Reads documents to suggest organisation settings' },
  OTHER: { name: 'Other AI call', does: 'An AI call Talk2Tax could not name' },
} as const;
export type AiAgentId = keyof typeof AI_AGENTS;

/** The forced tool each single-purpose agent answers through. */
const AGENT_BY_TOOL: Record<string, AiAgentId> = {
  submit_suggestion: 'BANK_MATCHING',
  submit_close_review: 'CLOSE_REVIEW',
  submit_reminder: 'COLLECTIONS',
  propose_policy: 'POLICY_DRAFTER',
  propose_dashboard: 'DASHBOARD_DRAFTER',
  propose_report: 'REPORT_DESIGNER',
  record_reading: 'SETUP_ASSISTANT',
};

/** Fields that hold an agent's own short account of why, in the order they are preferred. */
const EXPLANATION_FIELDS = ['reason', 'explanation', 'rationale', 'why', 'summary', 'notes', 'note'];
export const MAX_EXPLANATION = 500;

type Block = { type?: unknown; name?: unknown; id?: unknown; tool_use_id?: unknown; input?: unknown; text?: unknown };
type Message = { role?: unknown; content?: unknown };
export interface AiRequestShape {
  system?: unknown;
  tools?: { name?: unknown }[];
  tool_choice?: { type?: unknown; name?: unknown };
  thinking?: unknown;
  messages?: Message[];
}
export interface AiResponseShape {
  content?: Block[];
  stop_reason?: unknown;
}

const blocks = (m: Message): Block[] => (Array.isArray(m.content) ? (m.content as Block[]) : []);
const clip = (s: string, n = MAX_EXPLANATION) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** Which agent made a call: the caller's word when given, otherwise from the tool it was made to use. */
export function agentForRequest(req: AiRequestShape, given?: AiAgentId | null): AiAgentId {
  if (given) return given;
  const forced = req.tool_choice?.type === 'tool' && typeof req.tool_choice.name === 'string' ? AGENT_BY_TOOL[req.tool_choice.name] : undefined;
  if (forced) return forced;
  const tools = (req.tools ?? []).map((t) => t.name).filter((n): n is string => typeof n === 'string');
  const named = tools.map((t) => AGENT_BY_TOOL[t]).find(Boolean);
  if (named) return named;
  // The copilot works with many read-only tools and no forced choice.
  if (tools.length > 1) return 'COPILOT';
  return 'OTHER';
}

/**
 * The data the model was given in this call: the caller's list, plus each tool whose result the
 * model read (named by the tool, once each, in order).
 */
export function dataSourcesFor(req: AiRequestShape, given: string[] = []): string[] {
  const names = new Map<string, string>();
  for (const m of req.messages ?? []) for (const b of blocks(m)) if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') names.set(b.id, b.name);
  const used: string[] = [];
  for (const m of req.messages ?? []) for (const b of blocks(m)) if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') used.push(`Tool: ${names.get(b.tool_use_id) ?? 'unknown'}`);
  return [...new Set([...given.map((s) => clip(s, 200)), ...used])].slice(0, 50);
}

/** What stands for a private answer's words, such as a member's copilot conversation. */
export const PRIVATE_ANSWER = 'Answered in a private conversation; the words stay with the member who asked';

/**
 * A short account of what the model decided, from its own words: the reason field of the tool it
 * answered with, or the start of its text. Thinking blocks are never read. When the text is
 * private (a member's copilot answer), only the fact of the answer is kept.
 */
export function explanationFor(res: AiResponseShape, opts: { privateText?: boolean } = {}): string | null {
  const content = res.content ?? [];
  for (const b of content) {
    if (b.type !== 'tool_use' || !b.input || typeof b.input !== 'object') continue;
    const input = b.input as Record<string, unknown>;
    for (const f of EXPLANATION_FIELDS) if (typeof input[f] === 'string' && (input[f] as string).trim()) return clip(input[f] as string);
    return clip(`Used ${typeof b.name === 'string' ? b.name : 'a tool'}`);
  }
  const text = content.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join(' ');
  if (text.trim()) return opts.privateText ? PRIVATE_ANSWER : clip(text);
  return null;
}

/** Whether the response held hidden reasoning, which the record leaves out. */
export function reasoningWithheld(res: AiResponseShape): boolean {
  return (res.content ?? []).some((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
}

/** The text a prompt version is taken from: the system prompt, as sent. */
export function promptText(req: AiRequestShape): string {
  if (typeof req.system === 'string') return req.system;
  if (Array.isArray(req.system)) return (req.system as Block[]).map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n');
  return '';
}

/** The text a toolset version is taken from: each tool, as sent, in order. */
export function toolsText(req: AiRequestShape): string {
  return JSON.stringify(req.tools ?? []);
}
