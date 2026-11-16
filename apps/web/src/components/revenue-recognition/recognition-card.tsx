'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Money } from '@/components/money';
import { api } from '@/lib/api';
import { date } from '@/lib/format';

export interface ScheduleProgress {
  id: string;
  reference: string;
  amount: string;
  recognised: string;
  deferred: string;
  status: 'ACTIVE' | 'ENDED';
  endedOn: string | null;
}
interface RecLine {
  lineNo: number;
  description: string | null;
  account: { code: string; name: string };
  revenue: boolean;
  netAmount: string;
  recognition: { startDate: string; months: number; method: 'EVEN' | 'DAILY'; endDate: string } | null;
  schedule: ScheduleProgress | null;
}
interface RecDoc {
  status: string;
  deferredAccountReady: boolean;
  lines: RecLine[];
  can: { manage: boolean; settings: boolean };
}
type Row = { on: boolean; startDate: string; months: string; method: 'EVEN' | 'DAILY' };

/**
 * Revenue recognition on an invoice (AR-028): on a draft, which lines are recognised over a
 * service period; once posted, how far each line's deferred revenue schedule has gone.
 */
export function RecognitionCard({ orgId, documentId, status, issueDate, currency, functionalCurrency, onChange }: { orgId: string; documentId: string; status: string; issueDate: string; currency: string; functionalCurrency: string; onChange: () => Promise<void> }) {
  const qc = useQueryClient();
  const url = `/v1/orgs/${orgId}/sales/documents/${documentId}/recognition`;
  const q = useQuery({ queryKey: ['invoice-recognition', orgId, documentId, status], queryFn: () => api<RecDoc>(url) });
  const [rows, setRows] = useState<Record<number, Row>>({});
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!q.data) return;
    setRows(Object.fromEntries(q.data.lines.map((l) => [l.lineNo, l.recognition ? { on: true, startDate: l.recognition.startDate, months: String(l.recognition.months), method: l.recognition.method } : { on: false, startDate: issueDate, months: '12', method: 'DAILY' as const }])));
  }, [q.data, issueDate]);
  const save = useMutation({
    mutationFn: () =>
      api<RecDoc>(url, {
        method: 'PUT',
        body: { lines: Object.entries(rows).filter(([, r]) => r.on).map(([n, r]) => ({ lineNo: Number(n), startDate: r.startDate, months: Number(r.months), method: r.method })) },
      }),
    onSuccess: async (data) => {
      qc.setQueryData(['invoice-recognition', orgId, documentId, status], data);
      setSaved(true);
      await qc.invalidateQueries({ queryKey: ['revenue-recognition', orgId] });
      await onChange();
    },
  });
  const d = q.data;
  if (!d) return q.error ? <div className="mt-6"><Alert title="Could not load revenue recognition">{q.error.message}</Alert></div> : null;
  const draft = d.status === 'DRAFT';
  const set = d.lines.filter((l) => l.recognition);
  if (!draft && !set.length) return null;
  const editable = draft && d.can.manage;
  const set1 = (n: number, patch: Partial<Row>) => {
    setSaved(false);
    setRows((r) => ({ ...r, [n]: { ...r[n]!, ...patch } }));
  };
  const amountsIn = currency === functionalCurrency ? currency : functionalCurrency;
  return (
    <Card className="mt-6" role="region" aria-label="Revenue recognition">
      <CardHeader
        title="Revenue recognition"
        description={draft ? 'Lines for a service delivered over time, such as a year of support billed up front, can be recognised month by month instead of all at once. On posting they go to deferred revenue, and the monthly release run moves them to revenue.' : `Each line below went to deferred revenue when the invoice posted and is recognised by its schedule${currency !== functionalCurrency ? `, in ${amountsIn}` : ''}.`}
        actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/sales/revenue-recognition`}>All recognition</Link>}
      />
      <div className="flex flex-col gap-3 px-5 pb-5">
        {draft && !d.deferredAccountReady ? (
          <Alert tone="warning" title="No deferred revenue account">
            Choose one under <Link className="underline" href={`/orgs/${orgId}/sales/revenue-recognition`}>Sales → Revenue recognition</Link> before recognising lines over time.
          </Alert>
        ) : null}
        {save.error ? <Alert title="Could not save">{save.error.message}</Alert> : null}
        {saved && !save.error ? <Alert tone="positive" title="Saved">The recognition terms are kept with the draft and apply when it posts.</Alert> : null}
        {draft ? (
          <Table aria-label="Recognition terms">
            <thead><Tr><Th>#</Th><Th>Line</Th><Th numeric>Net</Th><Th>Over time</Th><Th>Service starts</Th><Th>Months</Th><Th>Spread</Th></Tr></thead>
            <tbody>
              {d.lines.map((l) => {
                const r = rows[l.lineNo];
                if (!r) return null;
                return (
                  <Tr key={l.lineNo}>
                    <Td className="text-fg-muted">{l.lineNo}</Td>
                    <Td>{l.description ?? '—'}<span className="block text-xs text-fg-muted">{l.account.code} {l.account.name}</span></Td>
                    <Td numeric><Money value={l.netAmount} currency={currency} /></Td>
                    <Td>
                      {l.revenue ? (
                        <input type="checkbox" aria-label={`Recognise line ${l.lineNo} over time`} className="accent-[var(--t2t-accent)]" disabled={!editable} checked={r.on} onChange={(e) => set1(l.lineNo, { on: e.target.checked })} />
                      ) : <span className="text-xs text-fg-muted">Not a revenue line</span>}
                    </Td>
                    <Td><Input aria-label={`Line ${l.lineNo} service start`} type="date" disabled={!editable || !r.on} value={r.startDate} onChange={(e) => set1(l.lineNo, { startDate: e.target.value })} /></Td>
                    <Td><Input aria-label={`Line ${l.lineNo} months`} className="w-20" type="number" min={1} max={120} disabled={!editable || !r.on} value={r.months} onChange={(e) => set1(l.lineNo, { months: e.target.value })} /></Td>
                    <Td>
                      <Select aria-label={`Line ${l.lineNo} spread`} disabled={!editable || !r.on} value={r.method} onChange={(e) => set1(l.lineNo, { method: e.target.value as 'EVEN' | 'DAILY' })}>
                        <option value="DAILY">By days</option>
                        <option value="EVEN">Evenly by month</option>
                      </Select>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <Table aria-label="Recognition progress">
            <thead><Tr><Th>#</Th><Th>Line</Th><Th>Service period</Th><Th>Schedule</Th><Th numeric>Amount</Th><Th numeric>Recognised</Th><Th numeric>Still deferred</Th></Tr></thead>
            <tbody>
              {set.map((l) => (
                <Tr key={l.lineNo}>
                  <Td className="text-fg-muted">{l.lineNo}</Td>
                  <Td>{l.description ?? '—'}<span className="block text-xs text-fg-muted">{l.account.code} {l.account.name}</span></Td>
                  <Td className="text-sm">{date(l.recognition!.startDate)} to {date(l.recognition!.endDate)}<span className="block text-xs text-fg-muted">{l.recognition!.months} months, {l.recognition!.method === 'DAILY' ? 'by days' : 'evenly'}</span></Td>
                  <Td>
                    {l.schedule ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/deferrals/${l.schedule.id}`}>{l.schedule.reference}</Link> : '—'}
                    {l.schedule?.status === 'ENDED' ? <> <Badge tone="neutral">Ended {l.schedule.endedOn ? date(l.schedule.endedOn) : ''}</Badge></> : null}
                  </Td>
                  <Td numeric>{l.schedule ? <Money value={l.schedule.amount} currency={amountsIn} /> : '—'}</Td>
                  <Td numeric>{l.schedule ? <Money value={l.schedule.recognised} currency={amountsIn} /> : '—'}</Td>
                  <Td numeric>{l.schedule ? <Money value={l.schedule.deferred} currency={amountsIn} /> : '—'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        {editable ? (
          <div className="flex justify-end">
            <Button size="sm" loading={save.isPending} disabled={!d.deferredAccountReady && Object.values(rows).some((r) => r.on)} onClick={() => save.mutate()}>Save recognition</Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
