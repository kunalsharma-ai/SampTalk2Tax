'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';

interface SensitiveEvent { id: string; at: string; action: string; entityType: string; entityId: string; actor: { id: string; name: string } | null; category: string; label: string }
interface Exception { code: string; severity: 'HIGH' | 'MEDIUM' | 'LOW'; label: string; journalId: string; number: string; date: string; postedAt: string; amount: string; detail: string }
interface AuditReport {
  from: string;
  to: string;
  currency: string;
  truncated: boolean;
  chain: { valid: boolean; checked: number; brokenAtId?: string };
  activity: { events: number; people: number; byEntity: { entityType: string; events: number }[]; byPerson: { id: string | null; name: string; events: number; sensitive: number }[] };
  sensitive: { total: number; counts: { category: string; label: string; events: number }[]; events: SensitiveEvent[] };
  journals: { posted: number; manual: number; manualTotal: string; exceptions: Exception[] };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TONE = { HIGH: 'negative', MEDIUM: 'warning', LOW: 'neutral' } as const;
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { dateStyle: 'medium', timeZone: 'UTC' });

/** Audit reports (RPT-021): activity, sensitive actions and journal checks from the audit trail. */
export default function AuditReportPage() {
  const { orgId } = useOrg();
  const [form, setForm] = useState({ from: '', to: '' });
  const [asked, setAsked] = useState({ from: '', to: '' });
  const [busy, setBusy] = useState(false);
  const qs = [asked.from ? `from=${asked.from}` : '', asked.to ? `to=${asked.to}` : ''].filter(Boolean).join('&');
  const q = useQuery({ queryKey: ['audit-report', orgId, qs], queryFn: () => api<AuditReport>(`/v1/orgs/${orgId}/reports/audit?${qs}`) });
  const d = q.data;
  const download = async () => {
    setBusy(true);
    try {
      const x = await api<{ fileName: string; csv: string }>(`/v1/orgs/${orgId}/reports/audit/export?${qs}`);
      const url = URL.createObjectURL(new Blob([x.csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = x.fileName;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader
        title="Audit report"
        description="What happened in the books over a period, from the audit trail: who did how much, the sensitive actions (periods reopened, access and bank details changed, deletions, voids and reversals, settings and exports), and posted journals that need a second look."
        actions={<Button variant="secondary" size="sm" loading={busy} disabled={!d} onClick={() => void download()}>Download audit report (CSV)</Button>}
      />
      <Card className="mb-4">
        <CardHeader title="Audit report period" description="Days to include, in your organisation's time zone; the financial year to date when left blank. Up to two years." />
        <form
          className="flex flex-wrap items-end gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            setAsked(form);
          }}
        >
          <Field label="From">{(p) => <Input {...p} type="date" className="w-44" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />}</Field>
          <Field label="To">{(p) => <Input {...p} type="date" className="w-44" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />}</Field>
          <Button type="submit" size="sm" disabled={(!!form.from && !DATE.test(form.from)) || (!!form.to && !DATE.test(form.to))} loading={q.isFetching}>Show report</Button>
        </form>
      </Card>
      <ErrorAlert title="Could not load the audit report" error={q.error} />
      {d ? (
        <>
          {d.chain.valid ? null : (
            <div className="mb-4">
              <Alert tone="negative" title="The audit trail has been tampered with">The hash chain breaks at an event, so the history from there on cannot be relied on. Open the audit trail to see where.</Alert>
            </div>
          )}
          {d.truncated ? (
            <div className="mb-4"><Alert tone="warning" title="Too many events for one report">Only the first 20,000 events in the period are counted. Choose a shorter period.</Alert></div>
          ) : null}
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Events recorded" value={d.activity.events} sub={`${day(d.from)} to ${day(d.to)}, ${d.activity.people} ${d.activity.people === 1 ? 'person' : 'people'}`} />
            <Stat label="Sensitive actions" value={d.sensitive.total} sub={((n) => `${n} ${n === 1 ? 'kind' : 'kinds'} of action`)(d.sensitive.counts.filter((c) => c.events).length)} />
            <Stat label="Journal exceptions" value={d.journals.exceptions.length} sub={`${d.journals.posted} journals posted, ${d.journals.manual} manual`} />
            <Stat label="Audit trail" value={d.chain.valid ? 'Intact' : 'Broken'} sub={`${d.chain.checked} events checked in the hash chain`} />
          </div>

          <Card className="mb-4">
            <CardHeader title="Sensitive actions" description="Actions an auditor asks about, newest first, with the count of each kind." />
            <div className="flex flex-wrap gap-2 px-4 pt-4">
              {d.sensitive.counts.map((c) => (
                <Badge key={c.category} tone={c.events ? 'warning' : 'neutral'}>{c.label}: {c.events}</Badge>
              ))}
            </div>
            {d.sensitive.events.length ? (
              <Table aria-label="Sensitive actions">
                <thead><Tr><Th>When</Th><Th>Kind</Th><Th>Action</Th><Th>Record</Th><Th>By</Th></Tr></thead>
                <tbody>
                  {d.sensitive.events.map((e) => (
                    <Tr key={e.id}>
                      <Td>{when(e.at)}</Td>
                      <Td>{e.label}</Td>
                      <Td><code className="text-xs">{e.action}</code></Td>
                      <Td>{e.entityType}</Td>
                      <Td>{e.actor?.name ?? 'System'}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="No sensitive actions">Nothing in the period reopened a period, changed access or bank details, deleted, voided or reversed a record, changed settings or exported data.</EmptyState>
            )}
          </Card>

          <Card className="mb-4">
            <CardHeader title="Journal checks" description="Posted journals that need a second look: posted more than 30 days after their date, large round manual journals, and manual journals prepared and posted by one person." />
            <div className="px-4 pt-4 text-sm text-fg-muted">Manual journals posted: {d.journals.manual}, totalling <Money value={d.journals.manualTotal} currency={d.currency} />.</div>
            {d.journals.exceptions.length ? (
              <Table aria-label="Journal checks">
                <thead><Tr><Th>Check</Th><Th>Journal</Th><Th>Date</Th><Th>Posted</Th><Th numeric>Amount</Th><Th>Detail</Th></Tr></thead>
                <tbody>
                  {d.journals.exceptions.map((x) => (
                    <Tr key={`${x.code}-${x.journalId}`}>
                      <Td><Badge tone={TONE[x.severity]} className="whitespace-nowrap">{x.label}</Badge></Td>
                      <Td><Link className="whitespace-nowrap text-accent hover:underline" href={`/orgs/${orgId}/journals/${x.journalId}`}>{x.number}</Link></Td>
                      <Td className="whitespace-nowrap">{day(x.date)}</Td>
                      <Td>{when(x.postedAt)}</Td>
                      <Td numeric><Money value={x.amount} currency={d.currency} /></Td>
                      <Td>{x.detail}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="No journal exceptions">Every journal posted in the period passed the checks.</EmptyState>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Activity by person" description="Events each person recorded, and how many were sensitive." />
              {d.activity.byPerson.length ? (
                <Table aria-label="Activity by person">
                  <thead><Tr><Th>Person</Th><Th numeric>Events</Th><Th numeric>Sensitive</Th></Tr></thead>
                  <tbody>
                    {d.activity.byPerson.map((p) => (
                      <Tr key={p.id ?? 'system'}><Td>{p.name}</Td><Td numeric>{p.events}</Td><Td numeric>{p.sensitive}</Td></Tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <EmptyState title="No activity">Nothing was recorded in the period.</EmptyState>
              )}
            </Card>
            <Card>
              <CardHeader title="Activity by record type" description="Events by the kind of record they changed." />
              {d.activity.byEntity.length ? (
                <Table aria-label="Activity by record type">
                  <thead><Tr><Th>Record type</Th><Th numeric>Events</Th></Tr></thead>
                  <tbody>
                    {d.activity.byEntity.map((e) => (
                      <Tr key={e.entityType}><Td>{e.entityType}</Td><Td numeric>{e.events}</Td></Tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <EmptyState title="No activity">Nothing was recorded in the period.</EmptyState>
              )}
            </Card>
          </div>
        </>
      ) : null}
    </>
  );
}
