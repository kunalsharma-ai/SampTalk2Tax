'use client';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { api } from './api';
import type { Account, Contact, Employee, GstRegistration, GstState, Org, PayrollSettings, Period, TaxRate, WithholdingSection, WithholdingSettings } from './types';

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

export function useContacts(role?: 'customer' | 'vendor', includeInactive = false) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ['contacts', orgId, role ?? 'all', includeInactive],
    queryFn: () => api<Contact[]>(`/v1/orgs/${orgId}/contacts?${role ? `role=${role}&` : ''}includeInactive=${includeInactive}`),
  });
}

export function useTaxRates(includeInactive = false) {
  const orgId = useOrgId();
  return useQuery({ queryKey: ['tax-rates', orgId, includeInactive], queryFn: () => api<TaxRate[]>(`/v1/orgs/${orgId}/tax-rates?includeInactive=${includeInactive}`) });
}

export function useGstRegistration() {
  const orgId = useOrgId();
  return useQuery({ queryKey: ['gst-registration', orgId], queryFn: () => api<GstRegistration>(`/v1/orgs/${orgId}/gst/registration`) });
}

export function useGstStates() {
  const orgId = useOrgId();
  return useQuery({ queryKey: ['gst-states'], queryFn: () => api<GstState[]>(`/v1/orgs/${orgId}/gst/states`), staleTime: Infinity });
}

export function useWithholdingSettings() {
  const orgId = useOrgId();
  return useQuery({ queryKey: ['withholding-settings', orgId], queryFn: () => api<WithholdingSettings>(`/v1/orgs/${orgId}/withholding/settings`) });
}

export function useWithholdingSections(includeInactive = false) {
  const orgId = useOrgId();
  return useQuery({ queryKey: ['withholding-sections', orgId, includeInactive], queryFn: () => api<WithholdingSection[]>(`/v1/orgs/${orgId}/withholding/sections?includeInactive=${includeInactive}`) });
}

export function usePayrollSettings() {
  const orgId = useOrgId();
  return useQuery({ queryKey: ['payroll-settings', orgId], queryFn: () => api<PayrollSettings>(`/v1/orgs/${orgId}/payroll/settings`) });
}

export function useEmployees() {
  const orgId = useOrgId();
  return useQuery({ queryKey: ['employees', orgId], queryFn: () => api<Employee[]>(`/v1/orgs/${orgId}/payroll/employees`) });
}
