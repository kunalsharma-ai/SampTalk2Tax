'use client';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { api } from './api';
import type { Account, Org, Period } from './types';

export function useOrgId(): string {
  return useParams<{ orgId: string }>().orgId;
}

export function useOrgs() {
  return useQuery({ queryKey: ['orgs'], queryFn: () => api<Org[]>('/v1/orgs') });
}

export function useOrg() {
  const orgId = useOrgId();
  const orgs = useOrgs();
  return { ...orgs, org: orgs.data?.find((o) => o.id === orgId), orgId };
}

export function useAccounts(includeInactive = false) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['accounts', orgId, includeInactive],
    queryFn: () => api<Account[]>(`/v1/orgs/${orgId}/accounts${includeInactive ? '?includeInactive=true' : ''}`),
  });
}

export function usePeriods() {
  const orgId = useOrgId();
  return useQuery({ queryKey: ['periods', orgId], queryFn: () => api<Period[]>(`/v1/orgs/${orgId}/periods`) });
}
