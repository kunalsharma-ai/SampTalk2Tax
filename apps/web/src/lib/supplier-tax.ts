import type { RegistrationStatus, TaxpayerType } from '@talk2tax/tax-engine';

export type Severity = 'HIGH' | 'MEDIUM' | 'LOW';
export interface SupplierIssueRow {
  code: string;
  severity: Severity;
  message: string;
  bills?: { number: string; id: string | null }[];
}
export interface Verification {
  status: RegistrationStatus;
  taxpayerType: TaxpayerType | null;
  checkedOn: string;
  legalName: string | null;
  effectiveDate: string | null;
}
export const SEVERITY_TONE = { HIGH: 'negative', MEDIUM: 'warning', LOW: 'neutral' } as const;
export const SEVERITY_LABEL = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' } as const;
