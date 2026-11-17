import type { VendorRiskDecision, VendorRiskFactor, VendorRiskLevel, VendorReviewNeed } from '@talk2tax/accounting-engine';

export interface LastRiskReview {
  id: string;
  level: VendorRiskLevel;
  factorCodes: string[];
  decision: VendorRiskDecision;
  note: string;
  reviewedOn: string;
  nextReviewOn: string;
  reviewedBy: string | null;
}
export interface VendorRiskRow {
  id: string;
  name: string;
  level: VendorRiskLevel;
  factors: VendorRiskFactor[];
  need: VendorReviewNeed;
  newFactors: string[];
  spend: string;
  share: string | null;
  owed: string;
  lastReview: LastRiskReview | null;
}
export const LEVEL_TONE = { NONE: 'positive', LOW: 'neutral', MEDIUM: 'warning', HIGH: 'negative' } as const;
export const NEED_LABEL: Record<Exclude<VendorReviewNeed, null>, string> = {
  NEVER_REVIEWED: 'Not reviewed yet',
  NEW_RISK: 'New risk since the last review',
  REVIEW_DUE: 'Review date reached',
};
