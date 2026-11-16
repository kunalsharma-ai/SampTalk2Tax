'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export type PlatformRole = 'SUPER_ADMIN' | 'SUPPORT';

export interface AdminOrg {
  id: string;
  name: string;
  legalName: string | null;
  countryCode: string;
  functionalCurrency: string;
  dataRegion: string | null;
  isDemo: boolean;
  createdAt: string;
  suspended: { at: string; reason: string } | null;
  members?: number;
  owners?: string[];
}
export interface AdminOrgDetail extends Omit<AdminOrg, 'members' | 'owners'> {
  members: { userId: string; name: string; email: string; role: string; active: boolean; since: string }[];
  history: { action: string; at: string; by: string | null; data: Record<string, unknown> | null }[];
}
export interface AdminPerson {
  id: string;
  name: string;
  email: string;
  active: boolean;
  platformRole: PlatformRole | null;
  organisations: number;
  joinedAt: string;
  lastSeenAt: string | null;
  openSessions: number;
}
export interface AdminAnnouncement {
  id: string;
  message: string;
  tone: 'INFO' | 'WARNING';
  startsAt: string;
  endsAt: string | null;
  createdAt: string;
  withdrawnAt: string | null;
  createdBy?: string;
  state?: 'SHOWING' | 'SCHEDULED' | 'ENDED' | 'WITHDRAWN';
}

/** The signed-in person with their platform role (null for everyone who does not run the service). */
export function useMeWithRole() {
  return useQuery({ queryKey: ['me-role'], queryFn: () => api<{ user: { id: string; name: string; email: string; platformRole: PlatformRole | null } }>('/v1/auth/me'), staleTime: 5 * 60_000 });
}

export function useAnnouncements() {
  return useQuery({ queryKey: ['announcements'], queryFn: () => api<AdminAnnouncement[]>('/v1/announcements'), staleTime: 5 * 60_000 });
}

export const ROLE_LABEL: Record<PlatformRole, string> = { SUPER_ADMIN: 'Super admin', SUPPORT: 'Support' };
