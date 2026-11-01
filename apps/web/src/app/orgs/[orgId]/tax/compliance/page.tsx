'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Select, Stat, Table, Td, Th } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date, money, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can, type ComplianceCalendar, type ComplianceItem, type ComplianceSettings, type ObligationStatus } from '@/lib/types';

const STATUS: Record<ObligationStatus, { label: string; tone: 'negative' | 'warning' | 'neutral' | 'positive' | 'accent' }> = {
  OVERDUE: { label: 'Overdue', tone: 'negative' },
  DUE_SOON: { label: 'Due soon', tone: 'warning' },
  UPCOMING: { label: 'Upcoming', tone: 'neutral' },
  DONE: { label: 'Done', tone: 'positive' },
  NOTHING_DUE: { label: 'Nothing due', tone: 'accent' },
};
const AREA: Record<ComplianceItem['area'], string> = { GST: 'GST', TDS_TCS: 'TDS/TCS', PAYROLL: 'Payroll', INCOME_TAX: 'Income tax' };
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const monthStart = (iso: string, shift = 0) => {
  const d = new Date(Date.parse(`${iso.slice(0, 7)}-01T00:00:00Z`));
  d.setUTCMonth(d.getUTCMonth() + shift);
  return d.toISOString().slice(0, 10);
};
const monthEndOf = (iso: string) => addDays(monthStart(iso, 1), -1);
const monthName = (iso: string) => new Date(`${iso.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function ErrorAlert({ title, error }: { title: string; error: Error | null }) {
  if (!error) return null;
  return <Alert title={title}>{error.message}{error instanceof ApiError && error.issues.length ? <ul className="mt-1 list-inside list-disc">{error.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}</Alert>;
}

export default function CompliancePage() {
  return (
    <Suspense>
      <Compliance />
    </Suspense>
  );
}

function Compliance() {
  const { org, orgId } = useOrg();
  const params = useSearchParams();
  const router = useRouter();
  const t = today();
  // Default: the next 60 days. ?month=YYYY-MM shows one calendar month instead.
  const month = params.get('month');
  const from = month ? `${month}-01` : t;
  const to = month ? monthEndOf(from) : addDays(t, 60);
  const key = ['compliance', orgId, from, to];
  const cal = useQuery({ queryKey: key, queryFn: () => api<ComplianceCalendar>(`/v1/orgs/${orgId}/compliance/calendar?from=${from}&to=${to}`) });
  const [filing, setFiling] = useState<ComplianceItem | null>(null);
  const [voiding, setVoiding] = useState<ComplianceItem | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  if (!org) return null;
  const canManage = can(org.role, 'accounts.manage');
  const go = (m: string | null) => router.replace(`/orgs/${orgId}/tax/compliance${m ? `?month=${m}` : ''}`);
  const c = cal.data;
  const rows = c ? [...c.overdueBefore, ...c.items] : [];
  const groups = new Map<string, ComplianceItem[]>();
  for (const r of c?.items ?? []) groups.set(r.dueDate.slice(0, 7), [...(groups.get(r.dueDate.slice(0, 7)) ?? []), r]);

  return (
    <>
      <PageHeader
        title="Compliance calendar"
        description="GST returns, TDS/TCS deposits and statements, payroll dues and advance tax for this organisation, with their status from the books. Payments are done when they are recorded; returns are done when you mark them filed with the acknowledgement. Talk2Tax does not file anything."
        actions={canManage ? <Button variant="secondary" onClick={() => setSettingsOpen(true)}>Calendar settings</Button> : null}
      />
      <ErrorAlert title="Could not load the calendar" error={cal.error} />
      {c && !c.configured ? (
        <EmptyState
          title="Nothing to track yet"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Link className="text-accent hover:underline" href={`/orgs/${orgId}/settings/gst`}>GST settings</Link>
              <Link className="text-accent hover:underline" href={`/orgs/${orgId}/settings/tds-tcs`}>TDS/TCS settings</Link>
              <Link className="text-accent hover:underline" href={`/orgs/${orgId}/settings/payroll`}>Payroll settings</Link>
            </div>
          }
        >
          The calendar fills in from the organisation&apos;s set-up: register for GST, add a TAN for TDS and TCS, or set up payroll. Advance tax can be switched on in the calendar settings.
        </EmptyState>
      ) : null}
      {c && c.configured ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Overdue" value={String(c.summary.overdue)} tone={c.summary.overdue ? 'negative' : 'neutral'} sub={c.overdueBefore.length ? `${c.overdueBefore.length} from before this view` : 'Past the due date and not done'} />
            <Stat label="Due within 7 days" value={String(c.summary.dueSoon)} tone={c.summary.dueSoon ? 'warning' : 'neutral'} sub="Open and due soon" />
            <Stat label="Upcoming" value={String(c.summary.upcoming)} sub="Later in this view" />
            <Stat label="Done" value={String(c.summary.done + c.summary.nothingDue)} tone="positive" sub={`${c.summary.nothingDue} with nothing to pay`} />
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-2">
            <Button variant={month ? 'ghost' : 'secondary'} onClick={() => go(null)}>Next 60 days</Button>
            <Button variant="ghost" aria-label="Previous month" onClick={() => go(monthStart(month ? from : t, -1).slice(0, 7))}>←</Button>
            <span className="min-w-36 text-center text-sm font-medium">{month ? monthName(from) : `${date(from)} – ${date(to)}`}</span>
            <Button variant="ghost" aria-label="Next month" onClick={() => go(monthStart(month ? from : t, month ? 1 : 0).slice(0, 7))}>→</Button>
            <span className="ml-auto flex flex-wrap gap-1.5 text-xs text-fg-muted">
              {c.areas.gst ? <Badge tone="neutral">GST {c.gstReturnFrequency === 'QUARTERLY' ? 'QRMP' : 'monthly'}</Badge> : null}
              {c.areas.withholding ? <Badge tone="neutral">TDS/TCS</Badge> : null}
              {c.areas.payroll ? <Badge tone="neutral">Payroll</Badge> : null}
              {c.areas.advanceTax ? <Badge tone="neutral">Advance tax</Badge> : null}
            </span>
          </div>

          {c.overdueBefore.length ? (
            <Card className="mt-4 border-negative/40">
              <CardHeader title="Still overdue from earlier" description="Open obligations due before this view, up to two years back." />
              <Rows items={c.overdueBefore} orgId={orgId} canManage={canManage} onFile={setFiling} onVoid={setVoiding} />
            </Card>
          ) : null}

          {[...groups.entries()].map(([m, items]) => (
            <Card key={m} className="mt-4">
              <CardHeader title={`Due in ${monthName(m)}`} description={`${items.length} item${items.length === 1 ? '' : 's'}`} />
              <Rows items={items} orgId={orgId} canManage={canManage} onFile={setFiling} onVoid={setVoiding} />
            </Card>
          ))}
          {!rows.length ? <EmptyState title="Nothing falls due in this view">Try another month.</EmptyState> : null}
        </>
      ) : null}
      {filing ? <FileDialog item={filing} onClose={() => setFiling(null)} /> : null}
      {voiding ? <VoidDialog item={voiding} onClose={() => setVoiding(null)} /> : null}
      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
    </>
  );
}

function evidenceHref(orgId: string, e: ComplianceItem['evidence'][number]) {
  return e.type === 'WITHHOLDING_DEPOSIT' ? `/orgs/${orgId}/tax/tds-tcs` : `/orgs/${orgId}/payroll/runs/${e.id}`;
}

function workingPaper(orgId: string, i: ComplianceItem): string | null {
  if (i.kind === 'GSTR1' || i.kind === 'GSTR3B') return `/orgs/${orgId}/tax/gst-returns?month=${i.periodTo.slice(0, 7)}&return=${i.kind === 'GSTR1' ? 'gstr-1' : 'gstr-3b'}`;
  if (i.kind === 'TDS_STATEMENT' || i.kind === 'TCS_STATEMENT') return `/orgs/${orgId}/tax/tds-tcs?kind=${i.kind === 'TCS_STATEMENT' ? 'TCS' : 'TDS'}&quarter=${i.periodFrom}`;
  if (i.kind === 'TDS_DEPOSIT' || i.kind === 'TCS_DEPOSIT') return `/orgs/${orgId}/tax/tds-tcs?kind=${i.kind === 'TCS_DEPOSIT' ? 'TCS' : 'TDS'}`;
  if (i.area === 'PAYROLL' && !i.evidence.length) return `/orgs/${orgId}/payroll/runs`;
  return null;
}

function Rows({ items, orgId, canManage, onFile, onVoid }: { items: ComplianceItem[]; orgId: string; canManage: boolean; onFile: (i: ComplianceItem) => void; onVoid: (i: ComplianceItem) => void }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Due</Th>
          <Th>Obligation</Th>
          <Th className="text-right">Amount</Th>
          <Th>Status</Th>
          <Th className="text-right"><span className="sr-only">Actions</span></Th>
        </tr>
      </thead>
      <tbody>
        {items.map((i) => {
          const wp = workingPaper(orgId, i);
          return (
            <tr key={i.key} aria-label={`${i.name} ${i.periodLabel}`}>
              <Td className="whitespace-nowrap align-top">
                <span className="num">{date(i.dueDate)}</span>
                <span className="block text-xs text-fg-muted">{i.status === 'DONE' || i.status === 'NOTHING_DUE' ? '' : i.daysLeft < 0 ? `${-i.daysLeft} day${i.daysLeft === -1 ? '' : 's'} late` : i.daysLeft === 0 ? 'Today' : `in ${i.daysLeft} day${i.daysLeft === 1 ? '' : 's'}`}</span>
              </Td>
              <Td className="align-top">
                <span className="font-medium">{i.name}</span> <Badge tone="neutral">{AREA[i.area]}</Badge>
                <span className="block text-sm text-fg-muted">{i.periodLabel}{i.note ? ` · ${i.note}` : ''}</span>
                {i.evidence.length ? (
                  <span className="mt-1 flex flex-wrap gap-x-3 text-xs">
                    {i.evidence.map((e, n) => <Link key={`${e.type}${e.id}${n}`} className="text-accent hover:underline" href={evidenceHref(orgId, e)}>{e.label}</Link>)}
                  </span>
                ) : null}
                {i.filing ? <span className="mt-1 block text-xs text-fg-muted">Filed {date(i.filing.filedOn)} · <span className="num">{i.filing.reference}</span></span> : null}
              </Td>
              <Td className="whitespace-nowrap text-right align-top num">
                {i.amount !== null ? money(i.amount, 'INR') : '—'}
                {i.outstanding && i.outstanding !== '0.00' && i.paid !== '0.00' ? <span className="block text-xs text-fg-muted">{money(i.outstanding, 'INR')} to pay</span> : null}
              </Td>
              <Td className="align-top">
                <Badge tone={STATUS[i.status].tone}>{STATUS[i.status].label}</Badge>
                <span className="block text-xs text-fg-muted">{i.detail}</span>
              </Td>
              <Td className="whitespace-nowrap text-right align-top">
                <span className="flex justify-end gap-1">
                  {wp && !(i.nature === 'PAYMENT' && (i.status === 'DONE' || i.status === 'NOTHING_DUE')) ? <Link className="rounded px-2 py-1 text-sm text-accent hover:underline" href={wp}>{i.nature === 'PAYMENT' ? 'Record' : 'Working paper'}</Link> : null}
                  {canManage && i.nature === 'RETURN' && !i.filing ? <Button variant="secondary" aria-label={`Mark ${i.name} ${i.periodLabel} filed`} onClick={() => onFile(i)}>{i.kind === 'ADVANCE_TAX' ? 'Mark paid' : 'Mark filed'}</Button> : null}
                  {canManage && i.filing ? <Button variant="ghost" aria-label={`Void filing of ${i.name} ${i.periodLabel}`} onClick={() => onVoid(i)}>Void</Button> : null}
                </span>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function useRefresh() {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['compliance', orgId] });
}

function FileDialog({ item, onClose }: { item: ComplianceItem; onClose: () => void }) {
  const { orgId } = useOrg();
  const refresh = useRefresh();
  const [form, setForm] = useState({ filedOn: today(), reference: '', note: '' });
  const save = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/compliance/filings`, { method: 'POST', body: { key: item.key, filedOn: form.filedOn, reference: form.reference, note: form.note || null } }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const isPayment = item.kind === 'ADVANCE_TAX';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`${item.name} · ${item.periodLabel}`} description={`Due ${date(item.dueDate)}. Record ${isPayment ? 'the challan you paid with' : 'the acknowledgement from the portal'}; this does not file anything.`}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <ErrorAlert title="Not recorded" error={save.error} />
        <Field label={isPayment ? 'Paid on' : 'Filed on'}>{(p) => <Input {...p} type="date" max={today()} value={form.filedOn} onChange={(e) => setForm({ ...form, filedOn: e.target.value })} />}</Field>
        <Field label={isPayment ? 'Challan (BSR code, date, serial)' : 'Acknowledgement (ARN or token)'}>{(p) => <Input {...p} className="num" maxLength={100} value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />}</Field>
        <Field label="Note (optional)">{(p) => <Input {...p} maxLength={500} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending} disabled={!form.reference.trim() || !form.filedOn}>{isPayment ? 'Mark paid' : 'Mark filed'}</Button>
        </div>
      </form>
    </Dialog>
  );
}

function VoidDialog({ item, onClose }: { item: ComplianceItem; onClose: () => void }) {
  const { orgId } = useOrg();
  const refresh = useRefresh();
  const [reason, setReason] = useState('');
  const v = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/compliance/filings/${item.filing!.id}/void`, { method: 'POST', body: { reason } }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Void filing record · ${item.name}`} description={`${item.periodLabel}, recorded as ${item.filing?.reference}. The record is kept, marked void, and the obligation shows as open again.`}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); v.mutate(); }}>
        <ErrorAlert title="Not voided" error={v.error} />
        <Field label="Reason">{(p) => <Input {...p} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={v.isPending} disabled={reason.trim().length < 3}>Void record</Button>
        </div>
      </form>
    </Dialog>
  );
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { orgId } = useOrg();
  const refresh = useRefresh();
  const s = useQuery({ queryKey: ['compliance-settings', orgId], queryFn: () => api<ComplianceSettings>(`/v1/orgs/${orgId}/compliance/settings`) });
  const [form, setForm] = useState<{ gstReturnFrequency: 'MONTHLY' | 'QUARTERLY'; advanceTax: boolean; advanceTaxFrom: string } | null>(null);
  const f = form ?? (s.data ? { gstReturnFrequency: s.data.gstReturnFrequency, advanceTax: !!s.data.advanceTaxFrom, advanceTaxFrom: s.data.advanceTaxFrom ?? `${today().slice(0, 4)}-04-01` } : null);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/compliance/settings`, { method: 'PUT', body: { gstReturnFrequency: f!.gstReturnFrequency, advanceTaxFrom: f!.advanceTax ? f!.advanceTaxFrom : null } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['compliance-settings', orgId] });
      await refresh();
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Calendar settings" description="GST, TDS/TCS and payroll come from their own settings. These are the choices the calendar cannot work out from the books.">
      {!f ? <p className="text-sm text-fg-muted">Loading…</p> : (
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <ErrorAlert title="Not saved" error={save.error} />
          <Field label="GST returns" hint={s.data?.areas.gst ? 'QRMP is open to taxpayers with turnover up to Rs 5 crore who opted in on the portal.' : 'GST is not registered, so no GST returns are listed.'}>
            {(p) => (
              <Select {...p} value={f.gstReturnFrequency} onChange={(e) => setForm({ ...f, gstReturnFrequency: e.target.value as 'MONTHLY' | 'QUARTERLY' })}>
                <option value="MONTHLY">Monthly GSTR-1 and GSTR-3B</option>
                <option value="QUARTERLY">Quarterly (QRMP) with monthly PMT-06</option>
              </Select>
            )}
          </Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[var(--t2t-accent)]" checked={f.advanceTax} onChange={(e) => setForm({ ...f, advanceTax: e.target.checked })} /> Track advance income tax instalments</label>
          {f.advanceTax ? <Field label="Track from">{(p) => <Input {...p} type="date" value={f.advanceTaxFrom} onChange={(e) => setForm({ ...f, advanceTaxFrom: e.target.value })} />}</Field> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={save.isPending}>Save settings</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
