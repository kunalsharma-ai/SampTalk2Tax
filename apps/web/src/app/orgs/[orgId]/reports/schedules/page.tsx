'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { REPORT_SCHEDULE_FREQUENCIES, SCHEDULE_FORMATS, SCHEDULE_PERIOD_LABEL, SCHEDULE_PERIODS, SCHEDULED_REPORT_LABEL, SCHEDULED_REPORTS } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

interface Run { id: string; runOn: string; manual: boolean; status: 'SENDING' | 'SENT' | 'FAILED'; recipients: string[]; fileName: string | null; error: string | null; startedAt: string }
interface Schedule {
  id: string;
  name: string;
  report: string;
  reportLabel: string;
  format: string;
  period: string;
  periodLabel: string;
  frequency: 'WEEKLY' | 'MONTHLY';
  weekday: number | null;
  dayOfMonth: number | null;
  recipients: { userId: string; name: string | null; email: string | null; canRead: boolean }[];
  isActive: boolean;
  nextRunOn: string | null;
  lastRun: Run | null;
}
interface List { items: Schedule[]; recipients: { userId: string; name: string; email: string }[]; emailReady: boolean }

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const FORMAT_LABEL: Record<string, string> = { pdf: 'PDF', xlsx: 'Excel', csv: 'CSV' };
const AT_DATE = new Set(['balance-sheet', 'receivables-ageing', 'payables-ageing']);
const when = (s: Pick<Schedule, 'frequency' | 'weekday' | 'dayOfMonth'>) => (s.frequency === 'WEEKLY' ? `Every ${WEEKDAYS[(s.weekday ?? 1) - 1]}` : `Monthly on day ${s.dayOfMonth}`);

type Draft = { name: string; report: string; format: string; period: string; frequency: 'WEEKLY' | 'MONTHLY'; weekday: number; dayOfMonth: number; recipientIds: string[] };

/** Reports emailed to members on a weekly or monthly day (RPT-031, RPT-032). */
export default function ReportSchedulesPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['report-schedules', orgId], queryFn: () => api<List>(`/v1/orgs/${orgId}/report-schedules`) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sent, setSent] = useState<Run | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['report-schedules', orgId] });
  const save = useMutation({ mutationFn: (d: Draft) => api(`/v1/orgs/${orgId}/report-schedules`, { method: 'POST', body: { ...d, weekday: d.frequency === 'WEEKLY' ? d.weekday : null, dayOfMonth: d.frequency === 'MONTHLY' ? d.dayOfMonth : null } }), onSuccess: async () => { setDraft(null); await refresh(); } });
  const send = useMutation({ mutationFn: (id: string) => api<Run>(`/v1/orgs/${orgId}/report-schedules/${id}/send`, { method: 'POST' }), onSuccess: async (r) => { setSent(r); await refresh(); } });
  const toggle = useMutation({ mutationFn: (s: Schedule) => api(`/v1/orgs/${orgId}/report-schedules/${s.id}`, { method: 'PUT', body: { name: s.name, report: s.report, format: s.format, period: s.period, frequency: s.frequency, weekday: s.weekday, dayOfMonth: s.dayOfMonth, recipientIds: s.recipients.filter((r) => r.canRead).map((r) => r.userId), isActive: !s.isActive } }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api(`/v1/orgs/${orgId}/report-schedules/${id}`, { method: 'DELETE' }), onSuccess: refresh });
  if (!org) return null;
  const manage = can(org.role, 'reports.design');
  const items = q.data?.items ?? [];
  const start = () => { save.reset(); setDraft({ name: '', report: 'income-statement', format: 'pdf', period: 'LAST_MONTH', frequency: 'MONTHLY', weekday: 1, dayOfMonth: 3, recipientIds: [] }); };
  return (
    <>
      <PageHeader
        title="Scheduled reports"
        description="Email a report to members on a weekly or monthly day. Each run reports up to the day before, uses the same figures as the Reports screens, and is kept with a fingerprint of the file sent."
        actions={manage ? <Button onClick={start}>New schedule</Button> : null}
      />
      <ErrorAlert title="Could not load schedules" error={q.error} />
      {q.data && !q.data.emailReady ? (
        <div className="mb-4"><Alert tone="warning" title="Email is not set up">Runs will fail until an owner or admin adds a mail server in <Link className="underline" href={`/orgs/${orgId}/settings/integrations`}>Settings › Integrations</Link>.</Alert></div>
      ) : null}
      {sent ? (
        <div className="mb-4"><Alert tone={sent.status === 'SENT' ? 'positive' : 'negative'} title={sent.status === 'SENT' ? 'Sent' : 'Not sent'}>
          {sent.status === 'SENT' ? `${sent.fileName} went to ${sent.recipients.join(', ')}.` : sent.error}
        </Alert></div>
      ) : null}
      {q.data && !items.length ? (
        <Card><EmptyState title="No scheduled reports" action={manage ? <Button onClick={start}>New schedule</Button> : undefined}>Send the profit and loss to the owners on the 3rd of each month, or the receivables ageing every Monday.</EmptyState></Card>
      ) : null}
      {items.length ? (
        <Card>
          <CardHeader title="Report schedules" description={`${items.length} schedule${items.length === 1 ? '' : 's'}`} />
          <Table>
            <thead><Tr><Th>Schedule</Th><Th>When</Th><Th>Recipients</Th><Th>Next run</Th><Th>Last run</Th>{manage ? <Th /> : null}</Tr></thead>
            <tbody>
              {items.map((s) => (
                <Tr key={s.id}>
                  <Td><p className="font-medium">{s.name}</p><p className="text-xs text-fg-muted">{s.reportLabel} · {s.periodLabel} · {FORMAT_LABEL[s.format] ?? s.format}</p></Td>
                  <Td>{when(s)}</Td>
                  <Td className="text-sm">{s.recipients.map((r) => <span key={r.userId} className={`block ${r.canRead ? '' : 'text-warning'}`}>{r.name ?? 'Former member'}{r.canRead ? '' : ' (no access, skipped)'}</span>)}</Td>
                  <Td>{s.isActive && s.nextRunOn ? date(s.nextRunOn) : <Badge tone="neutral">Paused</Badge>}</Td>
                  <Td className="text-sm">{s.lastRun ? <><Badge tone={s.lastRun.status === 'SENT' ? 'positive' : s.lastRun.status === 'FAILED' ? 'negative' : 'neutral'}>{s.lastRun.status === 'SENT' ? 'Sent' : s.lastRun.status === 'FAILED' ? 'Failed' : 'Sending'}</Badge> <span className="text-fg-muted">{dateTime(s.lastRun.startedAt)}</span>{s.lastRun.error ? <span className="block text-xs text-negative">{s.lastRun.error}</span> : null}</> : <span className="text-fg-muted">Not yet</span>}</Td>
                  {manage ? (
                    <Td>
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button size="sm" variant="secondary" loading={send.isPending && send.variables === s.id} onClick={() => { setSent(null); send.mutate(s.id); }}>Send now</Button>
                        <Button size="sm" variant="ghost" onClick={() => toggle.mutate(s)}>{s.isActive ? 'Pause' : 'Resume'}</Button>
                        <Button size="sm" variant="ghost" onClick={() => remove.mutate(s.id)}>Delete</Button>
                      </div>
                    </Td>
                  ) : null}
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
      <ErrorAlert title="Could not send" error={send.error} />
      <ErrorAlert title="Could not change the schedule" error={toggle.error ?? remove.error} />
      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)} title="New scheduled report" description="Recipients must be members who can read reports. The report is produced with your access.">
        {draft ? (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}>
            <Field label="Name">{(p) => <Input {...p} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Monthly P&L for the owners" />}</Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Report">{(p) => <Select {...p} value={draft.report} onChange={(e) => setDraft({ ...draft, report: e.target.value, period: AT_DATE.has(e.target.value) && (draft.period === 'MONTH_TO_DATE' || draft.period === 'YEAR_TO_DATE') ? 'LAST_MONTH' : draft.period })}>{SCHEDULED_REPORTS.map((r) => <option key={r} value={r}>{SCHEDULED_REPORT_LABEL[r]}</option>)}</Select>}</Field>
              <Field label="Covers">{(p) => <Select {...p} value={draft.period} onChange={(e) => setDraft({ ...draft, period: e.target.value })}>{SCHEDULE_PERIODS.filter((x) => !AT_DATE.has(draft.report) || x === 'LAST_MONTH' || x === 'TODAY').map((x) => <option key={x} value={x}>{SCHEDULE_PERIOD_LABEL[x]}</option>)}</Select>}</Field>
              <Field label="How often">{(p) => <Select {...p} value={draft.frequency} onChange={(e) => setDraft({ ...draft, frequency: e.target.value as Draft['frequency'] })}>{REPORT_SCHEDULE_FREQUENCIES.map((f) => <option key={f} value={f}>{f === 'WEEKLY' ? 'Weekly' : 'Monthly'}</option>)}</Select>}</Field>
              {draft.frequency === 'WEEKLY' ? (
                <Field label="Day of the week">{(p) => <Select {...p} value={draft.weekday} onChange={(e) => setDraft({ ...draft, weekday: Number(e.target.value) })}>{WEEKDAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</Select>}</Field>
              ) : (
                <Field label="Day of the month" hint="1 to 28">{(p) => <Input {...p} className="num" inputMode="numeric" value={String(draft.dayOfMonth)} onChange={(e) => /^\d{0,2}$/.test(e.target.value) && setDraft({ ...draft, dayOfMonth: Number(e.target.value) })} />}</Field>
              )}
              <Field label="File">{(p) => <Select {...p} value={draft.format} onChange={(e) => setDraft({ ...draft, format: e.target.value })}>{SCHEDULE_FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}</Select>}</Field>
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-muted">Recipients</legend>
              {(q.data?.recipients ?? []).map((r) => (
                <label key={r.userId} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={draft.recipientIds.includes(r.userId)} onChange={(e) => setDraft({ ...draft, recipientIds: e.target.checked ? [...draft.recipientIds, r.userId] : draft.recipientIds.filter((x) => x !== r.userId) })} />
                  {r.name} <span className="text-fg-muted">{r.email}</span>
                </label>
              ))}
            </fieldset>
            <ErrorAlert title="Could not save" error={save.error} />
            <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button><Button type="submit" loading={save.isPending}>Save schedule</Button></div>
          </form>
        ) : null}
      </Dialog>
    </>
  );
}
