'use client';
import { useQuery } from '@tanstack/react-query';
import type { InvoicePalette, InvoicePrintSource, InvoiceTheme, LayoutConfig, PresetId, TemplateEngine } from '@talk2tax/accounting-engine';
import { api } from './api';
import { useOrgId } from './org';

export type { InvoicePalette, InvoicePrintSource, InvoiceTheme, LayoutConfig, PresetId, TemplateEngine };

export interface TemplateSummary {
  id: string;
  name: string;
  presetId: PresetId;
  presetName: string;
  engine: TemplateEngine;
  theme: InvoiceTheme;
  palette: InvoicePalette;
  title: string;
  isDefault: boolean;
  archived: boolean;
  hasLogo: boolean;
  documentsUsing: number;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateDetail extends TemplateSummary {
  layout: LayoutConfig;
  html: string | null;
  logoDataUrl: string | null;
  warnings: string[];
}

export interface TemplateList {
  suggestedPresetId: PresetId;
  items: TemplateSummary[];
}

export interface ResolvedTemplate {
  id: string | null;
  name: string;
  presetId: PresetId;
  engine: TemplateEngine;
  layout: LayoutConfig;
  html: string | null;
  logoDataUrl: string | null;
  builtIn: boolean;
}

export interface SignatureState {
  current: {
    id: string;
    signerName: string;
    designation: string | null;
    signedById: string;
    signedByName: string | null;
    signedAt: string;
    contentHash: string;
    imageDataUrl: string;
  } | null;
  verification: { status: 'VALID' | 'CHANGED' | 'VOIDED'; message: string } | null;
  currentHash: string;
  history: { id: string; signerName: string; designation: string | null; signedAt: string; contentHash: string; withdrawnAt: string | null; withdrawnByName: string | null; withdrawReason: string | null }[];
}

export interface PrintData {
  document: { id: string; kind: 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE'; status: 'DRAFT' | 'POSTED' | 'VOID'; number: string | null; templateId: string | null; contactName: string };
  source: InvoicePrintSource;
  template: ResolvedTemplate;
  templates: { id: string; name: string; isDefault: boolean; engine: TemplateEngine }[];
  signature: SignatureState;
}

export interface MySignature {
  signature: { id: string; kind: 'DRAWN' | 'UPLOADED' | 'TYPED'; signerName: string; designation: string | null; imageDataUrl: string; createdAt: string } | null;
  documentsSigned: number;
}

export function useTemplates(archived = false) {
  const orgId = useOrgId();
  return useQuery({ queryKey: ['invoice-templates', orgId, archived], queryFn: () => api<TemplateList>(`/v1/orgs/${orgId}/invoice-templates${archived ? '?archived=1' : ''}`) });
}

/** Reads a chosen image file as a data: URL (the API checks the bytes and the size). */
export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}
