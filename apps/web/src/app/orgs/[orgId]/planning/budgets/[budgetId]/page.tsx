'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { budgetAmountsIssue, D, spreadEvenly, sum } from '@talk2tax/accounting-engine';
import { Badge, Button, Card, CardHeader, Dialog, Field, Input, Table, Td, Th } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Fragment, useMemo, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { basisLabel, BUDGET_STATUS, type BudgetDetail, type BudgetRow } from '@/lib/budgets';
import { date, money } from '@/lib/format';
import { useMe, useOrg } from '@/lib/org';
import { can } from '@/lib/types';

type Grid = Record<string, string[] | null>;
const blank = () => Array.from({ length: 12 }, () => '');
const isBlank = (row: string[] | null) => !row || row.every((x) => x.trim() === '');
/** Blank cells in a row that has any amount count as zero. */
const normalise = (row: string[] | null) => (isBlank(row) ? null : row!.map((x) => (x.trim() === '' ? '0' : x.trim().replace(/,/g, ''))));
const asDec = (x: string) => {
  try {
    return x.trim() === '' ? new D(0) : new D(x.trim().replace(/,/g, ''));
  } catch {
    return new D(0);
  }
};
const time = (iso: string) => `${date(iso.slice(0, 10))}, ${new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })} IST`;

export default function BudgetPage() {
  const { org, orgId } = useOrg();
  const { budgetId } = useParams<{ budgetId: string }>();
  const me = useMe();
  const qc = useQueryClient();
  const router = useRouter();
  const key = ['budget', orgId, budgetId];
  const q = useQuery({ queryKey: key, queryFn: () => api<BudgetDetail>(`/v1/orgs/${orgId}/budgets/${budgetId}`) });
  const [edits, setEdits] = useState<Grid>({});
  const [onlyBudgeted, setOnlyBudgeted] = useState(false);
  const [spreading, setSpreading] = useState<BudgetRow | null>(null);
  const [dialog, setDialog] = useState<'rename' | 'return' | 'delete' | null>(null);

  const refresh = async (d?: BudgetDetail) => {
    if (d) qc.setQueryData(key, d);
    await qc.invalidateQueries({ queryKey: ['budgets', orgId] });
  };
  const action = useMutation({
    mutationFn: (a: 'submit' | 'withdraw' | 'approve') => api<BudgetDetail>(`/v1/orgs/${orgId}/budgets/${budgetId}/${a}`, { method: 'POST' }),
    onSuccess: refresh,
  });
  const copy = useMutation({
    mutationFn: (b: BudgetDetail['budget']) => api<BudgetDetail>(`/v1/orgs/${orgId}/budgets`, { method: 'POST', body: { basis: 'COPY', fiscalYear: b.fiscalYear, name: `${b.name} (revised)`.slice(0, 100), sourceBudgetId: b.id } }),
    onSuccess: async (d) => {
      await refresh();
      router.push(`/orgs/${orgId}/planning/budgets/${d.budget.id}`);
    },
  });
  const dirty = Object.keys(edits);
  const issues = useMemo(() => {
    const out: Record<string, string> = {};
    for (const id of dirty) {
      const n = normalise(edits[id]);
      const issue = n ? budgetAmountsIssue(n, 2) : null;
      if (issue) out[id] = issue;
    }
    return out;
  }, [edits, dirty]);
  const save = useMutation({
    mutationFn: () => api<BudgetDetail>(`/v1/orgs/${orgId}/budgets/${budgetId}/lines`, { method: 'PUT', body: { lines: dirty.map((accountId) => ({ accountId, amounts: normalise(edits[accountId]) })) } }),
    onSuccess: async (d) => {
      setEdits({});
      await refresh(d);
    },
  });

  if (!org || !q.data) return <ErrorAlert title="Could not load the budget" error={q.error} />;
  const d = q.data;
  const b = d.budget;
  const c = d.currency;
  const editable = b.status === 'DRAFT' && can(org.role, 'budgets.manage');
  const mineToApprove = b.status === 'SUBMITTED' && can(org.role, 'approvals.decide');
  const submittedByMe = !!me.data && b.submittedBy?.id === me.data.user.id;
  const cell = (r: BudgetRow): string[] | null => (r.accountId in edits ? edits[r.accountId] : r.amounts);
  const values = (r: BudgetRow) => (cell(r) ?? blank()).map(asDec);
  const rows = d.rows.filter((r) => !onlyBudgeted || !isBlank(cell(r)));
  const monthTotals = (type: BudgetRow['type']) => d.periods.map((_, i) => sum(d.rows.filter((r) => r.type === type).map((r) => values(r)[i])));
  const rev = monthTotals('REVENUE');
  const exp = monthTotals('EXPENSE');
  const net = rev.map((x, i) => x.minus(exp[i]));
  const setCell = (r: BudgetRow, i: number, v: string) => {
    const row = [...(cell(r) ?? blank())];
    row[i] = v;
    setEdits({ ...edits, [r.accountId]: row });
  };
  const section = (title: string, type: BudgetRow['type'], totals: InstanceType<typeof D>[]) => {
    const list = rows.filter((r) => r.type === type);
    return (
      <Fragment key={type}>
        <tr>
          <Td colSpan={14 + (editable ? 1 : 0)} className="sticky left-0 bg-surface-raised/60 text-xs font-semibold uppercase tracking-wide text-fg-muted">
            {title}
          </Td>
        </tr>
        {list.map((r) => {
          const v = values(r);
          const err = issues[r.accountId];
          return (
            <tr key={r.accountId} className={err ? 'bg-negative/5' : r.accountId in edits ? 'bg-accent/5' : undefined}>
              <Td className="sticky left-0 z-10 min-w-56 bg-surface">
                <span className="num text-fg-muted">{r.code}</span> {r.name}
                {!r.isActive ? <Badge tone="neutral" className="ml-1">Inactive</Badge> : null}
                {err ? <div className="text-xs text-negative">{err}</div> : null}
              </Td>
              {d.periods.map((p, i) => (
                <Td key={p.periodNo} numeric className="px-1.5 py-1">
                  {editable ? (
                    <Input
                      aria-label={`${r.code} ${p.label}`}
                      inputMode="decimal"
                      className="num h-8 w-28 px-2 text-right"
                      value={(cell(r) ?? blank())[i]}
                      onChange={(e) => setCell(r, i, e.target.value)}
                    />
                  ) : cell(r) ? (
                    <Money value={cell(r)![i]} currency={c} />
                  ) : (
                    <span className="text-fg-faint">—</span>
                  )}
                </Td>
              ))}
              <Td numeric className="font-semibold">{isBlank(cell(r)) ? <span className="text-fg-faint">—</span> : <Money value={sum(v).toFixed(2)} currency={c} />}</Td>
              {editable ? (
                <Td className="whitespace-nowrap px-2">
                  <Button size="sm" variant="ghost" onClick={() => setSpreading(r)} aria-label={`Spread an annual amount for ${r.code}`}>Spread…</Button>
                  {!isBlank(cell(r)) ? <Button size="sm" variant="ghost" onClick={() => setEdits({ ...edits, [r.accountId]: null })} aria-label={`Clear ${r.code}`}>Clear</Button> : null}
                </Td>
              ) : null}
            </tr>
          );
        })}
        <tr>
          <Td className="sticky left-0 z-10 bg-surface font-semibold">Total {title.toLowerCase()}</Td>
          {totals.map((t, i) => <Td key={i} numeric className="font-semibold"><Money value={t.toFixed(2)} currency={c} /></Td>)}
          <Td numeric className="font-semibold"><Money value={sum(totals).toFixed(2)} currency={c} /></Td>
          {editable ? <Td /> : null}
        </tr>
      </Fragment>
    );
  };

  return (
    <>
      <PageHeader
        title={`FY${b.fiscalYear} budget · v${b.version} ${b.name}`}
        description={`${basisLabel(b, d.source)}. ${d.periods[0].label} – ${d.periods[11].label}. Amounts are in ${c}: revenue as earned, expenses as spent.`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href={`/orgs/${orgId}/planning/budgets?fy=${b.fiscalYear}`} className="self-center text-sm text-fg-muted hover:text-fg">← All versions</Link>
            <Button variant="secondary" onClick={() => router.push(`/orgs/${orgId}/planning/budget-vs-actual?budget=${b.id}`)}>Budget vs actual</Button>
            {can(org.role, 'budgets.manage') ? <Button variant="secondary" loading={copy.isPending} onClick={() => copy.mutate(b)}>New version from this</Button> : null}
          </div>
        }
      />
      <ErrorAlert title="That did not work" error={action.error ?? copy.error} />

      <Card className="mb-4">
        <CardHeader
          title={<span className="flex items-center gap-2">Status <Badge tone={BUDGET_STATUS[b.status].tone}>{BUDGET_STATUS[b.status].label}</Badge></span>}
          description={
            b.status === 'DRAFT'
              ? 'A draft can be changed. Submit it when it is ready; someone other than you approves it.'
              : b.status === 'SUBMITTED'
                ? submittedByMe
                  ? 'You submitted this version, so someone else must approve it. Withdraw it to make changes.'
                  : 'Waiting for approval. Amounts are fixed until it is approved or sent back.'
                : b.status === 'APPROVED'
                  ? 'This is the approved budget for the year. It cannot change; start a new version to revise it.'
                  : 'A later version was approved in its place. Kept for comparison.'
          }
          actions={
            <div className="flex flex-wrap gap-2">
              {editable ? <Button variant="ghost" onClick={() => setDialog('rename')}>Rename</Button> : null}
              {editable ? <Button variant="danger" onClick={() => setDialog('delete')}>Delete draft</Button> : null}
              {editable ? <Button loading={action.isPending} disabled={dirty.length > 0} onClick={() => action.mutate('submit')}>Submit for approval</Button> : null}
              {b.status === 'SUBMITTED' && can(org.role, 'budgets.manage') ? <Button variant="secondary" loading={action.isPending} onClick={() => action.mutate('withdraw')}>Withdraw</Button> : null}
              {mineToApprove && !submittedByMe ? <Button variant="secondary" onClick={() => setDialog('return')}>Send back</Button> : null}
              {mineToApprove && !submittedByMe ? <Button loading={action.isPending} onClick={() => action.mutate('approve')}>Approve</Button> : null}
            </div>
          }
        />
        <ol className="flex flex-wrap gap-x-6 gap-y-1 px-5 pb-4 text-xs text-fg-muted" aria-label="History">
          <li>Created by {b.createdBy?.name} · {time(b.createdAt)}</li>
          {b.returned ? <li className="text-warning">Sent back by {b.returned.by?.name} · {time(b.returned.at)}: “{b.returned.reason}”</li> : null}
          {b.submittedAt ? <li>Submitted by {b.submittedBy?.name} · {time(b.submittedAt)}</li> : null}
          {b.approvedAt ? <li className="text-positive">Approved by {b.approvedBy?.name} · {time(b.approvedAt)}</li> : null}
          {b.supersededAt ? <li>Superseded · {time(b.supersededAt)}</li> : null}
        </ol>
      </Card>

      <Card>
        <CardHeader
          title="Monthly amounts"
          description={`Year: revenue ${money(sum(rev).toFixed(2), c)}, expenses ${money(sum(exp).toFixed(2), c)}, net income ${money(sum(net).toFixed(2), c)}.${editable ? ' Type amounts, or use Spread to split an annual amount; blank cells in a row count as zero.' : ''}`}
          actions={
            <label className="flex items-center gap-2 text-sm text-fg-muted">
              <input type="checkbox" checked={onlyBudgeted} onChange={(e) => setOnlyBudgeted(e.target.checked)} /> Only budgeted accounts
            </label>
          }
        />
        <Table className="min-w-[1500px]">
          <thead>
            <tr>
              <Th className="sticky left-0 z-10 bg-surface">Account</Th>
              {d.periods.map((p) => <Th key={p.periodNo} numeric>{p.label}</Th>)}
              <Th numeric>Year</Th>
              {editable ? <Th /> : null}
            </tr>
          </thead>
          <tbody>
            {section('Revenue', 'REVENUE', rev)}
            {section('Expenses', 'EXPENSE', exp)}
          </tbody>
          <tfoot>
            <tr>
              <Td className="sticky left-0 z-10 bg-surface text-base font-semibold">Net income</Td>
              {net.map((t, i) => <Td key={i} numeric className="whitespace-nowrap font-semibold"><Money value={t.toFixed(2)} currency={c} signed /></Td>)}
              <Td numeric className="whitespace-nowrap text-base font-semibold"><Money value={sum(net).toFixed(2)} currency={c} signed /></Td>
              {editable ? <Td /> : null}
            </tr>
          </tfoot>
        </Table>
        {editable ? (
          <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-3 border-t border-line bg-surface-raised px-5 py-3">
            <ErrorAlert title="Not saved" error={save.error} />
            <span className="text-sm text-fg-muted">{dirty.length ? `${dirty.length} account${dirty.length === 1 ? '' : 's'} changed` : 'No unsaved changes'}</span>
            <Button variant="ghost" disabled={!dirty.length} onClick={() => setEdits({})}>Discard</Button>
            <Button loading={save.isPending} disabled={!dirty.length || Object.keys(issues).length > 0} onClick={() => save.mutate()}>Save changes</Button>
          </div>
        ) : null}
      </Card>

      {spreading ? (
        <SpreadDialog
          row={spreading}
          currency={c}
          current={sum(values(spreading)).toFixed(2)}
          onClose={() => setSpreading(null)}
          onApply={(amounts) => {
            setEdits({ ...edits, [spreading.accountId]: amounts });
            setSpreading(null);
          }}
        />
      ) : null}
      {dialog === 'rename' ? <RenameDialog detail={d} onClose={() => setDialog(null)} onDone={refresh} /> : null}
      {dialog === 'return' ? <ReturnDialog detail={d} onClose={() => setDialog(null)} onDone={refresh} /> : null}
      {dialog === 'delete' ? <DeleteDialog detail={d} onClose={() => setDialog(null)} /> : null}
    </>
  );
}

function SpreadDialog({ row, currency, current, onClose, onApply }: { row: BudgetRow; currency: string; current: string; onClose: () => void; onApply: (amounts: string[]) => void }) {
  const [total, setTotal] = useState(current === '0.00' ? '' : current);
  let preview: string[] | null = null;
  let error: string | undefined;
  try {
    if (total.trim()) preview = spreadEvenly(total.trim().replace(/,/g, ''), 2);
  } catch {
    error = 'An amount such as 1200000 or 1200000.50';
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Spread an annual amount · ${row.code} ${row.name}`} description="The amount is split over the twelve months as evenly as the paisa allow; any remainder goes to the earliest months.">
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (preview) onApply(preview); }}>
        <Field label={`Annual amount (${currency})`} error={error} hint={preview ? `${preview[0]} a month${preview[0] !== preview[11] ? `, ${preview[11]} in the last months` : ''}` : undefined}>
          {(p) => <Input {...p} autoFocus inputMode="decimal" className="num" value={total} onChange={(e) => setTotal(e.target.value)} />}
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!preview}>Spread</Button>
        </div>
      </form>
    </Dialog>
  );
}

function RenameDialog({ detail, onClose, onDone }: { detail: BudgetDetail; onClose: () => void; onDone: (d: BudgetDetail) => Promise<void> }) {
  const { orgId } = useOrg();
  const [name, setName] = useState(detail.budget.name);
  const m = useMutation({
    mutationFn: () => api<BudgetDetail>(`/v1/orgs/${orgId}/budgets/${detail.budget.id}`, { method: 'PATCH', body: { name } }),
    onSuccess: async (d) => {
      await onDone(d);
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Rename version">
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <ErrorAlert title="Not renamed" error={m.error} />
        <Field label="Name">{(p) => <Input {...p} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={m.isPending} disabled={!name.trim()}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}

function ReturnDialog({ detail, onClose, onDone }: { detail: BudgetDetail; onClose: () => void; onDone: (d: BudgetDetail) => Promise<void> }) {
  const { orgId } = useOrg();
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api<BudgetDetail>(`/v1/orgs/${orgId}/budgets/${detail.budget.id}/return`, { method: 'POST', body: { reason } }),
    onSuccess: async (d) => {
      await onDone(d);
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Send back v${detail.budget.version}`} description="The version goes back to draft with your reason, so it can be changed and submitted again.">
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <ErrorAlert title="Not sent back" error={m.error} />
        <Field label="Reason">{(p) => <Input {...p} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={m.isPending} disabled={reason.trim().length < 3}>Send back</Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ detail, onClose }: { detail: BudgetDetail; onClose: () => void }) {
  const { orgId } = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/budgets/${detail.budget.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['budgets', orgId] });
      router.push(`/orgs/${orgId}/planning/budgets?fy=${detail.budget.fiscalYear}`);
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Delete draft v${detail.budget.version}?`} description="Only drafts can be deleted. The deletion is recorded in the audit trail.">
      <ErrorAlert title="Not deleted" error={m.error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="danger" loading={m.isPending} onClick={() => m.mutate()}>Delete</Button>
      </div>
    </Dialog>
  );
}
