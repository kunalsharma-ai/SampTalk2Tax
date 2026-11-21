/** Shapes the internal controls API returns (AUDIT-008, AUDIT-013). */
export type Person = { id: string; name: string };
export type Period = { key: string; label: string; from: string; to: string };
export type ControlStatus = 'PASSED' | 'FAILED' | 'DUE' | 'OVERDUE' | 'INACTIVE';
export interface ControlTest {
  id: string;
  periodKey: string;
  from: string;
  to: string;
  result: 'PASS' | 'FAIL';
  method: 'AUTOMATIC' | 'MANUAL';
  notes: string | null;
  evidence: { summary: string; exceptions: string[] } | null;
  selfTested: boolean;
  testedBy: Person;
  testedAt: string;
  /** The finding raised from this test, if any (failed tests only). */
  finding?: { id: string; reference: string; status: string } | null;
}
export interface Control {
  id: string;
  title: string;
  objective: string;
  area: string;
  frequency: 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
  check: string | null;
  checkDescription: string | null;
  templateId: string | null;
  owner: Person;
  active: boolean;
  duePeriod: Period;
  status: ControlStatus;
  canTest: boolean;
  isOwner: boolean;
}
export interface Register {
  controls: (Control & { lastTest: ControlTest | null })[];
  library: { id: string; title: string; objective: string; area: string; frequency: Control['frequency']; check: string | null; checkDescription: string | null }[];
  members: (Person & { role: string })[];
  canManage: boolean;
  summary: { passed: number; failed: number; due: number; overdue: number };
}

export const STATUS: Record<ControlStatus, { label: string; tone: 'positive' | 'negative' | 'warning' | 'neutral' }> = {
  PASSED: { label: 'Passed', tone: 'positive' },
  FAILED: { label: 'Failed', tone: 'negative' },
  DUE: { label: 'Due', tone: 'warning' },
  OVERDUE: { label: 'Overdue', tone: 'negative' },
  INACTIVE: { label: 'Not in use', tone: 'neutral' },
};
export const AREAS = ['CASH', 'PAYABLES', 'RECEIVABLES', 'LEDGER', 'ACCESS', 'TAX', 'PAYROLL', 'OTHER'] as const;
export const FREQUENCIES = ['MONTHLY', 'QUARTERLY', 'YEARLY'] as const;
export const words = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
