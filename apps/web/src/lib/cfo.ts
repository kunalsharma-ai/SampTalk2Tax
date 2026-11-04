/** Types and labels for the virtual CFO. */
export type CfoArea = 'LIQUIDITY' | 'PROFITABILITY' | 'WORKING_CAPITAL' | 'GROWTH' | 'COSTS' | 'RISK' | 'DEBT' | 'CAPITAL' | 'PLANNING';
export type CfoVerdict = 'GOOD' | 'WATCH' | 'ACT' | 'NO_DATA';
export type CfoUnit = 'MONEY' | 'PERCENT' | 'DAYS' | 'MONTHS' | 'RATIO' | 'COUNT' | 'TEXT';
export type CfoGrade = 'STRONG' | 'FAIR' | 'WEAK' | 'CRITICAL';

export interface CfoFigure { label: string; value: string | null; unit: CfoUnit }
export interface CfoAction { text: string; path: string | null; approval: string | null }
export interface CfoFinding {
  key: string;
  area: CfoArea;
  title: string;
  verdict: CfoVerdict;
  summary: string;
  figures: CfoFigure[];
  period: { from: string; to: string; label: string };
  method: string;
  assumptions: string[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  confidenceReason: string;
  sources: { label: string; path: string }[];
  actions: CfoAction[];
  table?: { columns: { key: string; label: string; unit: CfoUnit }[]; rows: Record<string, string | number | null>[] };
}
export type CfoAnswer = CfoFinding & { question: string };
export interface CfoHealth { score: number; grade: CfoGrade; components: { key: string; label: string; points: number; max: number; reason: string }[] }
export interface CfoRecommendation extends CfoAction { area: CfoArea; why: string; priority: 'HIGH' | 'MEDIUM' }
export interface CfoAssessment {
  currency: string;
  asOf: string;
  lastMonth: string;
  health: CfoHealth;
  headline: string;
  findings: CfoFinding[];
  recommendations: CfoRecommendation[];
}
export interface CfoQuestion { key: string; question: string; allowed: boolean }

export type CfoReportKind = 'BOARD' | 'INVESTOR';
export interface CfoReportRow {
  id: string;
  kind: CfoReportKind;
  month: string;
  title: string;
  status: 'DRAFT' | 'FINAL';
  score: number;
  grade: CfoGrade;
  aiStatus: CfoAiStatus;
  createdBy: string;
  finalisedBy: string | null;
  createdAt: string;
  finalisedAt: string | null;
}
export type CfoAiStatus = 'NONE' | 'RUNNING' | 'DONE' | 'FAILED';
export interface CfoReport {
  id: string;
  kind: CfoReportKind;
  month: string;
  title: string;
  status: 'DRAFT' | 'FINAL';
  assessment: CfoAssessment;
  sections: string[];
  commentary: string | null;
  ai: { status: CfoAiStatus; summary: string | null; model: string | null; servedModel: string | null; errorCode: string | null; errorMessage: string | null; startedBy: string | null; startedAt: string | null; finishedAt: string | null };
  createdBy: string;
  finalisedBy: string | null;
  finalisedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface CfoAi { configured: boolean; model: string; available: boolean; reason: string | null; canChangeAi: boolean }

export const VERDICT: Record<CfoVerdict, { label: string; tone: 'positive' | 'warning' | 'negative' | 'neutral' }> = {
  GOOD: { label: 'Healthy', tone: 'positive' },
  WATCH: { label: 'Keep an eye on', tone: 'warning' },
  ACT: { label: 'Needs action', tone: 'negative' },
  NO_DATA: { label: 'Not enough data', tone: 'neutral' },
};
export const GRADE: Record<CfoGrade, { label: string; tone: 'positive' | 'warning' | 'negative' | 'accent' }> = {
  STRONG: { label: 'Strong', tone: 'positive' },
  FAIR: { label: 'Fair', tone: 'accent' },
  WEAK: { label: 'Weak', tone: 'warning' },
  CRITICAL: { label: 'Critical', tone: 'negative' },
};
export const CONFIDENCE: Record<CfoFinding['confidence'], string> = { HIGH: 'High confidence', MEDIUM: 'Medium confidence', LOW: 'Low confidence' };
export const KIND: Record<CfoReportKind, { label: string; help: string }> = {
  BOARD: { label: 'Board pack', help: 'Every area of the assessment, the risks and the decisions the board needs to take.' },
  INVESTOR: { label: 'Investor update', help: 'Growth, profitability, cash and runway, capital and debt.' },
};
