'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';

export interface FinancialTagValue { code: string; name: string; isActive: boolean }
export interface FinancialTag { id: string; key: string; label: string; isActive: boolean; values: FinancialTagValue[]; createdAt: string; updatedAt: string }
export interface FinancialTagList { items: FinancialTag[]; presets: { key: string; label: string }[] }

export interface ProfitByTag {
  tag: { key: string; label: string };
  from: string;
  to: string;
  currency: string;
  columns: { code: string | null; name: string; revenue: string; expenses: string; netIncome: string }[];
  rows: { accountId: string; code: string; name: string; type: 'REVENUE' | 'EXPENSE'; amounts: string[]; total: string }[];
  total: { revenue: string; expenses: string; netIncome: string };
}

export function useFinancialTags() {
  const { orgId } = useOrg();
  return useQuery({ queryKey: ['financial-tags', orgId], queryFn: () => api<FinancialTagList>(`/v1/orgs/${orgId}/financial-tags`), enabled: !!orgId });
}
