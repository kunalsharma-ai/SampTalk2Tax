/** Types for the bill reader (AP-025). */
export type FieldSource = 'FOUND' | 'GUESSED' | 'MISSING';
export interface Field<T> {
  value: T | null;
  source: FieldSource;
}
export interface BillReadingResult {
  supplier: { name: string | null; taxId: string | null; contactId: string | null; matchedBy: 'TAX_ID' | 'NAME' | null; source: FieldSource };
  buyerTaxId: string | null;
  invoiceNumber: Field<string>;
  issueDate: Field<string>;
  dueDate: Field<string>;
  currency: Field<string>;
  lines: { description: string; hsnCode: string | null; quantity: string; unitPrice: string; amount: string; sourceLine: number }[];
  linesFrom: 'TABLE' | 'TOTAL_ONLY' | 'NONE';
  subtotal: string | null;
  taxes: { label: string; rate: string | null; amount: string }[];
  taxTotal: string | null;
  rounding: string | null;
  total: string | null;
  taxPercent: Field<string>;
  checks: string[];
  suggestions: { accountId: string | null; accountName: string | null; taxRateId: string | null }[];
  duplicateOf: { id: string; number: string | null } | null;
}
export interface BillReading {
  id: string;
  number: string;
  source: 'PDF' | 'TEXT';
  fileName: string | null;
  sizeBytes: number;
  pages: number;
  text: string;
  reading: BillReadingResult;
  status: 'READ' | 'SAVED' | 'DISCARDED';
  bill: { id: string; number: string | null; status: string } | null;
  attachmentId: string | null;
  createdBy: string;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
}
export interface BillReadingRow {
  id: string;
  number: string;
  source: 'PDF' | 'TEXT';
  fileName: string | null;
  supplier: string | null;
  invoiceNumber: string | null;
  total: string | null;
  currency: string | null;
  checks: number;
  status: BillReading['status'];
  bill: { id: string; number: string | null } | null;
  createdBy: string;
  createdAt: string;
}
export const SOURCE_LABEL: Record<FieldSource, string> = { FOUND: 'Found on the bill', GUESSED: 'Worked out', MISSING: 'Not found' };
