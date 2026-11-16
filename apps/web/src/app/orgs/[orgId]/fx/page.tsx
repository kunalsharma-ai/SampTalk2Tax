'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { DateInput } from '@/components/report-bits';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

interface Rate { id: string; currency: string; date: string; rate: string; source: string | null }
interface Exposure {
  asOf: string;
  functionalCurrency: string;
  currencies: { currency: string; rate: string | null; rateDate: string | null; entered: boolean }[];
  lines: { accountId: string; code: string; name: string; currency: string; foreign: string; rate: string; carried: string; revalued: string; adjustment: string }[];
  gain: string;
  missingRates: string[];
  skipped: { accountId: string; code: string; name: string; currency: string; reason: string }[];
  lastRevaluation: { number: number; date: string; reversalDate: string } | null;
}
interface Revaluation { id: string; reference: string; date: string; reversalDate: string; gain: string; journalEntryId: string; journalEntryNumber: number; reversalEntryId: string; reversalEntryNumber: number; rates: Record<string, { rate: string; date: string | null }> }

export default function FxPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [asOf, setAsOf] = useState(today());
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState({ currency: 'USD', date: today(), rate: '', source: '' });
  const rates = useQuery({ queryKey: ['fx-rates', orgId], queryFn: () => api<Rate[]>(`/v1/orgs/${orgId}/fx/rates`) });
  const tried = Object.entries(overrides).filter(([, v]) => v.trim() !== '');
  const exposure = useQuery({
    queryKey: ['fx-exposure', orgId, asOf, tried],
    queryFn: () => api<Exposure>(`/v1/orgs/${orgId}/fx/exposure?asOf=${asOf}${tried.map(([c, v]) => `&rate.${c}=${encodeURIComponent(v)}`).join('')}`),
  });
  const history = useQuery({ queryKey: ['fx-revaluations', orgId], queryFn: () => api<Revaluation[]>(`/v1/orgs/${orgId}/fx/revaluations`) });
  const refresh = () => Promise.all(['fx-rates', 'fx-exposure', 'fx-revaluations'].map((k) => qc.invalidateQueries({ queryKey: [k, orgId] })));
  const addRate = useMutation({
    mutationFn: () => api<Rate>(`/v1/orgs/${orgId}/fx/rates`, { method: 'PUT', body: { currency: draft.currency.trim().toUpperCase(), date: draft.date, rate: draft.rate.trim(), source: draft.source.trim() || null } }),
    onSuccess: async () => { setDraft((d) => ({ ...d, rate: '', source: '' })); await refresh(); },
  });
  const removeRate = useMutation({ mutationFn: (id: string) => api(`/v1/orgs/${orgId}/fx/rates/${id}`, { method: 'DELETE' }), onSuccess: refresh });
  const revalue = useMutation({
    mutationFn: () => api<Revaluation>(`/v1/orgs/${orgId}/fx/revaluations`, { method: 'POST', body: { date: asOf, ...(tried.length ? { rates: Object.fromEntries(tried) } : {}) } }),
    onSuccess: async () => { setOverrides({}); await refresh(); },
  });
  if (!org) return null;
  const ccy = org.functionalCurrency;
  const manage = can(org.role, 'accounts.manage');
  const e = exposure.data;
  const moving = (e?.lines ?? []).some((l) => Number(l.adjustment) !== 0);
  const blocked = !e || e.missingRates.length > 0 || !moving || (!!e.lastRevaluation && asOf <= e.lastRevaluation.date);

  return (
    <>
      <PageHeader
        title="Exchange rates and revaluation"
        description={`Rates are ${ccy} per one unit of the other currency. Journal lines in another currency without a rate use the latest rate on or before their date. At a period end, revaluation restates cash, receivables, payables and loans kept in other currencies at the closing rate and posts the unrealised gain or loss, reversed the next day.`}
      />

      <Card className="mb-6" aria-label="Revaluation">
        <CardHeader title="Revaluation" description="Foreign-currency balances at the date, and what a revaluation would post. Try another rate in the box; it is used only for this revaluation." />
        <div className="flex flex-wrap items-end gap-4 px-5 pt-4">
          <DateInput label="At" value={asOf} onChange={(v) => { setAsOf(v); setOverrides({}); }} />
          {(e?.currencies ?? []).map((c) => (
            <Field key={c.currency} label={`${c.currency} rate`} hint={c.entered ? 'Entered here' : c.rateDate ? `Recorded for ${date(c.rateDate)}` : 'No rate recorded'}>
              {(p) => <Input {...p} className="w-36 num" inputMode="decimal" placeholder={(!c.entered && c.rate) || 'e.g. 84.25'} value={overrides[c.currency] ?? ''} onChange={(ev) => setOverrides((o) => ({ ...o, [c.currency]: ev.target.value }))} />}
            </Field>
          ))}
        </div>
        <div className="px-5 py-4">
          <ErrorAlert title="Could not work out the revaluation" error={exposure.error} />
          {e?.missingRates.length ? <Alert tone="warning" title={`No rate for ${e.missingRates.join(', ')}`}>Record a rate on or before {date(asOf)} below, or enter one above.</Alert> : null}
          {e?.lastRevaluation && asOf <= e.lastRevaluation.date ? <Alert tone="warning" title="Choose a later date">Revaluation {e.lastRevaluation.number} is dated {date(e.lastRevaluation.date)}; a new one must be dated after it.</Alert> : null}
        </div>
        {e && e.lines.length ? (
          <Table>
            <thead><tr><Th>Account</Th><Th>Currency</Th><Th numeric>Balance</Th><Th numeric>Rate</Th><Th numeric>In the books</Th><Th numeric>At the rate</Th><Th numeric>Difference</Th></tr></thead>
            <tbody>
              {e.lines.map((l) => (
                <Tr key={`${l.accountId}:${l.currency}`}>
                  <Td><span className="num text-fg-muted">{l.code}</span> {l.name}</Td>
                  <Td>{l.currency}</Td>
                  <Td numeric><Money value={l.foreign} currency={l.currency} /></Td>
                  <Td numeric className="num">{l.rate}</Td>
                  <Td numeric><Money value={l.carried} currency={ccy} /></Td>
                  <Td numeric><Money value={l.revalued} currency={ccy} /></Td>
                  <Td numeric><Money value={l.adjustment} currency={ccy} signed /></Td>
                </Tr>
              ))}
              <tr className="border-t border-line">
                <Td colSpan={6} className="font-semibold">{Number(e.gain) >= 0 ? 'Unrealised exchange gain' : 'Unrealised exchange loss'}</Td>
                <Td numeric className="font-semibold"><Money value={e.gain} currency={ccy} signed /></Td>
              </tr>
            </tbody>
          </Table>
        ) : e ? (
          <EmptyState title="No foreign-currency balances">Post journals with lines in another currency, such as a USD bank account, and they appear here.</EmptyState>
        ) : null}
        {e?.skipped.length ? <p className="px-5 pt-3 text-sm text-fg-muted">Kept at historical rates (not monetary): {e.skipped.map((s) => `${s.code} ${s.name} (${s.currency})`).join(', ')}.</p> : null}
        <div className="flex flex-wrap items-center justify-end gap-3 px-5 py-4">
          {revalue.data ? <span role="status" className="text-sm text-positive">Posted {revalue.data.reference}: journal {revalue.data.journalEntryNumber}, reversed by {revalue.data.reversalEntryNumber} on {date(revalue.data.reversalDate)}.</span> : null}
          {manage ? <Button disabled={blocked} loading={revalue.isPending} onClick={() => revalue.mutate()}>Post revaluation</Button> : <span className="text-sm text-fg-muted">Accountants, admins and owners can post revaluations.</span>}
        </div>
        <div className="px-5 pb-4"><ErrorAlert title="Not posted" error={revalue.error} /></div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card aria-label="Exchange rates">
          <CardHeader title="Exchange rates" description={`${ccy} per one unit. One rate per currency per day; a rate applies from its date until the next one.`} />
          {manage ? (
            <form className="flex flex-wrap items-end gap-3 px-5 pt-4" onSubmit={(ev) => { ev.preventDefault(); addRate.mutate(); }}>
              <Field label="Currency">{(p) => <Input {...p} className="w-24 uppercase" maxLength={3} value={draft.currency} onChange={(ev) => setDraft({ ...draft, currency: ev.target.value.toUpperCase() })} />}</Field>
              <DateInput label="From" value={draft.date} onChange={(v) => setDraft({ ...draft, date: v })} />
              <Field label="Rate">{(p) => <Input {...p} className="w-32 num" inputMode="decimal" value={draft.rate} onChange={(ev) => setDraft({ ...draft, rate: ev.target.value })} />}</Field>
              <Field label="Source (optional)">{(p) => <Input {...p} className="w-48" placeholder="e.g. RBI reference rate" value={draft.source} onChange={(ev) => setDraft({ ...draft, source: ev.target.value })} />}</Field>
              <Button type="submit" variant="secondary" disabled={!draft.rate.trim() || draft.currency.length !== 3} loading={addRate.isPending}>Save rate</Button>
            </form>
          ) : null}
          <div className="px-5 pt-3"><ErrorAlert title="Rate not saved" error={addRate.error ?? removeRate.error} /></div>
          {rates.data?.length ? (
            <Table>
              <thead><tr><Th>Currency</Th><Th>From</Th><Th numeric>Rate</Th><Th>Source</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
              <tbody>
                {rates.data.map((r) => (
                  <Tr key={r.id}>
                    <Td>{r.currency}</Td>
                    <Td>{date(r.date)}</Td>
                    <Td numeric className="num">{r.rate}</Td>
                    <Td className="text-fg-muted">{r.source ?? '—'}</Td>
                    <Td className="text-right">{manage ? <Button variant="ghost" size="sm" aria-label={`Delete ${r.currency} rate from ${r.date}`} onClick={() => removeRate.mutate(r.id)}>Delete</Button> : null}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          ) : rates.data ? <EmptyState title="No rates yet">Record the rates you use, for example the reference rate at each month end.</EmptyState> : null}
        </Card>

        <Card aria-label="Past revaluations">
          <CardHeader title="Past revaluations" description="Each posts on its date and is reversed the next day. Records cannot be changed." />
          {history.data?.length ? (
            <Table>
              <thead><tr><Th>Reference</Th><Th>Date</Th><Th>Rates</Th><Th numeric>Gain (loss)</Th><Th>Journals</Th></tr></thead>
              <tbody>
                {history.data.map((r) => (
                  <Tr key={r.id}>
                    <Td>{r.reference}</Td>
                    <Td>{date(r.date)}</Td>
                    <Td className="text-sm text-fg-muted">{Object.entries(r.rates).map(([c, v]) => `${c} ${v.rate}`).join(', ')}</Td>
                    <Td numeric><Money value={r.gain} currency={ccy} signed /></Td>
                    <Td className="text-sm">
                      <Link className="underline" href={`/orgs/${orgId}/journals/${r.journalEntryId}`}>#{r.journalEntryNumber}</Link>{' '}
                      <Badge tone="neutral">reversed</Badge>{' '}
                      <Link className="underline" href={`/orgs/${orgId}/journals/${r.reversalEntryId}`}>#{r.reversalEntryNumber}</Link>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          ) : history.data ? <EmptyState title="No revaluations yet">They appear here once posted.</EmptyState> : null}
        </Card>
      </div>
    </>
  );
}
