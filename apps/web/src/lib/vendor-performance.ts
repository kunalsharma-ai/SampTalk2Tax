export type Grade = 'A' | 'B' | 'C' | 'D';

export const GRADE_TONE: Record<Grade, 'positive' | 'accent' | 'warning' | 'negative'> = { A: 'positive', B: 'accent', C: 'warning', D: 'negative' };

export const REVIEW_ASPECTS = ['Quality', 'Delivery', 'Communication', 'Pricing', 'Overall'] as const;

/** How the score is worked out, shown next to every scorecard (mirrors the engine). */
export const SCORE_RULES = [
  'On-time delivery (weight 40): orders with an expected date, fully received on or before it. An order still short after its date counts as late.',
  'Quality of goods (weight 30): 100 less 10 points for each 1% of goods rejected on receipt, by value at the order price.',
  'Billing accuracy (weight 20): bills linked to an order that matched without anyone accepting differences.',
  'Team reviews (weight 10): the average 1 to 5 rating, 1 = 0 and 5 = 100.',
  'Parts with nothing to measure are left out and the rest reweighted. Grade A from 90, B from 75, C from 60, otherwise D.',
];

export interface VendorPerformanceRow {
  contact: { id: string; name: string };
  score: string | null;
  grade: Grade | null;
  orders: number;
  onTimePercent: string | null;
  late: number;
  rejectedPercent: string | null;
  accuracyPercent: string | null;
  overcharge: string;
  spend: string;
  reviews: { count: number; average: string | null };
}

export interface VendorPerformanceList {
  from: string;
  to: string;
  currency: string;
  vendors: VendorPerformanceRow[];
  counts: Record<Grade | 'ungraded', number>;
  can: { review: boolean };
}

export interface Scorecard {
  orders: number;
  delivery: { measured: number; onTime: number; late: number; overdue: number; onTimePercent: string | null; averageDaysLate: string | null; detail: { orderId: string; ref: string; expectedDate: string; deliveredOn: string | null; outcome: 'ON_TIME' | 'LATE' | 'OVERDUE'; daysLate: number }[] };
  quality: { receivedValue: string; rejectedValue: string; rejectedPercent: string | null };
  price: { billedLines: number; linesAbovePrice: number; overcharge: string; variancePercent: string | null };
  billing: { bills: number; spend: string; linkedBills: number; withAcceptedDifferences: number; accuracyPercent: string | null; vendorCredits: number; vendorCreditValue: string };
  reviews: { count: number; average: string | null };
  parts: { key: string; label: string; score: string; weight: number }[];
  score: string | null;
  grade: Grade | null;
}

export interface VendorReview {
  id: string;
  reviewDate: string;
  aspect: string;
  rating: number;
  note: string | null;
  order: { id: string; ref: string } | null;
  by: string;
  mine: boolean;
  withdrawn: { at: string; by: string; reason: string | null } | null;
  createdAt: string;
}

export interface VendorPerformance {
  contact: { id: string; name: string };
  from: string;
  to: string;
  currency: string;
  scorecard: Scorecard;
  reviews: VendorReview[];
  orders: { id: string; ref: string; orderDate: string }[];
  can: { review: boolean };
}

export const pct = (x: string | null) => (x === null ? '—' : `${x}%`);
export const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);
