/** Revenue forecast as the API returns it (all money as decimal strings, before tax). */
export interface ForecastMonth {
  month: string;
  contracts: string;
  orders: string;
  pipelineWeighted: string;
  pipelineFull: string;
  otherSales: string;
  committed: string;
  expected: string;
  best: string;
}

export interface ForecastItem {
  month: string;
  stream: 'CONTRACT' | 'ORDER' | 'DEAL';
  id: string;
  reference: string;
  label: string;
  customer: string;
  amount: string;
  expected: string;
}

export interface RevenueForecast {
  asOf: string;
  currency: string;
  horizon: number;
  otherRunRate: string;
  actualSoFar: string;
  months: ForecastMonth[];
  totals: Omit<ForecastMonth, 'month'>;
  items: ForecastItem[];
  can: { save: boolean };
}

export interface SavedForecastSummary {
  id: string;
  reference: string;
  asOf: string;
  months: number;
  committed: string;
  expected: string;
  best: string;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  monthsOver: number;
  wape: string | null;
}

export interface SavedForecast {
  id: string;
  reference: string;
  asOf: string;
  horizon: number;
  currency: string;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  actualSoFar: string;
  otherRunRate: string;
  totals: Omit<ForecastMonth, 'month'>;
  months: ForecastMonth[];
  items: ForecastItem[];
  accuracy: { months: { month: string; forecast: string; committed: string; actual: string; variance: string; variancePct: string | null }[]; wape: string | null };
}

export const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
export const STREAM_LABEL: Record<ForecastItem['stream'], string> = { CONTRACT: 'Contract', ORDER: 'Sales order', DEAL: 'Deal' };
