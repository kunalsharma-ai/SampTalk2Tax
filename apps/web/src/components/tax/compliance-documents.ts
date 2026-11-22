import type { ComplianceDocKind } from '@talk2tax/tax-engine';

export interface ComplianceDocument {
  id: string;
  reference: string;
  kind: ComplianceDocKind;
  kindLabel: string;
  obligation: { key: string; name: string | null; periodLabel: string | null } | null;
  title: string;
  documentReference: string | null;
  note: string | null;
  retainUntil: string | null;
  status: 'ACTIVE' | 'VOID';
  voidReason: string | null;
  voidedBy: string | null;
  voidedAt: string | null;
  files: { id: string; fileName: string }[];
  addedBy: string;
  addedAt: string;
  canManage?: boolean;
}
