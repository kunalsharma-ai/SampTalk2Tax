import type { TaxDocumentKind, TaxDocumentReading } from '@talk2tax/tax-engine';

export type TaxDocumentView = TaxDocumentReading & { year: string | null; booksTds: string | null };

export interface TaxDocumentRow {
  id: string;
  number: string;
  source: 'PDF' | 'TEXT';
  fileName: string | null;
  kind: TaxDocumentKind;
  title: string;
  year: string | null;
  problems: number;
  status: 'READ' | 'REVIEWED';
  createdBy: string;
  createdAt: string;
}

export interface TaxDocumentDetail {
  id: string;
  number: string;
  source: 'PDF' | 'TEXT';
  fileName: string | null;
  pages: number;
  text: string;
  kind: TaxDocumentKind;
  reading: TaxDocumentView;
  status: 'READ' | 'REVIEWED';
  reviewNote: string | null;
  createdBy: string;
  createdAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
}
