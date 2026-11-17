import { dec, minorUnits, roundToCurrency } from './money';

/**
 * Tax notices (Directive India module, TAX-024): letters from tax authorities asking for a
 * reply, information or payment. The organisation records each one, tracks the reply deadline,
 * keeps the notice and its reply on file, and closes it with an outcome.
 */

export type TaxAuthority = 'GST' | 'INCOME_TAX' | 'TDS' | 'PF' | 'ESI' | 'PROFESSIONAL_TAX' | 'OTHER';
export const TAX_AUTHORITIES: readonly TaxAuthority[] = ['GST', 'INCOME_TAX', 'TDS', 'PF', 'ESI', 'PROFESSIONAL_TAX', 'OTHER'];
export const TAX_AUTHORITY_LABEL: Record<TaxAuthority, string> = {
  GST: 'GST',
  INCOME_TAX: 'Income tax',
  TDS: 'TDS / TCS',
  PF: 'Provident fund',
  ESI: 'ESI',
  PROFESSIONAL_TAX: 'Professional tax',
  OTHER: 'Other',
};
export type TaxNoticeStatus = 'OPEN' | 'RESPONDED' | 'CLOSED';
export type TaxNoticeOutcome = 'DROPPED' | 'DEMAND_PAID' | 'APPEALED' | 'OTHER';
export type TaxNoticeUrgency = 'OVERDUE' | 'DUE_SOON' | 'UPCOMING' | 'NO_DEADLINE' | 'DONE';
/** How many days before the deadline a notice counts as due soon. */
export const NOTICE_DUE_SOON_DAYS = 7;

export interface TaxNoticeInput {
  authority: TaxAuthority;
  reference: string;
  section?: string | null;
  subject: string;
  period?: string | null;
  receivedOn: string;
  responseDue?: string | null;
  demand?: string | null;
}

/** Problems with a notice as entered, or an empty list. */
export function taxNoticeIssues(n: TaxNoticeInput, currency: string, today: string): string[] {
  const issues: string[] = [];
  if (!TAX_AUTHORITIES.includes(n.authority)) issues.push('Choose the authority that sent the notice');
  if (!n.reference.trim()) issues.push('Enter the notice number (DIN, ARN or reference on the letter)');
  if (!n.subject.trim()) issues.push('Say what the notice is about');
  if (n.receivedOn > today) issues.push('The notice cannot be received in the future');
  if (n.responseDue && n.responseDue < n.receivedOn) issues.push('The reply cannot be due before the notice was received');
  if (n.demand != null && n.demand !== '') {
    try {
      const d = dec(n.demand);
      if (d.lt(0)) issues.push('The amount demanded cannot be negative');
      else if (!roundToCurrency(d, currency).eq(d)) issues.push(`The amount demanded has at most ${minorUnits(currency)} decimal places`);
    } catch {
      issues.push('The amount demanded must be a decimal amount');
    }
  }
  return issues;
}

/** How pressing a notice is today. */
export function taxNoticeUrgency(n: { status: TaxNoticeStatus; responseDue: string | null }, today: string): { urgency: TaxNoticeUrgency; daysLeft: number | null } {
  if (n.status !== 'OPEN') return { urgency: 'DONE', daysLeft: null };
  if (!n.responseDue) return { urgency: 'NO_DEADLINE', daysLeft: null };
  const daysLeft = Math.round((Date.parse(`${n.responseDue}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return { urgency: daysLeft < 0 ? 'OVERDUE' : daysLeft <= NOTICE_DUE_SOON_DAYS ? 'DUE_SOON' : 'UPCOMING', daysLeft };
}
