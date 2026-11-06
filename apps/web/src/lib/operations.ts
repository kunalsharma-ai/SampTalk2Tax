'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface MaintenanceStatus { message: string; state: 'SCHEDULED' | 'IN_PROGRESS'; startsAt: string; expectedEndAt: string | null }

/** Is maintenance scheduled or in progress? Asked of the server every 30 seconds, signed in or not. */
export function useServiceStatus() {
  return useQuery({
    queryKey: ['service-status'],
    queryFn: async () => {
      const r = await fetch('/api/status', { cache: 'no-store' });
      if (!r.ok) return { maintenance: null };
      return (await r.json()) as { maintenance: MaintenanceStatus | null };
    },
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

/** The organisation's feature flags (the API refuses a switched-off module on its own). */
export function useOrgFlags(orgId: string | undefined) {
  return useQuery({ queryKey: ['org-flags', orgId], queryFn: () => api<Record<string, boolean>>(`/v1/orgs/${orgId}/flags`), enabled: !!orgId, staleTime: 60_000 });
}

export interface Runner { name: string; intervalSeconds: number; runs: number; failures: number; skipped: number; lastStartedAt: string | null; lastFinishedAt: string | null; lastMs: number | null; lastError: string | null; running: boolean; state: 'OFF' | 'WAITING' | 'OK' | 'FAILING' | 'LATE' }
export interface RouteStat { route?: string; requests: number; clientErrors: number; serverErrors: number; p50Ms: number | null; p95Ms: number | null }
export interface SystemHealth {
  status: 'OK' | 'DEGRADED' | 'DOWN';
  problems: string[];
  checkedAt: string;
  server: { version: string; commit: string | null; environment: string; node: string; region: string; startedAt: string; uptimeSeconds: number; memory: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number }; loadAverage: number[] };
  database: { status: 'OK' | 'SLOW' | 'DOWN'; latencyMs: number | null; sizeBytes: number | null; connections: number | null; maxConnections: number | null; postgres: string | null; lastMigration: { name: string; at: string | null } | null; unfinishedMigrations: number | null; error?: string };
  runners: Runner[];
  requests: { windowMinutes: number; since: string; totals: RouteStat; minutes: { at: string; requests: number; serverErrors: number; p95Ms: number | null }[]; routes: (RouteStat & { route: string })[] };
  errors: { open: number | null; lastHour: number | null };
  maintenance: (MaintenanceStatus & { id: string }) | null;
}
export interface ErrorGroupRow { id: string; name: string; message: string; method: string; route: string; frame: string | null; occurrences: number; last24h: number; firstSeenAt: string; lastSeenAt: string; resolvedAt: string | null }
export interface ErrorGroupDetail extends Omit<ErrorGroupRow, 'last24h'> { resolvedBy: string | null; events: { id: string; requestId: string; status: number; method: string; path: string; orgId: string | null; userId: string | null; message: string; stack: string | null; at: string }[] }
export interface FlagRow {
  key: string;
  name: string;
  description: string;
  defaultOn: boolean;
  setting: { enabled: boolean; rolloutPercent: number; note: string | null; updatedBy: string | null; updatedAt: string } | null;
  overrides: { orgId: string; orgName: string | null; enabled: boolean; reason: string; createdBy: string | null; createdAt: string }[];
  organisations: { on: number; total: number };
}
export interface MaintenanceWindowRow { id: string; message: string; startsAt: string; expectedEndAt: string | null; createdAt: string; endedAt: string | null; state: 'SCHEDULED' | 'IN_PROGRESS' | 'ENDED'; createdBy: string | null; endedBy: string | null }

export const duration = (seconds: number) => {
  const d = Math.floor(seconds / 86_400), h = Math.floor((seconds % 86_400) / 3600), m = Math.floor((seconds % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
};
