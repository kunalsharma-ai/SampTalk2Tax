'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, Table, Td, Th } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useOrg, usePayrollSettings } from '@/lib/org';
import { lastDay, monthLabel } from '@/lib/payroll';
import { can, type PayRun, type PayRunSummary } from '@/lib/types';

const STATUS = { DRAFT: <Badge tone="warning">Draft</Badge>, POSTED: <Badge tone="positive">Posted</Badge>, VOID: <Badge>Void</Badge> } as const;

export default function PayRunsPage() {
  const { org, orgId } = useOrg();
  const settings = usePayrollSettings();
  const router = useRouter();
  const qc = useQueryClient();
  const runs = useQuery({ queryKey: ['pay-runs', orgId], enabled: settings.data?.configured === true, queryFn: () => api<PayRunSummary[]>(`/v1/orgs/${orgId}/payroll/runs`) });
  const [draft, setDraft] = useState<{ period: string; payDate: string } | null>(null);
  const create = useMutation({
    mutationFn: () => api<PayRun>(`/v1/orgs/${orgId}/payroll/runs`, { method: 'POST', body: draft ?? undefined }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['pay-runs', orgId] });
      router.push(`/orgs/${orgId}/payroll/runs/${r.id}`);
    },
  });
  if (!org) return null;
  const canManage = can(org.role, 'payroll.manage');
  const rows = runs.data ?? [];
  const thisMonth = today().slice(0, 7);
  return (
    <>
      <PageHeader
        title="Pay runs"
        description="One pay run a month: review every payslip as a draft, post it to the ledger, then record the salary transfer and the PF, ESI, professional tax and TDS payments."
        actions={canManage && settings.data?.configured ? <Button onClick={() => { create.reset(); setDraft({ period: thisMonth, payDate: lastDay(thisMonth) }); }}>New pay run</Button> : null}
      />
      {settings.data && !settings.data.configured ? (
        <Card><EmptyState title="Payroll is not set up" action={<Link href={`/orgs/${orgId}/settings/payroll`}><Button>Set up payroll</Button></Link>}>Choose the accounts pay runs post to, then add employees.</EmptyState></Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <Table className="min-w-[900px]">
              <thead><tr><Th>Pay run</Th><Th>Month</Th><Th>Status</Th><Th>Pay date</Th><Th numeric>Employees</Th><Th numeric>Gross</Th><Th numeric>Net pay</Th><Th numeric>Cost to employer</Th><Th>Paid</Th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`cursor-pointer hover:bg-surface-hover ${r.status === 'VOID' ? 'opacity-60' : ''}`} onClick={() => router.push(`/orgs/${orgId}/payroll/runs/${r.id}`)}>
                    <Td><Link className="num text-accent hover:underline" href={`/orgs/${orgId}/payroll/runs/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.number}</Link></Td>
                    <Td className="whitespace-nowrap">{monthLabel(r.period)}</Td>
                    <Td>{STATUS[r.status]}</Td>
                    <Td className="whitespace-nowrap">{date(r.payDate)}</Td>
                    <Td numeric>{r.employees}</Td>
                    <Td numeric><Money value={r.gross} currency="INR" /></Td>
                    <Td numeric><Money value={r.net} currency="INR" /></Td>
                    <Td numeric><Money value={r.employerCost} currency="INR" /></Td>
                    <Td className="text-sm text-fg-muted">{r.status === 'POSTED' ? (r.paid.length === 5 ? 'All' : r.paid.length ? `${r.paid.length} of 5` : 'Nothing yet') : '—'}</Td>
                  </tr>
                ))}
                {rows.length === 0 && !runs.isLoading ? <tr><Td colSpan={9} className="py-8 text-center text-fg-muted">No pay runs yet.</Td></tr> : null}
              </tbody>
            </Table>
          </div>
        </Card>
      )}
      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)} title="New pay run" description="Creates a draft with a payslip for everyone employed in the month who has a salary.">
        {draft ? (
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <Field label="Month">{(p) => <Input {...p} type="month" value={draft.period} onChange={(e) => setDraft({ period: e.target.value, payDate: e.target.value ? lastDay(e.target.value) : draft.payDate })} />}</Field>
            <Field label="Pay date" hint="When salaries are paid.">{(p) => <Input {...p} type="date" value={draft.payDate} onChange={(e) => setDraft({ ...draft, payDate: e.target.value })} />}</Field>
            {create.error ? <div className="sm:col-span-2"><Alert title="Not created">{create.error.message}{create.error instanceof ApiError && create.error.issues.length ? <ul className="mt-1 list-inside list-disc">{create.error.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}</Alert></div> : null}
            <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button><Button type="submit" loading={create.isPending} disabled={!draft.period || !draft.payDate}>Create draft</Button></div>
          </form>
        ) : null}
      </Dialog>
    </>
  );
}
