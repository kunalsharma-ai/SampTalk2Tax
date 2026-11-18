'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { NoticeUrgency } from '@/components/tax-notice-bits';
import { api, ApiError } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { AUTHORITIES, type TaxAuthority, type TaxNotice, type TaxNoticeList, type TaxNoticeStatus } from '@/lib/tax-notices';
import { can, type Member } from '@/lib/types';

const blank = { authority: 'GST' as TaxAuthority, reference: '', section: '', subject: '', period: '', receivedOn: today(), responseDue: '', demand: '', assigneeId: '' };

/** Tax notices (TAX-024): letters from tax authorities, tracked to their reply deadline. */
export default function TaxNoticesPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const router = useRouter();
  const [status, setStatus] = useState<TaxNoticeStatus | ''>('');
  const [form, setForm] = useState(blank);
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: ['tax-notices', orgId, status], queryFn: () => api<TaxNoticeList>(`/v1/orgs/${orgId}/tax-notices${status ? `?status=${status}` : ''}`) });
  const members = useQuery({ enabled: !!org && can(org.role, 'members.read'), queryKey: ['members', orgId], queryFn: () => api<Member[]>(`/v1/orgs/${orgId}/members`) });
  const create = useMutation({
    mutationFn: () =>
      api<TaxNotice>(`/v1/orgs/${orgId}/tax-notices`, {
        method: 'POST',
        body: { ...form, section: form.section || null, period: form.period || null, responseDue: form.responseDue || null, demand: form.demand || null, assigneeId: form.assigneeId || null },
      }),
    onSuccess: async (n) => {
      await qc.invalidateQueries({ queryKey: ['tax-notices', orgId] });
      router.push(`/orgs/${orgId}/tax/notices/${n.id}`);
    },
  });
  if (!org) return null;
  const manage = can(org.role, 'accounts.manage');
  const s = list.data?.summary;
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <>
      <PageHeader
        title="Tax notices"
        description="Letters from GST, income tax, TDS, PF, ESI and other authorities. Record each notice with its reply deadline, keep the letter and your reply on file, and close it with how it ended."
        actions={manage ? <Button onClick={() => setAdding(!adding)}>{adding ? 'Cancel' : 'Record a notice'}</Button> : null}
      />
      {adding ? (
        <Card className="mb-6">
          <CardHeader title="Record a notice" description="Copy the details from the letter. The notice number is the DIN, ARN or reference printed on it." />
          <form className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <Field label="Authority">{(p) => <Select {...p} value={form.authority} onChange={set('authority')}>{Object.entries(AUTHORITIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
            <Field label="Notice number">{(p) => <Input {...p} required maxLength={100} value={form.reference} onChange={set('reference')} />}</Field>
            <Field label="Form or section (optional)" hint="Such as ASMT-10, DRC-01 or 143(2)">{(p) => <Input {...p} maxLength={60} value={form.section} onChange={set('section')} />}</Field>
            <Field label="Period (optional)" hint="Such as 2025-26 or 2026-03">{(p) => <Input {...p} maxLength={40} value={form.period} onChange={set('period')} />}</Field>
            <div className="sm:col-span-2 lg:col-span-4"><Field label="What it is about">{(p) => <Input {...p} required maxLength={300} value={form.subject} onChange={set('subject')} />}</Field></div>
            <Field label="Received on">{(p) => <Input {...p} type="date" required max={today()} value={form.receivedOn} onChange={set('receivedOn')} />}</Field>
            <Field label="Reply due (optional)">{(p) => <Input {...p} type="date" min={form.receivedOn} value={form.responseDue} onChange={set('responseDue')} />}</Field>
            <Field label={`Amount demanded in ${org.functionalCurrency} (optional)`}>{(p) => <Input {...p} className="num text-right" inputMode="decimal" value={form.demand} onChange={(e) => /^\d{0,12}(\.\d{0,2})?$/.test(e.target.value) && setForm({ ...form, demand: e.target.value })} />}</Field>
            {members.data ? (
              <Field label="Given to (optional)">{(p) => <Select {...p} value={form.assigneeId} onChange={set('assigneeId')}><option value="">Nobody yet</option>{members.data.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</Select>}</Field>
            ) : <div />}
            {create.error ? <div className="sm:col-span-2 lg:col-span-4"><Alert title="Notice not recorded">{create.error.message}{create.error instanceof ApiError && create.error.issues.length ? <ul className="mt-1 list-disc pl-5">{create.error.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}</Alert></div> : null}
            <div className="flex justify-end sm:col-span-2 lg:col-span-4"><Button type="submit" loading={create.isPending}>Record notice</Button></div>
          </form>
        </Card>
      ) : null}
      {s ? (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Open" value={s.open} />
          <Stat label="Overdue" value={s.overdue} tone={s.overdue ? 'negative' : 'neutral'} />
          <Stat label="Due within 7 days" value={s.dueSoon} tone={s.dueSoon ? 'warning' : 'neutral'} />
          <Stat label="Replied, waiting" value={s.responded} />
        </div>
      ) : null}
      {list.error ? <Alert title="Could not load">{(list.error as Error).message}</Alert> : null}
      <Card>
        <CardHeader
          title="Notices"
          description="Most pressing first: overdue, then due soon, then the rest."
          actions={
            <Select aria-label="Show" className="w-40" value={status} onChange={(e) => setStatus(e.target.value as TaxNoticeStatus | '')}>
              <option value="">All</option>
              <option value="OPEN">Open</option>
              <option value="RESPONDED">Replied</option>
              <option value="CLOSED">Closed</option>
            </Select>
          }
        />
        {list.data && !list.data.items.length ? (
          <EmptyState title="No notices">{status ? 'None with this status.' : 'Record a notice when one arrives so its deadline is not missed.'}</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Notice</Th><Th>About</Th><Th>Received</Th><Th>Reply due</Th><Th numeric>Demand</Th><Th>Status</Th></tr></thead>
            <tbody>
              {(list.data?.items ?? []).map((n) => (
                <Tr key={n.id}>
                  <Td>
                    <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/tax/notices/${n.id}`}>{n.authorityLabel} · {n.reference}</Link>
                    {n.section ? <p className="text-xs text-fg-muted">{n.section}{n.period ? ` · ${n.period}` : ''}</p> : null}
                  </Td>
                  <Td>{n.subject}{n.assignee ? <p className="text-xs text-fg-muted">With {n.assignee}</p> : null}</Td>
                  <Td className="whitespace-nowrap">{date(n.receivedOn)}</Td>
                  <Td className="whitespace-nowrap">{n.responseDue ? date(n.responseDue) : <span className="text-fg-faint">—</span>}</Td>
                  <Td numeric>{n.demand ? <Money value={n.demand} currency={org.functionalCurrency} /> : <span className="text-fg-faint">—</span>}</Td>
                  <Td><NoticeUrgency n={n} /></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
