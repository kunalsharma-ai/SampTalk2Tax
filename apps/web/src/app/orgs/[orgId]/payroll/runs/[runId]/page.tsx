'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Select, Stat, Table, Td, Th } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date, money, today } from '@/lib/format';
import { useAccounts, useOrg } from '@/lib/org';
import { LIABILITY_HINT, monthLabel } from '@/lib/payroll';
import { can, type PayComponentKind, type PayRun, type PayrollLiability } from '@/lib/types';

type Slip = PayRun['payslips'][number];
const AMT = /^\d{0,13}(\.\d{0,2})?$/;

function ErrorAlert({ title, error }: { title: string; error: Error | null }) {
  if (!error) return null;
  return <Alert title={title}>{error.message}{error instanceof ApiError && error.issues.length ? <ul className="mt-1 list-inside list-disc">{error.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}</Alert>;
}

export default function PayRunPage() {
  const { org, orgId } = useOrg();
  const { runId } = useParams<{ runId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const key = ['pay-run', orgId, runId];
  const run = useQuery({ queryKey: key, queryFn: () => api<PayRun>(`/v1/orgs/${orgId}/payroll/runs/${runId}`) });
  const refresh = async (r?: PayRun) => {
    if (r) qc.setQueryData(key, r);
    await qc.invalidateQueries({ queryKey: ['pay-runs', orgId] });
  };
  const recalc = useMutation({ mutationFn: () => api<PayRun>(`/v1/orgs/${orgId}/payroll/runs/${runId}/recalculate`, { method: 'POST', body: {} }), onSuccess: refresh });
  const post = useMutation({ mutationFn: () => api<PayRun>(`/v1/orgs/${orgId}/payroll/runs/${runId}/post`, { method: 'POST' }), onSuccess: refresh });
  const del = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/payroll/runs/${runId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['pay-runs', orgId] });
      router.push(`/orgs/${orgId}/payroll/runs`);
    },
  });
  const [adjusting, setAdjusting] = useState<Slip | null>(null);
  const [paying, setPaying] = useState<PayrollLiability | null>(null);
  const [voidingRun, setVoidingRun] = useState(false);
  const [voidingPayment, setVoidingPayment] = useState<{ id: string; number: string } | null>(null);
  if (!org || !run.data) return run.error ? <Alert title="Could not load the pay run">{run.error.message}</Alert> : null;
  const r = run.data;
  const t = r.totals;
  const canManage = can(org.role, 'payroll.manage');
  const canPost = canManage && can(org.role, 'journals.post');
  const canReverse = canManage && can(org.role, 'journals.reverse');
  const draft = r.status === 'DRAFT';
  const mutError = recalc.error ?? post.error ?? del.error;

  return (
    <>
      <PageHeader
        title={`${r.number} · ${monthLabel(r.period)}`}
        description={
          <>
            {r.status === 'DRAFT' ? <Badge tone="warning">Draft</Badge> : r.status === 'POSTED' ? <Badge tone="positive">Posted</Badge> : <Badge>Void</Badge>} Pay date {date(r.payDate)}
            {r.journalEntryId ? <> · <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${r.journalEntryId}`}>Journal</Link></> : null}
            {r.voidReason ? ` · voided ${date(r.voidDate!)}: ${r.voidReason}` : ''}
          </>
        }
        actions={
          <>
            {draft && canManage ? <Button variant="ghost" loading={del.isPending} onClick={() => del.mutate()}>Delete draft</Button> : null}
            {draft && canManage ? <Button variant="secondary" loading={recalc.isPending} onClick={() => recalc.mutate()}>Recalculate</Button> : null}
            {draft && canPost ? <Button loading={post.isPending} disabled={!r.payslips.length} onClick={() => post.mutate()}>Post pay run</Button> : null}
            {r.status === 'POSTED' && canReverse ? <Button variant="ghost" onClick={() => setVoidingRun(true)}>Void pay run</Button> : null}
          </>
        }
      />
      <div className="flex flex-col gap-6">
        <ErrorAlert title="That did not work" error={mutError} />
        {draft ? <Alert tone="accent" title="Draft">Nothing is in the ledger yet. Adjust loss-of-pay days or add one-off earnings per employee, then post. Posting checks every payslip again against the latest salaries and earlier months.</Alert> : null}
        {r.missing.length ? <Alert tone="warning" title={`${r.missing.length} employee${r.missing.length === 1 ? ' is' : 's are'} not in this pay run`}>{r.missing.map((m) => `${m.name} (${m.code}): ${m.reason}`).join('; ')}. Add a salary on the employee page, then recalculate.</Alert> : null}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Gross pay" value={<Money value={t.gross} currency="INR" />} sub={`${r.payslips.length} employee${r.payslips.length === 1 ? '' : 's'}`} />
          <Stat label="Deductions" value={<Money value={t.deductions} currency="INR" />} sub="PF, ESI, professional tax and TDS" />
          <Stat label="Net pay" value={<Money value={t.net} currency="INR" />} tone="positive" sub="Paid to employees" />
          <Stat label="Cost to employer" value={<Money value={t.employerCost} currency="INR" />} sub="Gross plus employer PF and ESI" />
        </div>

        <Card>
          <CardHeader title="Payslips" description="Pro-rated for days employed and loss of pay. Open one for the full payslip." />
          <div className="overflow-x-auto">
            <Table className="min-w-[1100px]">
              <thead><tr><Th>Employee</Th><Th numeric>Paid days</Th><Th numeric>Gross</Th><Th numeric>PF</Th><Th numeric>ESI</Th><Th numeric>Prof. tax</Th><Th numeric>TDS</Th><Th numeric>Net pay</Th><Th numeric>Employer cost</Th><Th /></tr></thead>
              <tbody>
                {r.payslips.map((s) => (
                  <tr key={s.id}>
                    <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/payroll/runs/${r.id}/payslips/${s.employee.id}`}>{s.employee.name}</Link><span className="block num text-xs text-fg-muted">{s.employee.code}</span></Td>
                    <Td numeric className="whitespace-nowrap">{s.paidDays.replace(/\.0$/, '')}/{s.daysInMonth}{Number(s.lopDays) ? <span className="block text-xs text-warning">{s.lopDays.replace(/\.0$/, '')} LOP</span> : null}</Td>
                    <Td numeric><Money value={s.gross} currency="INR" />{s.oneOffs.length ? <span className="block text-xs text-fg-muted">incl. one-off</span> : null}</Td>
                    <Td numeric><Money value={s.pf.employee} currency="INR" /></Td>
                    <Td numeric>{s.esi.covered ? <Money value={s.esi.employee} currency="INR" /> : <span className="text-xs text-fg-faint">Not covered</span>}</Td>
                    <Td numeric><Money value={s.pt.amount} currency="INR" /></Td>
                    <Td numeric><Money value={s.tds.amount} currency="INR" /></Td>
                    <Td numeric className="font-semibold"><Money value={s.net} currency="INR" /></Td>
                    <Td numeric><Money value={s.employerCost} currency="INR" /></Td>
                    <Td className="text-right">{draft && canManage ? <Button size="sm" variant="ghost" aria-label={`Adjust ${s.employee.name}`} onClick={() => setAdjusting(s)}>Adjust</Button> : null}</Td>
                  </tr>
                ))}
                {r.payslips.length === 0 ? <tr><Td colSpan={10} className="py-6 text-center text-fg-muted">No one with a salary was employed in {monthLabel(r.period)}.</Td></tr> : null}
              </tbody>
              {r.payslips.length ? (
                <tfoot>
                  <tr className="font-semibold">
                    <Td>Total</Td><Td /><Td numeric><Money value={t.gross} currency="INR" /></Td><Td numeric><Money value={t.pfEmployee} currency="INR" /></Td><Td numeric><Money value={t.esiEmployee} currency="INR" /></Td>
                    <Td numeric><Money value={t.pt} currency="INR" /></Td><Td numeric><Money value={t.tds} currency="INR" /></Td><Td numeric><Money value={t.net} currency="INR" /></Td><Td numeric><Money value={t.employerCost} currency="INR" /></Td><Td />
                  </tr>
                </tfoot>
              ) : null}
            </Table>
          </div>
        </Card>

        <Card>
          <CardHeader title="To pay" description={r.status === 'POSTED' ? 'What this pay run owes, when it is due, and what has been paid. Recording a payment posts Dr the liability, Cr the bank.' : 'What this pay run will owe once posted.'} />
          <div className="overflow-x-auto">
            <Table className="min-w-[860px]">
              <thead><tr><Th>Liability</Th><Th>Paid through</Th><Th numeric>Amount</Th><Th>Due</Th><Th>Payment</Th><Th /></tr></thead>
              <tbody>
                {r.liabilities.map((l) => {
                  const overdue = r.status === 'POSTED' && !l.payment && Number(l.amount) > 0 && l.dueDate < today();
                  return (
                    <tr key={l.liability}>
                      <Td className="font-medium">{l.label}{l.liability === 'PF' ? <span className="block text-xs font-normal text-fg-muted">Employee <span className="num">{money(t.pfEmployee, 'INR')}</span> · employer <span className="num">{money(t.pfEmployer, 'INR')}</span> · EDLI and admin <span className="num">{money((Number(t.edli) + Number(t.pfAdmin)).toFixed(2), 'INR')}</span></span> : l.liability === 'ESI' && Number(l.amount) ? <span className="block text-xs font-normal text-fg-muted">Employee <span className="num">{money(t.esiEmployee, 'INR')}</span> · employer <span className="num">{money(t.esiEmployer, 'INR')}</span></span> : null}</Td>
                      <Td className="text-sm text-fg-muted">{LIABILITY_HINT[l.liability]}</Td>
                      <Td numeric><Money value={l.amount} currency="INR" /></Td>
                      <Td className="whitespace-nowrap">{date(l.dueDate)}{overdue ? <Badge tone="negative" className="ml-1">Overdue</Badge> : null}</Td>
                      <Td className="text-sm">{l.payment ? <><Link className="num text-accent hover:underline" href={`/orgs/${orgId}/journals/${l.payment.journalEntryId}`}>{l.payment.number}</Link> · {date(l.payment.date)} · {l.payment.reference}</> : Number(l.amount) ? <span className="text-fg-muted">{r.status === 'POSTED' ? 'Not paid' : '—'}</span> : <span className="text-fg-faint">Nothing due</span>}</Td>
                      <Td className="text-right whitespace-nowrap">
                        {r.status === 'POSTED' && canPost && !l.payment && Number(l.amount) > 0 ? <Button size="sm" variant="secondary" aria-label={`Pay ${l.label}`} onClick={() => setPaying(l.liability)}>Record payment</Button> : null}
                        {r.status === 'POSTED' && canReverse && l.payment ? <Button size="sm" variant="ghost" aria-label={`Void ${l.payment.number}`} onClick={() => setVoidingPayment(l.payment)}>Void</Button> : null}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        </Card>
        <p className="text-sm text-fg-muted"><Link className="text-accent hover:underline" href={`/orgs/${orgId}/payroll/runs`}>← All pay runs</Link></p>
      </div>

      {adjusting ? <AdjustDialog run={r} slip={adjusting} onClose={(next) => { if (next) qc.setQueryData(key, next); setAdjusting(null); }} /> : null}
      {paying ? <PayDialog run={r} liability={paying} onClose={(next) => { if (next) void refresh(next); setPaying(null); }} /> : null}
      <VoidDialog
        open={voidingRun}
        title={`Void ${r.number}`}
        description="Posts a reversal of the pay run's journal dated today. Payments recorded against it must be voided first, and so must any later posted month."
        action="Void pay run"
        url={`/v1/orgs/${orgId}/payroll/runs/${r.id}/void`}
        onClose={(next) => { if (next) void refresh(next); setVoidingRun(false); }}
      />
      <VoidDialog
        open={!!voidingPayment}
        title={`Void ${voidingPayment?.number ?? ''}`}
        description="Posts a reversal dated today; the liability shows as unpaid again."
        action="Void payment"
        url={`/v1/orgs/${orgId}/payroll/runs/${r.id}/payments/${voidingPayment?.id}/void`}
        onClose={(next) => { if (next) void refresh(next); setVoidingPayment(null); }}
      />
    </>
  );
}

function AdjustDialog({ run, slip, onClose }: { run: PayRun; slip: Slip; onClose: (next?: PayRun) => void }) {
  const { orgId } = useOrg();
  const [lop, setLop] = useState(slip.lopDays.replace(/\.0$/, ''));
  const [oneOffs, setOneOffs] = useState(slip.oneOffs.map((o) => ({ ...o, amount: o.amount.replace(/\.00$/, '') })));
  const save = useMutation({
    mutationFn: () => api<PayRun>(`/v1/orgs/${orgId}/payroll/runs/${run.id}/payslips/${slip.employee.id}`, { method: 'PUT', body: { lopDays: lop || '0', oneOffs: oneOffs.filter((o) => o.name.trim() && o.amount) } }),
    onSuccess: (r) => onClose(r),
  });
  const employed = slip.daysInMonth - Number(slip.daysOutside);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Adjust ${slip.employee.name}`} description={`${monthLabel(run.period)}: employed ${employed} of ${slip.daysInMonth} days.`}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Loss-of-pay days" hint="Whole or half days not paid for.">{(p) => <Input {...p} className="num" inputMode="decimal" value={lop} onChange={(e) => /^\d{0,2}(\.5?)?$/.test(e.target.value) && setLop(e.target.value)} />}</Field>
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">One-off earnings this month</p>
          {oneOffs.map((o, i) => (
            <div key={i} className="mb-2 grid grid-cols-[1fr_10rem_8rem_2rem] gap-2">
              <Input aria-label={`One-off ${i + 1} name`} value={o.name} maxLength={100} placeholder="e.g. Diwali bonus" onChange={(e) => setOneOffs(oneOffs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <Select aria-label={`One-off ${i + 1} PF and ESI treatment`} value={o.kind} onChange={(e) => setOneOffs(oneOffs.map((x, j) => (j === i ? { ...x, kind: e.target.value as PayComponentKind } : x)))}>
                <option value="EXCLUDED">Excluded (bonus, overtime)</option>
                <option value="WAGES">Counts as wages</option>
              </Select>
              <Input aria-label={`One-off ${i + 1} amount`} className="num text-right" inputMode="decimal" value={o.amount} onChange={(e) => AMT.test(e.target.value) && setOneOffs(oneOffs.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
              <button type="button" aria-label={`Remove one-off ${i + 1}`} className="text-fg-faint hover:text-negative" onClick={() => setOneOffs(oneOffs.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <Button type="button" size="sm" variant="secondary" onClick={() => setOneOffs([...oneOffs, { name: '', kind: 'EXCLUDED', amount: '' }])}>+ Add one-off earning</Button>
        </div>
        <ErrorAlert title="Not saved" error={save.error} />
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => onClose()}>Cancel</Button><Button type="submit" loading={save.isPending}>Recalculate payslip</Button></div>
      </form>
    </Dialog>
  );
}

function PayDialog({ run, liability, onClose }: { run: PayRun; liability: PayrollLiability; onClose: (next?: PayRun) => void }) {
  const { org, orgId } = useOrg();
  const accounts = useAccounts();
  const l = run.liabilities.find((x) => x.liability === liability)!;
  const [form, setForm] = useState({ date: liability === 'NET_PAY' ? run.payDate : today(), bankAccountId: '', reference: '' });
  const save = useMutation({
    mutationFn: () => api<PayRun>(`/v1/orgs/${orgId}/payroll/runs/${run.id}/payments`, { method: 'POST', body: { liability, ...form } }),
    onSuccess: (r) => onClose(r),
  });
  if (!org) return null;
  const banks = (accounts.data ?? []).filter((a) => a.isPostable && a.isActive && (a.subtype === 'BANK' || a.subtype === 'CASH'));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Pay ${l.label.toLowerCase()}`} description={`${money(l.amount, 'INR')} for ${monthLabel(run.period)}, due ${date(l.dueDate)}. ${LIABILITY_HINT[liability]}.`}>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Paid on">{(p) => <Input {...p} type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />}</Field>
        <Field label="Paid from">{(p) => <Select {...p} value={form.bankAccountId} onChange={(e) => setForm({ ...form, bankAccountId: e.target.value })}><option value="">Choose a bank account…</option>{banks.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select>}</Field>
        <div className="sm:col-span-2"><Field label="Reference" hint={liability === 'NET_PAY' ? 'For example the bank batch or NEFT reference.' : liability === 'PF' ? 'For example the ECR TRRN.' : 'For example the challan number.'}>{(p) => <Input {...p} value={form.reference} maxLength={100} onChange={(e) => setForm({ ...form, reference: e.target.value })} />}</Field></div>
        <div className="sm:col-span-2"><ErrorAlert title="Not recorded" error={save.error} /></div>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="ghost" onClick={() => onClose()}>Cancel</Button><Button type="submit" loading={save.isPending} disabled={!form.bankAccountId || !form.reference.trim()}>Record payment</Button></div>
      </form>
    </Dialog>
  );
}

function VoidDialog({ open, title, description, action, url, onClose }: { open: boolean; title: string; description: string; action: string; url: string; onClose: (next?: PayRun) => void }) {
  const [reason, setReason] = useState('');
  const v = useMutation({ mutationFn: () => api<PayRun>(url, { method: 'POST', body: { reason } }), onSuccess: (r) => { setReason(''); onClose(r); } });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={title} description={description}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); v.mutate(); }}>
        <Field label="Reason">{(p) => <Input {...p} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}</Field>
        <ErrorAlert title="Not voided" error={v.error} />
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => onClose()}>Cancel</Button><Button type="submit" variant="danger" loading={v.isPending} disabled={reason.trim().length < 3}>{action}</Button></div>
      </form>
    </Dialog>
  );
}
