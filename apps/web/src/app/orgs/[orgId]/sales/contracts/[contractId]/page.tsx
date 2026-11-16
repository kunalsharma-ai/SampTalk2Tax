'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FREQUENCY_LABEL, FREQUENCY_MONTHS } from '@talk2tax/accounting-engine';
import { placeOfSupplyName } from '@talk2tax/tax-engine';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { ContractBadge, RenewalBadge } from '@/components/sales-orders/badges';
import { UsageCard } from '@/components/contracts/usage-card';
import { SalesLinesTable } from '@/components/sales-orders/lines-table';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { ContractDetail } from '@/lib/sales-orders';

const DOC_TONE = { DRAFT: 'neutral', POSTED: 'positive', VOID: 'negative' } as const;

export default function ContractPage() {
  const { org, orgId } = useOrg();
  const { contractId } = useParams<{ contractId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const key = ['sales-contract', orgId, contractId];
  const contract = useQuery({ queryKey: key, queryFn: () => api<ContractDetail>(`/v1/orgs/${orgId}/sales/contracts/${contractId}`) });
  const [renewing, setRenewing] = useState(false);
  const [months, setMonths] = useState('12');
  const [uplift, setUplift] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const base = `/v1/orgs/${orgId}/sales/contracts/${contractId}`;
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: key });
    await qc.invalidateQueries({ queryKey: ['sales-contracts', orgId] });
    await qc.invalidateQueries({ queryKey: ['documents', orgId] });
    await qc.invalidateQueries({ queryKey: ['crm-deal', orgId] });
  };
  const act = useMutation({
    mutationFn: (a: 'activate' | 'pause' | 'resume' | 'bill-due' | 'delete' | 'cancel' | 'renew') =>
      a === 'delete'
        ? api(base, { method: 'DELETE' })
        : api(`${base}/${a}`, { method: 'POST', body: a === 'cancel' ? { reason } : a === 'renew' ? { months: Number(months), upliftPercent: uplift.trim() || null } : undefined }),
    onSuccess: async (_r, a) => {
      setRenewing(false);
      setCancelling(false);
      if (a === 'delete') {
        await qc.invalidateQueries({ queryKey: ['sales-contracts', orgId] });
        router.push(`/orgs/${orgId}/sales/contracts`);
      } else await refresh();
    },
  });
  const again = useMutation({
    mutationFn: (periodNo: number) => api<{ documentId: string }>(`${base}/periods/${periodNo}/bill-again`, { method: 'POST' }),
    onSuccess: refresh,
  });

  if (!org) return null;
  if (contract.error) return <ErrorAlert title="Could not load the contract" error={contract.error} />;
  const c = contract.data;
  if (!c) return <p className="text-sm text-fg-muted">Loading…</p>;
  const cur = c.currency;
  const m = c.can.manage;
  const step = FREQUENCY_MONTHS[c.frequency];
  return (
    <>
      <PageHeader
        title={`${c.reference} ${c.title}`}
        description={[c.contact?.name, `${FREQUENCY_LABEL[c.frequency].toLowerCase()} ${c.timing === 'ADVANCE' ? 'in advance' : 'in arrears'}`, `${date(c.startDate)} – ${c.endDate ? date(c.endDate) : 'rolling'}`].filter(Boolean).join(' · ')}
        actions={
          m ? (
            <>
              {c.status === 'DRAFT' ? <Button variant="ghost" loading={act.isPending && act.variables === 'delete'} onClick={() => act.mutate('delete')}>Delete draft</Button> : null}
              {c.status === 'ACTIVE' || c.status === 'PAUSED' ? <Button variant="ghost" onClick={() => setCancelling(true)}>Cancel contract</Button> : null}
              {c.status !== 'ENDED' && c.status !== 'CANCELLED' ? <Link href={`/orgs/${orgId}/sales/contracts/${c.id}/edit`}><Button variant="secondary">Edit</Button></Link> : null}
              {c.endDate && (c.status === 'ACTIVE' || c.status === 'PAUSED' || c.status === 'ENDED') ? <Button variant="secondary" onClick={() => { setMonths(String(c.renewalMonths ?? Math.max(step, 12))); setRenewing(true); }}>Renew</Button> : null}
              {c.status === 'ACTIVE' ? <Button variant="secondary" loading={act.isPending && act.variables === 'pause'} onClick={() => act.mutate('pause')}>Pause</Button> : null}
              {c.status === 'PAUSED' ? <Button loading={act.isPending && act.variables === 'resume'} onClick={() => act.mutate('resume')}>Resume</Button> : null}
              {c.status === 'ACTIVE' ? <Button loading={act.isPending && act.variables === 'bill-due'} onClick={() => act.mutate('bill-due')}>Bill now</Button> : null}
              {c.status === 'DRAFT' ? <Button loading={act.isPending && act.variables === 'activate'} onClick={() => act.mutate('activate')}>Activate</Button> : null}
            </>
          ) : null
        }
      />
      <ErrorAlert title="That did not work" error={act.error ?? again.error} />
      {c.lastError && (c.status === 'ACTIVE' || c.status === 'PAUSED') ? (
        <Alert tone="negative" title="The last billing run could not make an invoice">{c.lastError}{c.lastErrorAt ? ` (${dateTime(c.lastErrorAt)})` : ''}. Fix it and press Bill now; the runner also retries every hour.</Alert>
      ) : null}
      {c.status === 'PAUSED' ? <Alert tone="warning" title="Paused">Periods that fall due while paused are skipped, not billed. Resume to bill again from the current period.</Alert> : null}
      {c.status === 'CANCELLED' ? <Alert tone="negative" title="Cancelled">{c.cancelReason}{c.cancelledAt ? ` (${dateTime(c.cancelledAt)})` : ''}</Alert> : null}
      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <div className="flex flex-col gap-4 xl:col-span-1">
          <Card>
            <CardHeader title="Contract" />
            <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-2 px-5 pb-5 text-sm">
              <dt className="text-fg-muted">Status</dt><dd className="flex flex-wrap gap-1"><ContractBadge status={c.status} /><RenewalBadge renewal={c.renewal} /></dd>
              <dt className="text-fg-muted">Customer</dt><dd>{c.contact ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/customers/${c.contact.id}`}>{c.contact.name}</Link> : '—'}</dd>
              <dt className="text-fg-muted">Per period</dt><dd className="font-medium"><Money value={c.total} currency={cur} /> <span className="text-xs text-fg-muted">incl. tax</span></dd>
              <dt className="text-fg-muted">MRR</dt><dd><Money value={c.monthlyValue} currency={cur} /></dd>
              <dt className="text-fg-muted">Next invoice</dt><dd>{c.nextBill && c.status === 'ACTIVE' ? `${date(c.nextBill.date)} (period ${c.nextBill.periodNo})` : '—'}</dd>
              <dt className="text-fg-muted">Periods billed</dt><dd>{c.periodsBilled}</dd>
              <dt className="text-fg-muted">Renewal</dt><dd>{c.endDate ? (c.autoRenew ? `Automatic, ${c.renewalMonths} months at a time` : `By hand; reminder ${c.noticeDays} days before the end`) : 'Rolling until cancelled'}</dd>
              <dt className="text-fg-muted">Payment terms</dt><dd>{c.paymentTermsDays === null ? "The customer's terms" : `${c.paymentTermsDays} days`}</dd>
              {c.deal ? <><dt className="text-fg-muted">Deal</dt><dd><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/pipeline/${c.deal.id}`}>{c.deal.reference} {c.deal.name}</Link></dd></> : null}
              {c.customerReference ? <><dt className="text-fg-muted">Their reference</dt><dd>{c.customerReference}</dd></> : null}
              {c.placeOfSupply ? <><dt className="text-fg-muted">Place of supply</dt><dd>{c.placeOfSupply} · {placeOfSupplyName(c.placeOfSupply)}</dd></> : null}
              {c.memo ? <><dt className="text-fg-muted">Memo</dt><dd>{c.memo}</dd></> : null}
            </dl>
          </Card>
          <Card>
            <CardHeader title="History" />
            <ol className="flex flex-col gap-3 px-5 pb-5 text-sm" aria-label="Contract history">
              {c.events.map((e) => (
                <li key={e.id}>
                  <p>{e.body}</p>
                  <p className="text-xs text-fg-muted">{dateTime(e.createdAt)} · {e.actor?.name ?? 'Automatic billing'}</p>
                </li>
              ))}
            </ol>
          </Card>
        </div>
        <div className="flex flex-col gap-4 xl:col-span-2">
          <SalesLinesTable lines={c.lines} currency={cur} subtotal={c.subtotal} tax={c.taxTotal} total={c.total} />
          {c.upcoming.length ? (
            <Card>
              <CardHeader title="Coming up" description={c.status === 'DRAFT' ? 'Activate the contract to start billing.' : 'Each becomes a draft invoice on its invoice date.'} />
              <Table aria-label="Upcoming periods">
                <thead><tr><Th>Period</Th><Th>From</Th><Th>To</Th><Th>Invoice date</Th></tr></thead>
                <tbody>
                  {c.upcoming.map((p) => <Tr key={p.periodNo}><Td>{p.periodNo}</Td><Td>{date(p.start)}</Td><Td>{date(p.end)}</Td><Td>{date(p.billDate)}</Td></Tr>)}
                </tbody>
              </Table>
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Billed periods" description="Deleting or voiding a period's invoice lets you bill that period again." />
            {c.periods.length === 0 ? <p className="px-5 pb-5 text-sm text-fg-muted">Nothing billed yet.</p> : (
              <Table aria-label="Billed periods">
                <thead><tr><Th>Period</Th><Th>From – to</Th><Th>Invoice</Th><Th>Status</Th><Th numeric>Total</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
                <tbody>
                  {c.periods.map((p) => (
                    <Tr key={p.id}>
                      <Td>{p.periodNo}</Td>
                      <Td className="whitespace-nowrap">{date(p.start)} – {date(p.end)}</Td>
                      <Td>{p.status === 'SKIPPED' ? <span className="text-fg-muted">Skipped while paused</span> : p.invoice ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/invoices/${p.invoice.id}`}>{p.invoice.number ?? 'Draft invoice'}</Link> : <span className="text-fg-muted">Invoice deleted</span>}</Td>
                      <Td>{p.invoice ? <Badge tone={DOC_TONE[p.invoice.status as keyof typeof DOC_TONE] ?? 'neutral'}>{p.invoice.status.charAt(0) + p.invoice.status.slice(1).toLowerCase()}</Badge> : null}</Td>
                      <Td numeric>{p.invoice ? <Money value={p.invoice.total} currency={cur} /> : '—'}</Td>
                      <Td>{m && p.canBillAgain ? <Button size="sm" variant="secondary" loading={again.isPending && again.variables === p.periodNo} onClick={() => again.mutate(p.periodNo)}>Bill again</Button> : null}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <UsageCard orgId={orgId} contractId={contractId} status={c.status} onChange={refresh} />
        </div>
      </div>
      <Dialog open={renewing} onOpenChange={setRenewing} title={`Renew ${c.reference}`} description={`Extends the end date by whole ${FREQUENCY_LABEL[c.frequency].toLowerCase()} periods. A price change applies to every period billed from now on.`}>
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); act.mutate('renew'); }}>
          <Field label="Renew for (months)" hint={`A multiple of ${step}.`}>{(p) => <Input {...p} inputMode="numeric" className="num" value={months} onChange={(e) => /^\d{0,3}$/.test(e.target.value) && setMonths(e.target.value)} />}</Field>
          <Field label="Price change (%)" hint="Optional, for example 5 for a 5% rise. Every line's price changes.">{(p) => <Input {...p} inputMode="decimal" className="num" value={uplift} onChange={(e) => /^-?\d{0,3}(\.\d{0,2})?$/.test(e.target.value) && setUplift(e.target.value)} />}</Field>
          <ErrorAlert title="Could not renew" error={act.error} />
          <div className="flex justify-end"><Button type="submit" loading={act.isPending} disabled={!months || Number(months) % step !== 0}>Renew</Button></div>
        </form>
      </Dialog>
      <Dialog open={cancelling} onOpenChange={setCancelling} title={`Cancel ${c.reference}`} description="Nothing more is billed. Invoices already made stay as they are.">
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); act.mutate('cancel'); }}>
          <Field label="Why is it cancelled?">{(p) => <Textarea {...p} rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Customer moved the work in-house" />}</Field>
          <ErrorAlert title="Could not cancel it" error={act.error} />
          <div className="flex justify-end"><Button type="submit" variant="danger" loading={act.isPending} disabled={!reason.trim()}>Cancel contract</Button></div>
        </form>
      </Dialog>
    </>
  );
}
