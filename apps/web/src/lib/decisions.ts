/** Types and labels for financial decision memory. */
export type DecisionStatus = 'ACTIVE' | 'REVIEWED' | 'WITHDRAWN';
export type Verdict = 'WORKED' | 'PARTLY' | 'DID_NOT_WORK';
export type OutcomeStatus = 'NOT_DUE' | 'MET' | 'MISSED' | 'NO_VALUE';
export interface Measure { key: string; label: string; unit: 'MONEY' | 'PERCENT' | 'RATIO' | 'DAYS' | 'MONTHS'; better: 'HIGHER' | 'LOWER'; formula: string }
export interface DecisionMeta { categories: { key: string; label: string }[]; verdicts: { key: Verdict; label: string }[]; measures: Measure[] }
export interface DecisionListItem {
  id: string;
  number: string;
  title: string;
  category: string;
  tags: string[];
  decidedOn: string;
  decidedBy: string | null;
  reviewDue: string | null;
  reviewOverdue: boolean;
  status: DecisionStatus;
  verdict: Verdict | null;
  suggestedVerdict: Verdict | null;
  lessons: string | null;
  outcomes: { met: number; missed: number; notDue: number; noValue: number };
}
export interface DecisionList extends DecisionMeta {
  items: DecisionListItem[];
  totals: { active: number; reviewed: number; withdrawn: number; dueForReview: number };
}
export interface Assumption { text: string; held: boolean | null; note: string | null }
export interface Outcome {
  kpi: string;
  label: string;
  unit: Measure['unit'];
  comparator: 'AT_LEAST' | 'AT_MOST';
  target: string;
  measureMonth: string;
  baselineMonth: string;
  baseline: string | null;
  actual: string | null;
  frozen: boolean;
  status: OutcomeStatus;
  change: string | null;
  improved: boolean | null;
  explanation: string;
}
export interface DecisionDetail {
  id: string;
  number: string;
  title: string;
  decision: string;
  context: string | null;
  category: string;
  tags: string[];
  decidedOn: string;
  decidedBy: string | null;
  reviewDue: string | null;
  reviewOverdue: boolean;
  assumptions: Assumption[];
  outcomes: Outcome[];
  suggestedVerdict: Verdict | null;
  status: DecisionStatus;
  verdict: Verdict | null;
  outcomeNotes: string | null;
  lessons: string | null;
  reviewedById: string | null;
  reviewedAt: string | null;
  withdrawnReason: string | null;
  withdrawnById: string | null;
  withdrawnAt: string | null;
  createdById: string;
  createdAt: string;
  currency: string;
  source: { type: string; id: string; label: string; path: string | null } | null;
  people: Record<string, string>;
}
export interface DecisionDraft {
  title: string;
  decision: string;
  context: string | null;
  category: string;
  tags: string[];
  decidedOn: string;
  decidedBy: string | null;
  reviewDue?: string | null;
  assumptions: { text: string }[];
  outcomes: { kpi: string; comparator: 'AT_LEAST' | 'AT_MOST'; target: string; measureMonth: string }[];
  sourceType?: 'SCENARIO' | 'RECOVERY_PLAN' | null;
  sourceId?: string | null;
}

export const STATUS: Record<DecisionStatus, { label: string; tone: 'accent' | 'positive' | 'neutral' }> = {
  ACTIVE: { label: 'Active', tone: 'accent' },
  REVIEWED: { label: 'Reviewed', tone: 'positive' },
  WITHDRAWN: { label: 'Withdrawn', tone: 'neutral' },
};
export const VERDICT: Record<Verdict, { label: string; tone: 'positive' | 'warning' | 'negative' }> = {
  WORKED: { label: 'Worked', tone: 'positive' },
  PARTLY: { label: 'Partly worked', tone: 'warning' },
  DID_NOT_WORK: { label: 'Did not work', tone: 'negative' },
};
export const OUTCOME: Record<OutcomeStatus, { label: string; tone: 'positive' | 'negative' | 'neutral' | 'warning' }> = {
  MET: { label: 'Met', tone: 'positive' },
  MISSED: { label: 'Missed', tone: 'negative' },
  NOT_DUE: { label: 'Not due yet', tone: 'neutral' },
  NO_VALUE: { label: 'No value', tone: 'warning' },
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthName = (m: string) => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
/** A KPI value in its unit; money is shown by the caller. */
export function unitText(unit: Measure['unit'], v: string): string {
  if (unit === 'PERCENT') return `${Number(v).toFixed(1)}%`;
  if (unit === 'DAYS') return `${Number(v).toFixed(1)} days`;
  if (unit === 'MONTHS') return `${Number(v).toFixed(1)} months`;
  if (unit === 'RATIO') return Number(v).toFixed(2);
  return v;
}
