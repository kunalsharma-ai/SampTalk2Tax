/**
 * Compliance document management (TAX-025): which document each compliance obligation should
 * have on file, how long to keep it, and which filed returns and made payments are missing theirs.
 * Deterministic; no model is used.
 *
 * - A return (GSTR-1, GSTR-3B, GSTR-9, TDS/TCS statements) should have its acknowledgement (the
 *   ARN or token receipt); a payment (GST PMT-06, TDS/TCS deposits, PF, ESI, PT, advance tax) its
 *   challan.
 * - Keep until: the end of the eighth financial year after the one the period ends in (section
 *   128(5) of the Companies Act, 2013 keeps books for eight years; the GST and income-tax periods
 *   are shorter). Registration documents are kept while the registration lasts (no date).
 */
import { taxYearOf } from './withholding';

export const COMPLIANCE_DOC_KINDS = ['ACKNOWLEDGEMENT', 'CHALLAN', 'RETURN_COPY', 'WORKING', 'REGISTRATION', 'NOTICE', 'OTHER'] as const;
export type ComplianceDocKind = (typeof COMPLIANCE_DOC_KINDS)[number];
export const COMPLIANCE_DOC_KIND_LABEL: Record<ComplianceDocKind, string> = {
  ACKNOWLEDGEMENT: 'Acknowledgement',
  CHALLAN: 'Challan',
  RETURN_COPY: 'Copy of the return',
  WORKING: 'Working papers',
  REGISTRATION: 'Registration certificate',
  NOTICE: 'Notice or reply',
  OTHER: 'Other',
};
export const COMPLIANCE_RETENTION_YEARS = 8;

/** The document a done obligation should have: the acknowledgement of a return, the challan of a payment. */
export const expectedComplianceDocument = (nature: 'RETURN' | 'PAYMENT'): ComplianceDocKind => (nature === 'RETURN' ? 'ACKNOWLEDGEMENT' : 'CHALLAN');

/** Keep until the end of the eighth financial year after the one `periodTo` falls in; null when not tied to a period. */
export function complianceRetainUntil(periodTo: string | null): string | null {
  if (!periodTo) return null;
  const end = taxYearOf(periodTo).to;
  return `${Number(end.slice(0, 4)) + COMPLIANCE_RETENTION_YEARS}${end.slice(4)}`; // not money
}

export interface DoneObligation {
  key: string;
  name: string;
  periodLabel: string;
  dueDate: string;
  nature: 'RETURN' | 'PAYMENT';
}

export interface FiledDocument {
  obligationKey: string | null;
  kind: ComplianceDocKind;
  /** Files attached to the document now. */
  files: number;
}

export interface ComplianceDocumentGap extends DoneObligation {
  needs: ComplianceDocKind;
  /** A document of the right kind exists but has no file attached. */
  emptyRecord: boolean;
}

/** Done obligations without the document they should have (with at least one file), latest due date first. */
export function complianceDocumentGaps(done: readonly DoneObligation[], docs: readonly FiledDocument[]): ComplianceDocumentGap[] {
  const out: ComplianceDocumentGap[] = [];
  for (const o of done) {
    const needs = expectedComplianceDocument(o.nature);
    const mine = docs.filter((d) => d.obligationKey === o.key && d.kind === needs);
    if (mine.some((d) => d.files > 0)) continue;
    out.push({ ...o, needs, emptyRecord: mine.length > 0 });
  }
  return out.sort((a, b) => b.dueDate.localeCompare(a.dueDate) || a.name.localeCompare(b.name));
}
