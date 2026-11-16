export type Severity = 'CRITICAL' | 'WARNING' | 'INFO';
export type AlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'DISMISSED' | 'CLEARED';
export type Area = 'CASH' | 'COMPLIANCE' | 'PERFORMANCE' | 'LEAKAGE' | 'CONTROLS';

export interface EvidenceLink {
  kind: 'INVOICE' | 'BILL' | 'PAYMENT' | 'JOURNAL' | 'CUSTOMER' | 'VENDOR' | 'PAGE';
  id?: string;
  path?: string;
  label: string;
}
export interface Evidence {
  facts: { label: string; value: string; kind?: 'money' | 'date' | 'text' }[];
  links: EvidenceLink[];
  rows?: { columns: string[]; items: { link?: EvidenceLink; cells: string[] }[] };
}
export interface Alert {
  id: string;
  rule: string;
  ruleName: string;
  area: Area | null;
  severity: Severity;
  title: string;
  summary: string;
  amount: string | null;
  evidence: Evidence;
  status: AlertStatus;
  statusNote: string | null;
  statusBy: string | null;
  statusAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  clearedAt: string | null;
  reopenCount: number;
  priority: Priority;
}
export type Band = 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
export interface Priority {
  /** 0 to 100; higher needs attention sooner. */
  score: number;
  band: Band;
  reasons: string[];
}
export interface AlertDetail extends Alert {
  ruleDescription: string | null;
  history: { id: string; action: 'OPENED' | 'ACKNOWLEDGED' | 'DISMISSED' | 'REOPENED' | 'CLEARED'; by: string | null; automatic: boolean; note: string | null; at: string }[];
}
export interface Scan {
  id: string;
  ranBy: string | null;
  automatic: boolean;
  startedAt: string;
  finishedAt: string;
  rulesRun: number;
  found: number;
  opened: number;
  reopened: number;
  cleared: number;
  failures: { rule: string; message: string }[];
}
export interface AlertList {
  currency: string;
  staleAfterMinutes: number;
  lastScan: Scan | null;
  summary: { open: number; acknowledged: number; dismissed: number; cleared: number; critical: number; warning: number; info: number };
  /** Average monthly revenue the amounts were judged against; null with no revenue yet. */
  monthlyRevenue: string | null;
  bands: { urgent: number; high: number; normal: number; low: number };
  alerts: Alert[];
}
export interface NotificationSetting {
  minSeverity: 'CRITICAL' | 'WARNING' | 'OFF';
  taskRole: 'OWNER' | 'ADMIN' | 'ACCOUNTANT' | 'APPROVER';
  dueDays: number;
  isDefault: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}
export interface AlertRule {
  key: string;
  area: Area;
  name: string;
  description: string;
  params: { key: string; label: string; unit: 'days' | 'percent' | 'amount' | 'times' | 'months'; min: string; max: string; default: string; integer: boolean }[];
  enabled: boolean;
  values: Record<string, string>;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const SEVERITY: Record<Severity, { label: string; tone: 'negative' | 'warning' | 'accent'; bar: string }> = {
  CRITICAL: { label: 'Critical', tone: 'negative', bar: 'bg-negative' },
  WARNING: { label: 'Warning', tone: 'warning', bar: 'bg-warning' },
  INFO: { label: 'Info', tone: 'accent', bar: 'bg-accent' },
};
export const BAND: Record<Band, { label: string; tone: 'negative' | 'warning' | 'neutral' | 'accent' }> = {
  URGENT: { label: 'Urgent', tone: 'negative' },
  HIGH: { label: 'High', tone: 'warning' },
  NORMAL: { label: 'Normal', tone: 'accent' },
  LOW: { label: 'Low', tone: 'neutral' },
};
export const STATUS: Record<AlertStatus, { label: string; tone: 'neutral' | 'accent' | 'positive' | 'violet' }> = {
  OPEN: { label: 'Open', tone: 'neutral' },
  ACKNOWLEDGED: { label: 'Acknowledged', tone: 'violet' },
  DISMISSED: { label: 'Dismissed', tone: 'neutral' },
  CLEARED: { label: 'Cleared', tone: 'positive' },
};
export const AREAS: { key: Area; label: string }[] = [
  { key: 'CASH', label: 'Cash' },
  { key: 'COMPLIANCE', label: 'Compliance' },
  { key: 'PERFORMANCE', label: 'Performance' },
  { key: 'LEAKAGE', label: 'Leakage' },
  { key: 'CONTROLS', label: 'Controls' },
];
export const ACTION_LABEL: Record<AlertDetail['history'][number]['action'], string> = {
  OPENED: 'Found',
  ACKNOWLEDGED: 'Acknowledged',
  DISMISSED: 'Dismissed',
  REOPENED: 'Reopened',
  CLEARED: 'Cleared',
};

/** Where a piece of evidence lives in the app. */
export function evidenceHref(orgId: string, l: EvidenceLink): string | null {
  const base = `/orgs/${orgId}`;
  switch (l.kind) {
    case 'INVOICE':
      return `${base}/sales/invoices/${l.id}`;
    case 'BILL':
      return `${base}/purchases/bills/${l.id}`;
    case 'PAYMENT':
      return `${base}/purchases/payments/${l.id}`;
    case 'JOURNAL':
      return `${base}/journals/${l.id}`;
    case 'CUSTOMER':
      return `${base}/sales/customers/${l.id}`;
    case 'VENDOR':
      return `${base}/purchases/vendors/${l.id}`;
    case 'PAGE':
      return l.path?.startsWith('/') ? `${base}${l.path}` : null;
  }
}

/** "5 minutes ago", "3 hours ago", or a date. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
