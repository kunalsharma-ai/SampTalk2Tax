export interface CopilotStatus {
  configured: boolean;
  provider: string;
  model: string;
  enabled: boolean;
  changedBy: string | null;
  changedAt: string | null;
  canChange: boolean;
  questionsPerHour: number;
  tools: string[];
  notice: import('@/components/ai/ai-notice').AiNotice;
}
export interface CopilotSource {
  tool: string;
  label: string;
  path: string;
  input: Record<string, unknown>;
  ok: boolean;
  error?: string;
}
export type CopilotMessageStatus = 'PENDING' | 'COMPLETE' | 'REFUSED' | 'INCOMPLETE' | 'FAILED';
export interface CopilotMessage {
  id: string;
  seq: number;
  role: 'USER' | 'ASSISTANT';
  status: CopilotMessageStatus;
  text: string | null;
  /** How a question was asked. */
  channel: 'TEXT' | 'VOICE';
  sources: CopilotSource[];
  errorCode: string | null;
  errorMessage: string | null;
  servedModel: string | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } | null;
  createdAt: string;
  completedAt: string | null;
}
export interface CopilotConversation {
  id: string;
  title: string;
  model: string;
  closed: boolean;
  createdAt: string;
  updatedAt: string;
  messages: CopilotMessage[];
  actions: CopilotAction[];
}
/** Something the assistant proposed; it happens only when the member confirms it. */
export interface CopilotAction {
  id: string;
  messageId: string;
  kind: 'CREATE_TASK' | 'ACKNOWLEDGE_ALERT' | 'DISMISS_ALERT';
  summary: string;
  sensitive: boolean;
  status: 'PROPOSED' | 'DONE' | 'CANCELLED' | 'FAILED' | 'EXPIRED';
  result: { path: string; label: string } | null;
  error: string | null;
  expiresAt: string;
  decidedAt: string | null;
  createdAt: string;
}
export interface CopilotConversationSummary {
  id: string;
  title: string;
  questions: number;
  closed: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Questions offered on an empty conversation. They only fill the question box. */
export const STARTERS = [
  'How did we do last month compared with the month before?',
  'Which customers owe us the most, and how much is overdue?',
  'Will our cash stay above the minimum balance over the next 90 days?',
  'What needs my attention right now?',
  'Are we over budget anywhere this year?',
  'Which filings or tax payments are due in the next 30 days?',
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function when(iso: string): string {
  const d = new Date(iso);
  const ist = new Date(d.getTime() + 5.5 * 3_600_000);
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const hm = ist.toISOString().slice(11, 16);
  return ist.toISOString().slice(0, 10) === today ? hm : `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]}${ist.getUTCFullYear() === new Date().getUTCFullYear() ? '' : ` ${ist.getUTCFullYear()}`}, ${hm}`;
}
