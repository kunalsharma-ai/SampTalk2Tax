/** Types for opportunity intelligence. */
import type { Change, Delta } from './impact';

export type OpportunityKind = 'WIN_BACK' | 'CROSS_SELL' | 'GROW_SEGMENT' | 'MARGIN_RECOVERY';
export interface Opportunity {
  key: string;
  kind: OpportunityKind;
  title: string;
  finding: string;
  evidence: { columns: string[]; rows: string[][] };
  assumptions: string[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  confidenceReason: string;
  changes: Change[];
  effect: Delta;
  summary: string;
}
export interface OpportunitiesResponse {
  currency: string;
  horizonMonths: number;
  window: { from: string; to: string };
  settings: { winBackRatePercent: string; crossSellRatePercent: string; segmentGrowthPercent: string };
  kinds: { key: OpportunityKind; label: string; description: string }[];
  opportunities: Opportunity[];
  checks: { kind: OpportunityKind; label: string; found: number; note: string }[];
  summary: string;
}
export const CONFIDENCE: Record<Opportunity['confidence'], { label: string; tone: 'positive' | 'warning' | 'neutral' }> = {
  HIGH: { label: 'High confidence', tone: 'positive' },
  MEDIUM: { label: 'Medium confidence', tone: 'neutral' },
  LOW: { label: 'Low confidence', tone: 'warning' },
};
