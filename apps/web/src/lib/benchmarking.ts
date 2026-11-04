/** Types and labels for privacy-preserving benchmarking. */
export type BenchmarkUnit = 'PERCENT' | 'DAYS' | 'MONEY';
export type BenchmarkPosition = 'TOP_QUARTER' | 'ABOVE_MEDIAN' | 'AT_MEDIAN' | 'BELOW_MEDIAN' | 'BOTTOM_QUARTER';
export interface BenchmarkDefinition { key: string; label: string; unit: BenchmarkUnit; better: 'HIGHER' | 'LOWER'; formula: string }
export interface BenchmarkMetric { key: string; value: string | null; reason: string | null; components: { label: string; amount: string }[] }
export interface BenchmarkComparison {
  key: string;
  value: string | null;
  group: { level: string; label: string } | null;
  aggregate: { peers: string; median: string; lowerQuartile: string | null; upperQuartile: string | null } | null;
  position: BenchmarkPosition | null;
  note: string | null;
}
export interface BenchmarkParticipation {
  status: 'OPTED_IN' | 'WITHDRAWN';
  industry: string;
  sizeBand: string;
  headcount: number | null;
  sharedMetrics: string[];
  consentVersion: number;
  consentCurrent: boolean;
  contributedPeriod: string | null;
  contributedAt: string | null;
  consentedAt: string;
  withdrawnAt: string | null;
}
export interface BenchmarkOverview {
  period: { month: string; label: string; from: string; to: string };
  currency: string;
  countryCode: string;
  pool: 'LIVE' | 'SYNTHETIC';
  headcount: number | null;
  headcountSource: 'PAYROLL' | 'ENTERED' | null;
  suggestedSizeBand: string | null;
  participation: BenchmarkParticipation | null;
  metrics: BenchmarkMetric[];
  comparison: BenchmarkComparison[] | null;
  methodology: {
    definitions: BenchmarkDefinition[];
    industries: { key: string; label: string }[];
    sizeBands: { key: string; label: string }[];
    minPeers: number;
    minPeersForQuartiles: number;
    freshMonths: number;
    consentVersion: number;
    consentText: string[];
  };
}

export const POSITION: Record<BenchmarkPosition, { label: string; tone: 'positive' | 'accent' | 'neutral' | 'warning' | 'negative' }> = {
  TOP_QUARTER: { label: 'Top quarter', tone: 'positive' },
  ABOVE_MEDIAN: { label: 'Better than the median', tone: 'accent' },
  AT_MEDIAN: { label: 'At the median', tone: 'neutral' },
  BELOW_MEDIAN: { label: 'Worse than the median', tone: 'warning' },
  BOTTOM_QUARTER: { label: 'Bottom quarter', tone: 'negative' },
};
