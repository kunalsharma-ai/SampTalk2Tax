'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  checkTemplateLines,
  fillPlaceholders,
  RECURRING_FREQUENCIES,
  RECURRING_FREQUENCY_LABEL,
  runCount,
  TEMPLATE_PLACEHOLDERS,
  upcomingRuns,
  type RecurringFrequency,
} from '@talk2tax/accounting-engine';
import { Alert, Button, Card, CardHeader, Input, Select, Table, Td, Th, Textarea, cn } from '@talk2tax/ui';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { LineDimensions } from '@/components/dimensions/line-dimensions';
import { api, ApiError } from '@/lib/api';
import { useDimensions } from '@/lib/dimensions';
import { date as fmtDate, money, today } from '@/lib/format';
import type { TemplateDetail } from '@/lib/journal-templates';
import { useAccounts, useOrg } from '@/lib/org';
import { can } from '@/lib/types';

interface LineState {
  key: number;
  accountId: string;
  debit: string;
  credit: string;
  currency: string;
  description: string;
  departmentId: string;
  projectId: string;
}

const AMOUNT = /^\d{0,18}(\.\d{0,6})?$/;
const label = 'flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted';

/** Create or edit a journal template, with an optional schedule. Checks use the same engine rules as the server. */
export function TemplateForm({ existing }: { existing?: TemplateDetail }) {
  const { org, orgId } = useOrg();
  const accounts = useAccounts();
  const dims = useDimensions();
  const router = useRouter();
  const qc = useQueryClient();
  const c = org?.functionalCurrency ?? 'INR';
  const nextKey = useRef(3);
  const blank = (key: number): LineState => ({ key, accountId: '', debit: '', credit: '', currency: c, description: '', departmentId: '', projectId: '' });

  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [journalType, setJournalType] = useState<'STANDARD' | 'ADJUSTING'>(existing?.journalType ?? 'STANDARD');
  const [memo, setMemo] = useState(existing?.memo ?? '');
  const [reference, setReference] = useState(existing?.journalReference ?? '');
  const [showFx, setShowFx] = useState(existing ? existing.lines.some((l) => l.currency !== c) : false);
  const [lines, setLines] = useState<LineState[]>(
    existing
      ? existing.lines.map((l, i) => ({ key: i + 1, accountId: l.accountId, debit: l.debit ?? '', credit: l.credit ?? '', currency: l.currency, description: l.description ?? '', departmentId: l.departmentId ?? '', projectId: l.projectId ?? '' }))
      : [blank(1), blank(2)],
  );
  const ex = existing?.schedule;
  const [scheduled, setScheduled] = useState(!!ex);
  const [frequency, setFrequency] = useState<RecurringFrequency>(ex?.frequency ?? 'MONTHLY');
  const [startDate, setStartDate] = useState(ex?.startDate ?? today());
  const [endDate, setEndDate] = useState(ex?.endDate ?? '');
  const [monthEnd, setMonthEnd] = useState(ex?.monthEnd ?? true);
  const [postMode, setPostMode] = useState<'DRAFT' | 'POST'>(ex?.postMode ?? 'DRAFT');
  const ran = !!ex && ex.nextRunNo > 1;
  if (existing && nextKey.current < existing.lines.length + 1) nextKey.current = existing.lines.length + 1;

  const postable = useMemo(
    () => (accounts.data ?? []).filter((a) => a.isPostable && a.isActive && a.id !== org?.arAccountId && a.id !== org?.apAccountId && a.id !== org?.claimsAccountId),
    [accounts.data, org?.arAccountId, org?.apAccountId, org?.claimsAccountId],
  );
  const filled = lines.filter((l) => l.accountId || l.debit || l.credit);
  const payloadLines = filled.map((l) => ({
    accountId: l.accountId,
    debit: l.debit || null,
    credit: l.credit || null,
    currency: l.currency !== c ? l.currency : null,
    description: l.description || null,
    departmentId: l.departmentId || null,
    projectId: l.projectId || null,
  }));
  const check = useMemo(() => {
    const r = checkTemplateLines(payloadLines, c);
    const issues = [...r.issues];
    payloadLines.forEach((l, i) => !l.accountId && issues.push(`Line ${i + 1}: choose an account`));
    return { ...r, issues };
  }, [payloadLines, c]);
  const own = check.totals.find((t) => t.currency === c) ?? { debit: '0', credit: '0' };

  const fy = org?.fiscalYearStartMonth ?? 4;
  const sched = useMemo(() => {
    if (!scheduled) return null;
    try {
      const s = { start: startDate, end: endDate || null, frequency, monthEnd, nextNo: ex?.nextRunNo ?? 1 };
      return { ok: true as const, count: runCount(s), next: upcomingRuns(s, 3) };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, [scheduled, startDate, endDate, frequency, monthEnd, ex?.nextRunNo]);
  const dueAtOnce = sched?.ok ? sched.next.filter((r) => r.date <= today()).length : 0;

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        description: description || null,
        journalType,
        memo: memo || null,
        reference: reference || null,
        lines: payloadLines,
        schedule: scheduled ? { frequency, startDate, endDate: endDate || null, monthEnd, postMode } : null,
      };
      return existing
        ? api<TemplateDetail>(`/v1/orgs/${orgId}/journal-templates/${existing.id}`, { method: 'PUT', body })
        : api<TemplateDetail>(`/v1/orgs/${orgId}/journal-templates`, { method: 'POST', body });
    },
    onSuccess: async (t) => {
      await qc.invalidateQueries({ queryKey: ['journal-templates', orgId] });
      await qc.invalidateQueries({ queryKey: ['journal-template', orgId] });
      router.push(`/orgs/${orgId}/journal-templates/${t.id}`);
    },
  });
  const update = (key: number, patch: Partial<LineState>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const amountChange = (key: number, side: 'debit' | 'credit', v: string) => {
    if (!AMOUNT.test(v)) return;
    update(key, side === 'debit' ? (v ? { debit: v, credit: '' } : { debit: v }) : v ? { credit: v, debit: '' } : { credit: v });
  };
  const serverIssues = save.error instanceof ApiError ? save.error.issues : [];
  const ok = !!name.trim() && check.issues.length === 0 && (!sched || sched.ok);

  if (!org) return null;
  const sample = sched?.ok && sched.next[0] ? sched.next[0].date : today();
  return (
    <form onSubmit={(e) => e.preventDefault()} className="flex flex-col gap-6">
      <Card>
        <CardHeader title="Template" description="What the template is for, and the memo and reference each journal it makes will carry." />
        <div className="grid gap-4 p-5 sm:grid-cols-4">
          <label className={cn(label, 'sm:col-span-2')}>
            Name
            <Input value={name} maxLength={120} placeholder="e.g. Office rent accrual" onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className={label}>
            Journal type
            <Select value={journalType} onChange={(e) => setJournalType(e.target.value as 'STANDARD' | 'ADJUSTING')}>
              <option value="STANDARD">Standard</option>
              <option value="ADJUSTING">Adjusting</option>
            </Select>
          </label>
          <label className={label}>
            Reference
            <Input value={reference} maxLength={100} placeholder={existing?.reference ?? 'e.g. RENT-{period}'} onChange={(e) => setReference(e.target.value)} />
          </label>
          <label className={cn(label, 'sm:col-span-2')}>
            Memo
            <Input value={memo} maxLength={1000} placeholder="e.g. Rent for {month}" onChange={(e) => setMemo(e.target.value)} />
          </label>
          <label className={cn(label, 'sm:col-span-2')}>
            Description (for your team)
            <Textarea rows={1} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className="text-xs text-fg-muted sm:col-span-4">
            <p>
              Placeholders become the journal&apos;s own dates:{' '}
              {TEMPLATE_PLACEHOLDERS.map((p, i) => (
                <span key={p.key}>
                  {i ? ', ' : ''}
                  <code className="rounded bg-surface-sunken px-1 text-fg">{p.key}</code> {p.meaning.toLowerCase()}
                </span>
              ))}
              .
            </p>
            {memo || reference ? (
              <p className="mt-1" aria-live="polite">
                On {fmtDate(sample)} this reads: <span className="text-fg">{memo ? fillPlaceholders(memo, sample, fy) : '(no memo)'}</span>
                {reference ? <> · ref <span className="text-fg">{fillPlaceholders(reference, sample, fy)}</span></> : null}
              </p>
            ) : null}
          </div>
          <label className="flex items-center gap-2 text-sm text-fg-muted sm:col-span-4">
            <input type="checkbox" checked={showFx} onChange={(e) => setShowFx(e.target.checked)} className="accent-[var(--t2t-accent)]" />
            Some lines are in a foreign currency (converted at the rate recorded for each journal&apos;s date)
          </label>
        </div>
      </Card>

      <Card>
        <CardHeader title="Lines" description={`Amounts in ${c} unless a line says otherwise. Each line is either a debit or a credit.`} />
        <Table>
          <thead>
            <tr>
              <Th className="w-[34%]">Account</Th>
              <Th>Description</Th>
              {showFx ? <Th>Currency</Th> : null}
              <Th numeric>Debit</Th>
              <Th numeric>Credit</Th>
              <Th><span className="sr-only">Remove</span></Th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, idx) => (
              <tr key={l.key} className="align-top">
                <Td>
                  <label className="sr-only" htmlFor={`tacc-${l.key}`}>Account for line {idx + 1}</label>
                  <Select id={`tacc-${l.key}`} value={l.accountId} onChange={(e) => update(l.key, { accountId: e.target.value })}>
                    <option value="">Select account…</option>
                    {postable.map((a) => (
                      <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                    ))}
                  </Select>
                  <LineDimensions values={dims.data?.values} line={idx + 1} departmentId={l.departmentId} projectId={l.projectId} onChange={(p) => update(l.key, p)} />
                </Td>
                <Td>
                  <Input aria-label={`Description for line ${idx + 1}`} value={l.description} maxLength={500} placeholder="Optional; placeholders work here too" onChange={(e) => update(l.key, { description: e.target.value })} />
                </Td>
                {showFx ? (
                  <Td>
                    <Select aria-label={`Currency for line ${idx + 1}`} className="w-24" value={l.currency} onChange={(e) => update(l.key, { currency: e.target.value })}>
                      {[c, ...['USD', 'EUR', 'GBP', 'AED', 'SGD', 'INR'].filter((x) => x !== c)].map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </Select>
                  </Td>
                ) : null}
                <Td numeric>
                  <Input aria-label={`Debit for line ${idx + 1}`} className="text-right num" inputMode="decimal" value={l.debit} placeholder="0.00" onChange={(e) => amountChange(l.key, 'debit', e.target.value)} />
                </Td>
                <Td numeric>
                  <Input aria-label={`Credit for line ${idx + 1}`} className="text-right num" inputMode="decimal" value={l.credit} placeholder="0.00" onChange={(e) => amountChange(l.key, 'credit', e.target.value)} />
                </Td>
                <Td>
                  <Button type="button" variant="ghost" size="sm" aria-label={`Remove line ${idx + 1}`} disabled={lines.length <= 2} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>✕</Button>
                </Td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <Td colSpan={showFx ? 3 : 2}>
                <Button type="button" variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, blank(nextKey.current++)])}>+ Add line</Button>
              </Td>
              <Td numeric className="font-semibold">{money(own.debit, c)}</Td>
              <Td numeric className="font-semibold">{money(own.credit, c)}</Td>
              <Td />
            </tr>
          </tfoot>
        </Table>
        <div className={cn('border-t border-line px-5 py-4 text-sm', check.issues.length ? 'text-fg-muted' : 'text-positive')} aria-live="polite">
          {filled.length === 0 ? (
            <span>Add the accounts and amounts the journal posts.</span>
          ) : check.issues.length === 0 ? (
            <span>✓ Balanced: debits equal credits{check.totals.length > 1 ? ' in each currency' : ` (${money(own.debit, c)})`}</span>
          ) : (
            <ul className="list-inside list-disc text-warning">
              {check.issues.slice(0, 4).map((i) => <li key={i}>{i}</li>)}
            </ul>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Schedule" description="Leave it off to use the template by hand. With a schedule, each run that falls due becomes a journal automatically." />
        <div className="grid gap-4 p-5 sm:grid-cols-4">
          <label className="flex items-center gap-2 text-sm sm:col-span-4">
            <input type="checkbox" checked={scheduled} disabled={ran} onChange={(e) => setScheduled(e.target.checked)} className="accent-[var(--t2t-accent)]" />
            Make this journal on a schedule (a recurring journal)
          </label>
          {scheduled ? (
            <>
              <label className={label}>
                Every
                <Select value={frequency} disabled={ran} onChange={(e) => setFrequency(e.target.value as RecurringFrequency)}>
                  {RECURRING_FREQUENCIES.map((f) => <option key={f} value={f}>{RECURRING_FREQUENCY_LABEL[f]}</option>)}
                </Select>
              </label>
              <label className={label}>
                First run
                <Input type="date" value={startDate} disabled={ran} onChange={(e) => setStartDate(e.target.value)} />
              </label>
              <label className={label}>
                Last date (optional)
                <Input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
              </label>
              <label className="flex items-center gap-2 self-end pb-2 text-sm text-fg-muted">
                <input type="checkbox" checked={monthEnd} disabled={ran} onChange={(e) => setMonthEnd(e.target.checked)} className="accent-[var(--t2t-accent)]" />
                On the month&apos;s last day
              </label>
              <fieldset className="sm:col-span-4">
                <legend className="text-xs font-medium uppercase tracking-wide text-fg-muted">Each run</legend>
                <div className="mt-2 flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input type="radio" name="postMode" checked={postMode === 'DRAFT'} onChange={() => setPostMode('DRAFT')} className="accent-[var(--t2t-accent)]" />
                    Makes a draft for someone to check and post
                  </label>
                  <label className={cn('flex items-center gap-2', !can(org.role, 'journals.post') && 'opacity-50')}>
                    <input type="radio" name="postMode" checked={postMode === 'POST'} disabled={!can(org.role, 'journals.post')} onChange={() => setPostMode('POST')} className="accent-[var(--t2t-accent)]" />
                    Posts the journal straight away{!can(org.role, 'journals.post') ? ' (needs permission to post)' : ''}
                  </label>
                </div>
              </fieldset>
              <div className="text-sm sm:col-span-4" aria-live="polite">
                {ran ? <p className="mb-1 text-xs text-fg-muted">This schedule has made journals, so its first run, frequency and run day stay as they are.</p> : null}
                {sched && !sched.ok ? (
                  <p className="text-warning">{sched.error}</p>
                ) : sched?.ok ? (
                  <p className="text-fg-muted">
                    {sched.count ? `${sched.count} run${sched.count === 1 ? '' : 's'} in all. ` : 'Runs until you end it. '}
                    Next: {sched.next.map((r) => fmtDate(r.date)).join(', ') || 'none left before the last date'}.
                    {dueAtOnce ? <span className="text-warning"> {dueAtOnce === 3 ? 'At least 3 runs' : `${dueAtOnce} run${dueAtOnce === 1 ? '' : 's'}`} already fell due. They are made at the next hourly check, or straight away with Run due now on the template.</span> : null}
                  </p>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </Card>

      {save.error ? (
        <Alert title="The template was not saved">
          {save.error.message}
          {serverIssues.length ? <ul className="mt-1 list-inside list-disc">{serverIssues.map((i) => <li key={i}>{i}</li>)}</ul> : null}
        </Alert>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button>
        <Button type="button" loading={save.isPending} disabled={!ok || save.isPending} onClick={() => save.mutate()}>
          {existing ? 'Save changes' : 'Save template'}
        </Button>
      </div>
    </form>
  );
}
