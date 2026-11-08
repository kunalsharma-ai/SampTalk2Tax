'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { LineDimensionTags } from '@/components/dimensions/line-dimensions';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useDimensions } from '@/lib/dimensions';
import { date, dateTime, today } from '@/lib/format';
import { useOrg, useTaxRates } from '@/lib/org';
import { recurringBillStatus, type RecurringBillDetail } from '@/lib/recurring-bills';
import { can } from '@/lib/types';

export default function RecurringBillPage() {
  const { org, orgId } = useOrg();
  const dims = useDimensions();
  const taxRates = useTaxRates(true);
  const { billId } = useParams<{ billId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [resumeOpen, setResumeOpen] = useState(false);
  const q = useQuery({ queryKey: ['recurring-bill', orgId, billId], queryFn: () => api<RecurringBillDetail>(`/v1/orgs/${orgId}/purchases/recurring-bills/${billId}`) });
  const base = `/v1/orgs/${orgId}/purchases/recurring-bills/${billId}`;
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['recurring-bill', orgId] });
    await qc.invalidateQueries({ queryKey: ['recurring-bills', orgId] });
    await qc.invalidateQueries({ queryKey: ['documents', orgId] });
  };
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: { skipMissed: boolean } }) => api<RecurringBillDetail | { made: number; error: string | null; recurringBill: RecurringBillDetail }>(`${base}/${path}`, { method: 'POST', body }),
    onSuccess: async () => {
      setResumeOpen(false);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api(base, { method: 'DELETE' }),
    onSuccess: async () => {
      await refresh();
      router.replace(`/orgs/${orgId}/purchases/recurring-bills`);
    },
  });

  if (!org) return null;
  if (q.error) return <Alert title="Recurring bill not found">{(q.error as Error).message}</Alert>;
  const t = q.data;
  if (!t) return <p className="text-sm text-fg-muted">Loading…</p>;
  const manage = can(org.role, 'purchases.manage');
  const mayRun = manage && (t.schedule.postMode === 'DRAFT' || can(org.role, 'journals.post'));
  const s = t.schedule;
  const st = recurringBillStatus(s);
  const ran = action.data && 'made' in action.data ? action.data : null;
  const taxName = new Map((taxRates.data ?? []).map((x) => [x.id, x.name]));

  return (
    <>
      <PageHeader
        title={`${t.reference} · ${t.name}`}
        description={`${t.contact.name}. ${s.description}.`}
        actions={
          manage ? (
            <>
              {s.status === 'ACTIVE' && mayRun ? <Button loading={action.isPending && action.variables?.path === 'run-due'} onClick={() => action.mutate({ path: 'run-due' })}>Make due bills now</Button> : null}
              {s.status === 'ACTIVE' ? <Button variant="secondary" onClick={() => action.mutate({ path: 'pause' })}>Pause</Button> : null}
              {s.status === 'PAUSED' && mayRun ? <Button variant="secondary" onClick={() => setResumeOpen(true)}>Resume…</Button> : null}
              {s.status !== 'ENDED' ? <Link href={`/orgs/${orgId}/purchases/recurring-bills/${t.id}/edit`}><Button variant="secondary">Edit</Button></Link> : null}
              {s.status !== 'ENDED' && t.runs.length ? <Button variant="ghost" onClick={() => confirm('End this recurring bill? No more bills will be made from it. Bills already made stay as they are.') && action.mutate({ path: 'end' })}>End</Button> : null}
              {!t.runs.length ? <Button variant="danger" loading={remove.isPending} onClick={() => confirm('Delete this recurring bill? It has not made any bills.') && remove.mutate()}>Delete</Button> : null}
            </>
          ) : null
        }
      />
      <ErrorAlert title="That did not work" error={action.error ?? remove.error} />
      {ran ? (
        <Alert tone={ran.error ? 'warning' : 'positive'} title={ran.made ? `${ran.made} ${ran.made === 1 ? 'bill' : 'bills'} made` : ran.error ? 'No bill was made' : 'Nothing was due'}>
          {ran.error ?? (ran.made ? 'They are listed under Bills made below.' : 'Every bill up to today has been made.')}
        </Alert>
      ) : null}
      {s.lastError && !ran ? (
        <Alert tone="negative" title="The last bill could not be made">
          {s.lastError} ({s.lastErrorAt ? dateTime(s.lastErrorAt) : ''}). Nothing was saved for it. Fix the cause (for example, open the period, approve the bill rule, or change the vendor reference) and it is tried again at the next check, or press Make due bills now.
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Status</p>
          <div className="mt-2"><Badge tone={st.tone}>{st.label}</Badge></div>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Each bill, before tax</p>
          <p className="mt-2 text-sm"><Money value={t.subtotal} currency={t.currency} /></p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Vendor reference and due date</p>
          <p className="mt-2 text-sm">{t.vendorReference ?? 'None'}<span className="block text-xs text-fg-muted">{t.dueDays !== null ? `Due ${t.dueDays} days after the bill date` : "Due on the vendor's payment terms"}</span></p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Next bill</p>
          <p className="mt-2 text-sm">{s.nextRun && s.status !== 'ENDED' ? `${date(s.nextRun.date)} (run ${s.nextRun.no}${s.runsTotal ? ` of ${s.runsTotal}` : ''})` : 'None left'}</p>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Bill lines" description={`Every bill made from this recurring bill carries these lines. Tax is worked out on each bill${t.reverseCharge ? ', under reverse charge' : ''}${t.placeOfSupply ? `, place of supply ${t.placeOfSupply}` : ''}.`} />
        <Table aria-label="Recurring bill lines">
          <thead>
            <tr><Th>Account</Th><Th>Description</Th><Th numeric>Qty</Th><Th numeric>Unit price</Th><Th>Tax</Th><Th numeric>Amount</Th></tr>
          </thead>
          <tbody>
            {t.lines.map((l) => (
              <Tr key={l.lineNo}>
                <Td>
                  {l.account ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/accounts/${l.accountId}`}>{l.account.code} · {l.account.name}</Link> : '—'}
                  <LineDimensionTags values={dims.data?.values} departmentId={l.departmentId} projectId={l.projectId} />
                </Td>
                <Td>{l.description ?? ''}{l.hsnCode ? <span className="block text-xs text-fg-muted">HSN/SAC {l.hsnCode}</span> : null}</Td>
                <Td numeric>{l.quantity}</Td>
                <Td numeric><Money value={l.unitPrice} currency={t.currency} /></Td>
                <Td>{l.taxRateId ? (taxName.get(l.taxRateId) ?? '') : 'No tax'}</Td>
                <Td numeric><Money value={l.amount} currency={t.currency} /></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card className="mt-6">
        <CardHeader title="Upcoming bills" description={`${s.description}. Each bill ${s.postMode === 'POST' ? 'is posted' : 'is saved as a draft for someone to check and post'}.`} />
        {t.upcoming.length ? (
          <Table aria-label="Upcoming bills">
            <thead>
              <tr><Th>Run</Th><Th>Bill date</Th><Th>Vendor reference</Th></tr>
            </thead>
            <tbody>
              {t.upcoming.map((r) => (
                <Tr key={r.no}>
                  <Td>{r.no}</Td>
                  <Td>{date(r.date)}{r.date <= today() && s.status === 'ACTIVE' ? <Badge tone="warning" className="ml-2">Due</Badge> : null}</Td>
                  <Td>{r.reference ?? '—'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="px-5 pb-5 text-sm text-fg-muted">{s.status === 'ENDED' ? 'This recurring bill has ended.' : 'No bill is left before the last date.'}</p>
        )}
      </Card>

      <Card className="mt-6">
        <CardHeader title="Bills made" description="Every bill this recurring bill made, newest first, by the hourly check or by a member." />
        {t.runs.length ? (
          <Table aria-label="Bills made">
            <thead>
              <tr><Th>Bill date</Th><Th>Made by</Th><Th>Bill</Th><Th>Vendor reference</Th><Th>Due</Th><Th numeric>Total</Th></tr>
            </thead>
            <tbody>
              {t.runs.map((r) => (
                <Tr key={r.id}>
                  <Td>{date(r.date)}<span className="block text-xs text-fg-muted">Run {r.runNo}</span></Td>
                  <Td>{r.by}<span className="block text-xs text-fg-muted">{dateTime(r.createdAt)}</span></Td>
                  <Td>
                    {r.bill ? (
                      <>
                        <Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/bills/${r.bill.id}`}>{r.bill.number ?? 'Draft bill'}</Link>{' '}
                        {r.bill.status === 'DRAFT' ? <Badge tone="warning">Draft</Badge> : r.bill.status === 'VOID' ? <Badge tone="negative">Void</Badge> : <Badge tone="positive">Posted</Badge>}
                      </>
                    ) : (
                      <span className="text-xs text-fg-muted">Draft deleted</span>
                    )}
                  </Td>
                  <Td>{r.bill?.reference ?? '—'}</Td>
                  <Td>{r.bill ? date(r.bill.dueDate) : '—'}</Td>
                  <Td numeric>{r.bill ? <Money value={r.bill.total} currency={t.currency} /> : '—'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="px-5 pb-5 text-sm text-fg-muted">No bill has been made yet.</p>
        )}
      </Card>

      <Dialog open={resumeOpen} onOpenChange={setResumeOpen} title="Resume the recurring bill" description="Bills that fell due while it was paused can be made now, or passed over.">
        <div className="flex flex-col gap-2">
          <Button loading={action.isPending && action.variables?.path === 'resume' && !action.variables.body?.skipMissed} onClick={() => action.mutate({ path: 'resume', body: { skipMissed: false } })}>Resume and make the missed bills</Button>
          <Button variant="secondary" loading={action.isPending && action.variables?.path === 'resume' && !!action.variables.body?.skipMissed} onClick={() => action.mutate({ path: 'resume', body: { skipMissed: true } })}>Resume from today, skipping missed bills</Button>
        </div>
      </Dialog>
    </>
  );
}
