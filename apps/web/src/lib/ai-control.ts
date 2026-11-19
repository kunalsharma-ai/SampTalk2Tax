export type AiAgentKey = 'COPILOT' | 'COLLECTIONS' | 'BANKING' | 'CLOSE' | 'CFO';

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
  /** This month's cost at the organisation's prices, by model; tokens of unpriced models are counted apart. */
  cost: { amount: string; currency: string; unpricedTokens: number; models: { model: string; inputTokens: number; outputTokens: number; cost: string | null }[] };
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
  totals: { calls: number; tokens: number; failed: number; running: number; waiting: number; cost: string; unpricedTokens: number };
  currency: string;
  prices: AiModelPrice[];
  modelsUsed: string[];
  agents: AiAgentView[];
}

export interface AiModelPrice {
  model: string;
  inputPerMillion: string;
  outputPerMillion: string;
  changedBy: string;
  changedAt: string;
}

/** A US dollar amount from the API (4 decimal places): cents, or more places below a cent. */
export const usd = (amount: string) => {
  const [whole, frac = ''] = amount.split('.');
  const cents = frac.padEnd(4, '0');
  const small = whole === '0' && cents.slice(0, 2) === '00' && cents !== '0000';
  return `$${Number(whole).toLocaleString('en-US')}.${small ? cents : cents.slice(0, 2)}`;
};

export const tokens = (n: number) => n.toLocaleString('en-IN');

/** "2026-11" as "November 2026". */
export const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
