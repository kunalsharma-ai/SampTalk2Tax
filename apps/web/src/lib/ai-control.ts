export type AiAgentKey = 'COPILOT' | 'COLLECTIONS' | 'BANKING' | 'CLOSE';

export interface AiAgentView {
  key: AiAgentKey;
  name: string;
  does: string;
  level: number;
  levelLabel: string;
  approval: string | null;
  link: string;
  enabled: boolean;
  monthlyTokenLimit: number | null;
  usage: { calls: number; inputTokens: number; outputTokens: number; tokens: number; failed: number; percentOfBudget: number | null };
  budgetReached: boolean;
  accuracy: { accepted: number; acceptedWithEdits: number; rejected: number; waiting: number; rate: number | null } | null;
  running: number;
  lastUsedAt: string | null;
  changedBy: string | null;
  changedAt: string | null;
}

export interface AiControlView {
  month: string;
  accuracyDays: number;
  configured: boolean;
  provider: string;
  model: string;
  enabled: boolean;
  stopped: boolean;
  offReason: string | null;
  changedBy: string | null;
  changedAt: string | null;
  canManage: boolean;
  levels: { level: number; label: string }[];
  totals: { calls: number; tokens: number; failed: number; running: number; waiting: number };
  agents: AiAgentView[];
}

export const tokens = (n: number) => n.toLocaleString('en-IN');

/** "2026-11" as "November 2026". */
export const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
