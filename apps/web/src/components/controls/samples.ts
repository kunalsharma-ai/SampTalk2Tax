/** Shapes the audit sampling API returns (AUDIT-009). */
type Person = { id: string; name: string };
export type SampleReason = 'RANDOM' | 'MONETARY_UNIT' | 'HIGH_VALUE' | 'ABOVE_INTERVAL';
export interface SampleSummary {
  id: string;
  reference: string;
  name: string;
  population: 'JOURNALS' | 'BILLS' | 'INVOICES' | 'PAYMENTS';
  populationLabel: string;
  from: string;
  to: string;
  method: 'RANDOM' | 'MONETARY_UNIT' | 'HIGH_VALUE';
  size: number;
  threshold: string | null;
  interval: string | null;
  seed: string;
  populationCount: number;
  populationTotal: string;
  status: 'OPEN' | 'COMPLETED';
  progress: { tested: number; exceptions: number; remaining: number };
  createdBy: Person;
  createdAt: string;
  completedAt: string | null;
}
export interface Sample extends SampleSummary {
  populationChanged: boolean;
  redrawMatches: boolean;
  items: { refId: string; label: string; date: string; amount: string; reason: SampleReason; result: 'OK' | 'EXCEPTION' | null; note: string | null; testedBy: Person | null; testedAt: string | null }[];
}

export const METHODS: Record<SampleSummary['method'], { label: string; hint: string }> = {
  RANDOM: { label: 'Random', hint: 'Every item has the same chance' },
  MONETARY_UNIT: { label: 'Monetary unit', hint: 'Larger amounts are likelier; any item above the interval is always picked' },
  HIGH_VALUE: { label: 'High value', hint: 'Every item at or above the threshold, then a random pick of the rest' },
};
export const REASONS: Record<SampleReason, string> = { RANDOM: 'Random pick', MONETARY_UNIT: 'Monetary unit', HIGH_VALUE: 'At or above threshold', ABOVE_INTERVAL: 'Above the interval' };

/** Where an item opens in the app. */
export function itemHref(orgId: string, population: SampleSummary['population'], refId: string): string {
  if (population === 'JOURNALS') return `/orgs/${orgId}/journals/${refId}`;
  if (population === 'BILLS') return `/orgs/${orgId}/purchases/bills/${refId}`;
  if (population === 'INVOICES') return `/orgs/${orgId}/sales/invoices/${refId}`;
  return `/orgs/${orgId}/purchases/payments/${refId}`;
}
