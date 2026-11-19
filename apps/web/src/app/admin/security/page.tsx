'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useMeWithRole } from '@/lib/admin';
import { dateTime } from '@/lib/format';

type Severity = 'HIGH' | 'MEDIUM';
type SecurityAlert = {
  id: string;
  ruleName: string;
  severity: Severity;
  title: string;
  detail: string;
  organisation: string | null;
  person: string | null;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  status: 'OPEN' | 'ACKNOWLEDGED';
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  note: string | null;
  emailed: string | null;
  emailError: string | null;
};
type Report = {
  monitor: { intervalSeconds: number; lastRun: { at: string; alertsOpened: number; eventsRead: number } | null; lockoutAlertCount: number };
  last24Hours: Record<Severity, number>;
  openAlerts: number;
  alerts: SecurityAlert[];
  events: { id: string; at: string; action: string; severity: Severity; title: string; organisation: string | null; by: string | null; person: string | null; ip: string | null }[];
};
const tone = (s: Severity) => (s === 'HIGH' ? 'negative' : 'warning');

/** Security event monitoring (SEC-023). */
export default function AdminSecurityPage() {
  const qc = useQueryClient();
  const me = useMeWithRole();
  const [severity, setSeverity] = useState<'' | Severity>('');
  const key = ['admin-security', severity];
  const q = useQuery({ queryKey: key, queryFn: () => api<Report>(`/v1/admin/security${severity ? `?severity=${severity}` : ''}`) });
  const scan = useMutation({ mutationFn: () => api<Report>('/v1/admin/security/scan', { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-security'] }) });
  const manage = me.data?.user.platformRole === 'SUPER_ADMIN';
  const r = q.data;
  return (
    <>
      <PageHeader
        title="Security monitoring"
        description="Security events from the audit trail across Talk2Tax: lockouts, failed two-step codes, refused uploads, role changes and more. Rules turn what needs a person into alerts, and each new alert is emailed once to every super admin."
        actions={manage ? <Button variant="secondary" loading={scan.isPending} onClick={() => scan.mutate()}>Check now</Button> : null}
      />
      <ErrorAlert title="Could not load security monitoring" error={q.error} />
      <ErrorAlert title="The check did not run" error={scan.error} />
      {r ? (
        <>
          <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-4">
            <Stat label="Open alerts" value={r.openAlerts} tone={r.openAlerts ? 'negative' : 'positive'} />
            <Stat label="High events, last 24 hours" value={r.last24Hours.HIGH} tone={r.last24Hours.HIGH ? 'warning' : 'neutral'} />
            <Stat label="Medium events, last 24 hours" value={r.last24Hours.MEDIUM} />
            <Stat
              label="Last check"
              value={r.monitor.lastRun ? dateTime(r.monitor.lastRun.at) : 'Not yet'}
              sub={r.monitor.intervalSeconds ? `Every ${Math.round(r.monitor.intervalSeconds / 60)} min` : 'Automatic checks are off (SECURITY_MONITOR_INTERVAL_SECONDS = 0)'}
            />
          </div>

          <Card className="mb-6" role="region" aria-label="Security alerts">
            <CardHeader title="Security alerts" description="Open alerts, and alerts seen in the last 7 days. Acknowledge one once it has been looked at, saying what was found or done." />
            {!r.alerts.length ? (
              <EmptyState title="No alerts">Nothing in the audit trail needs a person.</EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {r.alerts.map((a) => (
                  <AlertRow key={a.id} a={a} manage={manage} onDone={(x) => qc.setQueryData(key, x)} />
                ))}
              </ul>
            )}
          </Card>

          <Card role="region" aria-label="Security events">
            <CardHeader
              title="Security events"
              description="The last 7 days, newest first (at most 200)."
              actions={
                <select aria-label="Severity" className="rounded-md border border-line bg-surface px-2 py-1 text-sm" value={severity} onChange={(e) => setSeverity(e.target.value as '' | Severity)}>
                  <option value="">All</option>
                  <option value="HIGH">High</option>
                  <option value="MEDIUM">Medium</option>
                </select>
              }
            />
            {!r.events.length ? (
              <EmptyState title="No security events">Nothing in the last 7 days.</EmptyState>
            ) : (
              <Table aria-label="Security events">
                <thead><tr><Th>When</Th><Th>Severity</Th><Th>Event</Th><Th>Person</Th><Th>Organisation</Th><Th>By</Th><Th>Address</Th></tr></thead>
                <tbody>
                  {r.events.map((e) => (
                    <Tr key={e.id}>
                      <Td className="whitespace-nowrap">{dateTime(e.at)}</Td>
                      <Td><Badge tone={tone(e.severity)}>{e.severity === 'HIGH' ? 'High' : 'Medium'}</Badge></Td>
                      <Td>{e.title}<span className="block text-xs text-fg-faint">{e.action}</span></Td>
                      <Td className="text-xs">{e.person ?? '—'}</Td>
                      <Td className="text-xs">{e.organisation ?? '—'}</Td>
                      <Td className="text-xs">{e.by ?? '—'}</Td>
                      <Td className="text-xs">{e.ip ?? '—'}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}

function AlertRow({ a, manage, onDone }: { a: SecurityAlert; manage: boolean; onDone: (r: Report) => void }) {
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  const ack = useMutation({ mutationFn: () => api<Report>(`/v1/admin/security/alerts/${a.id}/acknowledge`, { method: 'POST', body: { note: note.trim() } }), onSuccess: onDone });
  return (
    <li className="px-5 py-4" aria-label={`${a.title}: ${a.status === 'OPEN' ? 'open' : 'acknowledged'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone(a.severity)}>{a.severity === 'HIGH' ? 'High' : 'Medium'}</Badge>
        <span className="font-semibold">{a.title}</span>
        {a.status === 'OPEN' ? <Badge tone="negative">Open</Badge> : <Badge tone="positive">Acknowledged</Badge>}
      </div>
      <p className="mt-1 text-sm">{a.detail}</p>
      <p className="mt-1 text-xs text-fg-muted">
        {a.ruleName}. {a.count} event{a.count === 1 ? '' : 's'}, first {dateTime(a.firstSeenAt)}, last {dateTime(a.lastSeenAt)}
        {a.person ? ` · ${a.person}` : ''}
        {a.organisation ? ` · ${a.organisation}` : ''}
        {' · '}
        {a.emailed ? `Emailed ${dateTime(a.emailed)}` : a.emailError ? `Not emailed: ${a.emailError}` : 'Not emailed yet'}
      </p>
      {a.status === 'ACKNOWLEDGED' ? (
        <p className="mt-1 text-xs text-fg-muted">Acknowledged by {a.acknowledgedBy} on {a.acknowledgedAt ? dateTime(a.acknowledgedAt) : '—'}: {a.note}</p>
      ) : manage ? (
        open ? (
          <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); ack.mutate(); }}>
            <Field label="What was found or done">{(p) => <Input {...p} className="w-[28rem]" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
            <Button type="submit" size="sm" disabled={note.trim().length < 5} loading={ack.isPending}>Acknowledge</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            {ack.error ? <div className="w-full"><Alert title="Not acknowledged">{ack.error.message}</Alert></div> : null}
          </form>
        ) : (
          <Button className="mt-2" size="sm" variant="secondary" onClick={() => setOpen(true)}>Acknowledge…</Button>
        )
      ) : null}
    </li>
  );
}
