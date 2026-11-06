'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, EmptyState, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { ErrorGroupDetail, ErrorGroupRow } from '@/lib/operations';

/** Unexpected server errors, grouped by where they come from. */
export default function AdminErrorsPage() {
  const router = useRouter();
  const [status, setStatus] = useState<'open' | 'resolved' | 'all'>('open');
  const [ref, setRef] = useState('');
  const [lookupError, setLookupError] = useState<Error | null>(null);
  const q = useQuery({ queryKey: ['admin-errors', status], queryFn: () => api<{ totals: { open: number; last24h: number }; groups: ErrorGroupRow[] }>(`/v1/admin/errors?status=${status}`) });
  const lookup = async () => {
    setLookupError(null);
    try {
      const g = await api<ErrorGroupDetail>(`/v1/admin/errors/requests/${encodeURIComponent(ref.trim())}`);
      router.push(`/admin/errors/${g.id}?request=${encodeURIComponent(ref.trim())}`);
    } catch (e) {
      setLookupError(e as Error);
    }
  };
  return (
    <>
      <PageHeader title="Errors" description="Every unexpected server error (5xx) is kept with the reference the person was shown, and grouped with the same problem from other requests and organisations. A resolved group that happens again opens again. Occurrences are kept for 30 days." />
      <section className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Open groups" value={q.data?.totals.open ?? '—'} tone={q.data?.totals.open ? 'warning' : 'positive'} />
        <Stat label="Occurrences (24 h)" value={q.data?.totals.last24h ?? '—'} tone={q.data?.totals.last24h ? 'negative' : 'neutral'} />
        <Card className="px-5 py-4" aria-label="Find a reference">
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void lookup(); }}>
            <Field label="Reference a person quoted">{(p) => <Input {...p} className="w-full font-mono" placeholder="e.g. 3f2a…" value={ref} onChange={(e) => setRef(e.target.value)} />}</Field>
            <Button type="submit" variant="secondary" disabled={ref.trim().length < 8}>Find</Button>
          </form>
          <div className="mt-2"><ErrorAlert title="Not found" error={lookupError} /></div>
        </Card>
      </section>
      <div className="mb-3 flex justify-end">
        <Field label="Show">
          {(p) => (
            <Select {...p} className="w-40" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="open">Open</option>
              <option value="resolved">Resolved</option>
              <option value="all">All</option>
            </Select>
          )}
        </Field>
      </div>
      <Card aria-label="Error groups">
        {q.data?.groups.length ? (
          <Table>
            <thead><tr><Th>Error</Th><Th>Route</Th><Th className="text-right">Times</Th><Th className="text-right">24 h</Th><Th>Last seen</Th><Th>First seen</Th></tr></thead>
            <tbody>
              {q.data.groups.map((g) => (
                <Tr key={g.id}>
                  <Td className="max-w-md">
                    <Link className="font-medium text-accent hover:underline" href={`/admin/errors/${g.id}`}>{g.name}</Link>
                    {g.resolvedAt ? <Badge tone="positive" className="ml-2">Resolved</Badge> : null}
                    <span className="block truncate text-xs text-fg-muted" title={g.message}>{g.message}</span>
                  </Td>
                  <Td className="font-mono text-xs">{g.method} {g.route}</Td>
                  <Td className="text-right font-mono tabular-nums">{g.occurrences}</Td>
                  <Td className="text-right font-mono tabular-nums">{g.last24h}</Td>
                  <Td className="whitespace-nowrap text-sm">{dateTime(g.lastSeenAt)}</Td>
                  <Td className="whitespace-nowrap text-sm text-fg-muted">{dateTime(g.firstSeenAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : q.data ? <EmptyState title={status === 'resolved' ? 'Nothing resolved yet' : 'No server errors'}>{status === 'open' ? 'Nothing has failed unexpectedly. Errors appear here as soon as they happen.' : 'Groups appear here once errors are recorded.'}</EmptyState> : null}
      </Card>
    </>
  );
}
