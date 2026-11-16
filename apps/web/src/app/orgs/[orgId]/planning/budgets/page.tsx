'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { api } from '@/lib/api';
import { basisLabel, BUDGET_STATUS, type BudgetBasis, type BudgetDetail, type BudgetOverview } from '@/lib/budgets';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

export default function BudgetsPage() {
  return (
    <Suspense>
      <Budgets />
    </Suspense>
  );
}

function Budgets() {
  const { org, orgId } = useOrg();
  const params = useSearchParams();
  const router = useRouter();
  const fy = params.get('fy');
  const q = useQuery({ queryKey: ['budgets', orgId, fy], queryFn: () => api<BudgetOverview>(`/v1/orgs/${orgId}/budgets${fy ? `?fiscalYear=${fy}` : ''}`) });
  const [creating, setCreating] = useState(false);
  if (!org) return null;
  const canManage = can(org.role, 'budgets.manage');
  const d = q.data;
  const approved = d?.budgets.find((b) => b.status === 'APPROVED');
  return (
    <>
      <PageHeader
        title="Budgets"
        description="Monthly budgets for revenue and expense accounts, kept as numbered versions for each fiscal year. A version is changed only while it is a draft; once submitted, someone other than the submitter approves it, and approving a new version supersedes the old one."
        actions={canManage && d ? <Button onClick={() => setCreating(true)}>New version</Button> : null}
      />
      <ErrorAlert title="Could not load budgets" error={q.error} />
      {d ? (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Fiscal year">
            {d.years.map((y) => (
              <Button key={y.fiscalYear} size="sm" variant={y.fiscalYear === d.fiscalYear ? 'secondary' : 'ghost'} aria-pressed={y.fiscalYear === d.fiscalYear} onClick={() => router.replace(`/orgs/${orgId}/planning/budgets?fy=${y.fiscalYear}`)}>
                {y.label}
                {y.fiscalYear === d.currentFiscalYear ? ' (this year)' : ''}
              </Button>
            ))}
            <span className="ml-auto text-sm text-fg-muted">
              {date(d.from)} – {date(d.to)}
            </span>
          </div>
          {d.budgets.length ? (
            <Card>
              <CardHeader
                title={`FY${d.fiscalYear} versions`}
                description={approved ? `Version ${approved.version} is the approved budget.` : 'No version is approved yet.'}
                actions={approved ? <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/planning/budget-vs-actual?budget=${approved.id}`}>Budget vs actual →</Link> : null}
              />
              <Table>
                <thead>
                  <tr>
                    <Th>Version</Th>
                    <Th>Status</Th>
                    <Th>Started from</Th>
                    <Th numeric>Revenue</Th>
                    <Th numeric>Expenses</Th>
                    <Th numeric>Net income</Th>
                    <Th>Last change</Th>
                  </tr>
                </thead>
                <tbody>
                  {d.budgets.map((b) => (
                    <Tr key={b.id}>
                      <Td>
                        <Link className="text-accent hover:underline" href={`/orgs/${orgId}/planning/budgets/${b.id}`}>
                          v{b.version} · {b.name}
                        </Link>
                        <div className="text-xs text-fg-muted">{b.accounts} account{b.accounts === 1 ? '' : 's'}</div>
                      </Td>
                      <Td>
                        <Badge tone={BUDGET_STATUS[b.status].tone}>{BUDGET_STATUS[b.status].label}</Badge>
                        {b.status === 'DRAFT' && b.returned ? <div className="mt-1 text-xs text-warning">Sent back: {b.returned.reason}</div> : null}
                      </Td>
                      <Td className="text-fg-muted">{basisLabel(b, b.sourceBudgetId ? (() => { const s = d.budgets.find((x) => x.id === b.sourceBudgetId); return s ? { version: s.version, fiscalYear: s.fiscalYear } : null; })() : null)}</Td>
                      <Td numeric><Money value={b.revenue} currency={d.currency} /></Td>
                      <Td numeric><Money value={b.expenses} currency={d.currency} /></Td>
                      <Td numeric><Money value={b.netIncome} currency={d.currency} signed /></Td>
                      <Td className="text-xs text-fg-muted">
                        {b.approvedAt ? `Approved by ${b.approvedBy?.name} on ${date(b.approvedAt.slice(0, 10))}` : b.submittedAt ? `Submitted by ${b.submittedBy?.name} on ${date(b.submittedAt.slice(0, 10))}` : `Created by ${b.createdBy?.name} on ${date(b.createdAt.slice(0, 10))}`}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : (
            <EmptyState title={`No budget for FY${d.fiscalYear} yet`} action={canManage ? <Button onClick={() => setCreating(true)}>New version</Button> : null}>
              Start from last year&apos;s actuals with a percentage change, copy another version, or start empty and enter the amounts.
            </EmptyState>
          )}
          {creating ? <CreateDialog overview={d} onClose={() => setCreating(false)} /> : null}
        </>
      ) : null}
    </>
  );
}

function CreateDialog({ overview, onClose }: { overview: BudgetOverview; onClose: () => void }) {
  const { orgId } = useOrg();
  const router = useRouter();
  const [form, setForm] = useState<{ fiscalYear: number; name: string; basis: BudgetBasis; changePercent: string; sourceBudgetId: string }>({
    fiscalYear: overview.fiscalYear,
    name: overview.budgets.length ? `Revision ${overview.budgets.length + 1}` : 'Original plan',
    basis: overview.budgets.length ? 'COPY' : 'PRIOR_ACTUALS',
    changePercent: '10',
    sourceBudgetId: overview.budgets[0]?.id ?? '',
  });
  // Versions of other years can be copied too.
  const all = useQuery({
    queryKey: ['budgets-all', orgId],
    queryFn: async () => (await Promise.all(overview.years.map((y) => api<BudgetOverview>(`/v1/orgs/${orgId}/budgets?fiscalYear=${y.fiscalYear}`)))).flatMap((o) => o.budgets),
  });
  const create = useMutation({
    mutationFn: () =>
      api<BudgetDetail>(`/v1/orgs/${orgId}/budgets`, {
        method: 'POST',
        body: {
          fiscalYear: form.fiscalYear,
          name: form.name,
          basis: form.basis,
          ...(form.basis === 'COPY' ? { sourceBudgetId: form.sourceBudgetId } : {}),
          ...(form.basis === 'PRIOR_ACTUALS' ? { changePercent: form.changePercent.trim() } : {}),
        },
      }),
    onSuccess: (b) => router.push(`/orgs/${orgId}/planning/budgets/${b.budget.id}`),
  });
  const pctOk = /^-?\d{1,4}(\.\d{1,2})?$/.test(form.changePercent.trim());
  const ok = form.name.trim() && (form.basis !== 'COPY' || form.sourceBudgetId) && (form.basis !== 'PRIOR_ACTUALS' || pctOk);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="New budget version" description="The new version is a draft you can change until it is submitted for approval.">
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <ErrorAlert title="Not created" error={create.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Fiscal year">
            {(p) => (
              <Select {...p} value={form.fiscalYear} onChange={(e) => setForm({ ...form, fiscalYear: Number(e.target.value) })}>
                {overview.years.map((y) => <option key={y.fiscalYear} value={y.fiscalYear}>{y.label} ({date(y.from)} – {date(y.to)})</option>)}
              </Select>
            )}
          </Field>
          <Field label="Name">{(p) => <Input {...p} maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        </div>
        <Field label="Start from">
          {(p) => (
            <Select {...p} value={form.basis} onChange={(e) => setForm({ ...form, basis: e.target.value as BudgetBasis })}>
              <option value="PRIOR_ACTUALS">FY{form.fiscalYear - 1} actuals, with a change</option>
              <option value="COPY">Another version</option>
              <option value="EMPTY">Empty</option>
            </Select>
          )}
        </Field>
        {form.basis === 'PRIOR_ACTUALS' ? (
          <Field label="Change (%)" hint={`Each month of FY${form.fiscalYear - 1}'s posted revenue and expenses, changed by this percentage (use a minus sign to reduce).`} error={pctOk ? undefined : 'A percentage such as 10 or -2.5'}>
            {(p) => <Input {...p} inputMode="decimal" className="num w-32" value={form.changePercent} onChange={(e) => setForm({ ...form, changePercent: e.target.value })} />}
          </Field>
        ) : null}
        {form.basis === 'COPY' ? (
          <Field label="Version to copy">
            {(p) => (
              <Select {...p} value={form.sourceBudgetId} onChange={(e) => setForm({ ...form, sourceBudgetId: e.target.value })}>
                <option value="">Choose…</option>
                {(all.data ?? overview.budgets).map((b) => <option key={b.id} value={b.id}>FY{b.fiscalYear} v{b.version} · {b.name} ({BUDGET_STATUS[b.status].label.toLowerCase()})</option>)}
              </Select>
            )}
          </Field>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={create.isPending} disabled={!ok}>Create draft</Button>
        </div>
      </form>
    </Dialog>
  );
}
