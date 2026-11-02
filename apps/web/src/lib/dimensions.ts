'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';

export type DimensionType = 'DEPARTMENT' | 'PROJECT';

export interface DimensionValue {
  id: string;
  type: DimensionType;
  code: string;
  name: string;
  description: string | null;
  customer: string | null;
  startDate: string | null;
  endDate: string | null;
  isActive: boolean;
  lines: number;
  createdAt: string;
}

export interface DimensionList {
  values: DimensionValue[];
  can: { manage: boolean };
}

export interface ProfitRow { accountId: string; code: string; name: string; amounts: string[]; total: string }
export interface ProfitSection { type: 'REVENUE' | 'EXPENSE'; rows: ProfitRow[]; totals: string[]; total: string }
export interface ProfitByDimension {
  type: DimensionType;
  from: string;
  to: string;
  currency: string;
  columns: { id: string | null; code: string | null; name: string }[];
  sections: ProfitSection[];
  netProfit: string[];
  netProfitTotal: string;
  margin: (string | null)[];
}

export const TYPE_LABEL: Record<DimensionType, string> = { DEPARTMENT: 'Department', PROJECT: 'Project' };

/** Every department and project of the organisation (active and inactive), with how many lines use each. */
export function useDimensions() {
  const { orgId } = useOrg();
  return useQuery({ queryKey: ['dimensions', orgId], queryFn: () => api<DimensionList>(`/v1/orgs/${orgId}/dimensions`), enabled: !!orgId });
}

/** The choices for a line: active values, plus the one already on the line even when it is inactive now. */
export function lineChoices(values: DimensionValue[] | undefined, type: DimensionType, current?: string | null) {
  return (values ?? []).filter((v) => v.type === type && (v.isActive || v.id === current));
}

export const dimLabel = (v?: DimensionValue) => (v ? `${v.code} · ${v.name}` : '');
