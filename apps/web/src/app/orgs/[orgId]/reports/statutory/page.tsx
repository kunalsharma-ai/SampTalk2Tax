'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Select, Table, Td, Th } from '@talk2tax/ui';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { DateInput, fyStartFor } from '@/components/report-bits';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Row {
  key: string;
  label: string;
  kind: 'HEADING' | 'LINE' | 'TOTAL';
  level: number;
  note: string | null;
  amount: string | null;
  previous: string | null;
  accounts: { accountId: string; code: string; name: string; amount: string }[];
}
interface Statements {
  organisation: { name: string; legalName: string | null; countryCode: string };
  currency: string;
  format: { id: string; name: string; basis: string; balanceSheetTitle: string; profitAndLossTitle: string; sources: { title: string; url: string }[]; notIncluded: string[]; isCountryDefault: boolean };
  from: string;
  to: string;
  previous: { from: string; to: string } | null;
  balanceSheet: Row[];
  profitAndLoss: Row[];
  checks: { balanced: boolean; profitAgrees: boolean; netProfit: string };
  unclassified: { accountId: string; code: string; name: string; type: string; subtype: string | null; placedOn: string }[];
}
interface Formats { default: string; formats: { id: string; name: string }[] }

export default function StatutoryStatementsPage() {
  const { org, orgId } = useOrg();
  const [to, setTo] = useState(today());
  const [from, setFrom] = useState(() => fyStartFor(today(), org?.fiscalYearStartMonth ?? 4));
  const [format, setFormat] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const formats = useQuery({ queryKey: ['statutory-formats', orgId], queryFn: () => api<Formats>(`/v1/orgs/${orgId}/reports/statutory/formats`) });
  const chosen = format || formats.data?.default || '';
  const q = useQuery({
    queryKey: ['statutory', orgId, chosen, from, to],
    queryFn: () => api<Statements>(`/v1/orgs/${orgId}/reports/statutory?from=${from}&to=${to}&format=${chosen}`),
    enabled: !!chosen && from <= to,
  });
  if (!org) return null;
  const s = q.data;
  const toggle = (k: string) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const statement = (id: string, title: string, sub: string, rows: Row[], heads: [string, string]) => (
    <Card className="mb-6 break-inside-avoid" aria-label={title}>
      <CardHeader title={title} description={sub} />
      <Table>
        <thead>
          <tr>
            <Th>Particulars</Th>
            <Th numeric>{heads[0]}</Th>
            {s!.previous ? <Th numeric>{heads[1]}</Th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const k = `${id}:${r.key}`;
            const pad = r.level === 0 ? '' : r.level === 1 ? 'pl-6' : 'pl-10';
            if (r.kind === 'HEADING') {
              return <tr key={k}><Td colSpan={3} className={`${pad} ${r.level === 0 ? 'bg-surface-raised/60 text-xs font-semibold uppercase tracking-wide text-fg-muted' : 'font-medium'}`}>{r.label}</Td></tr>;
            }
            const strong = r.kind === 'TOTAL' || r.level < 2;
            return (
              <Fragment key={k}>
                <tr className="border-t border-line">
                  <Td className={`${pad} ${strong ? 'font-semibold' : ''}`}>
                    {r.accounts.length ? (
                      <button type="button" className="text-left hover:text-accent print:hover:text-fg" aria-expanded={open.has(k)} onClick={() => toggle(k)}>
                        {r.label} <span className="text-xs text-fg-faint print:hidden">({r.accounts.length} {r.accounts.length === 1 ? 'account' : 'accounts'})</span>
                      </button>
                    ) : r.label}
                    {r.note ? <span className="block text-xs font-normal text-fg-faint">{r.note}</span> : null}
                  </Td>
                  <Td numeric className={strong ? 'font-semibold' : ''}><Money value={r.amount} currency={s!.currency} /></Td>
                  {s!.previous ? <Td numeric className={`text-fg-muted ${strong ? 'font-semibold' : ''}`}><Money value={r.previous} currency={s!.currency} /></Td> : null}
                </tr>
                {open.has(k) ? r.accounts.map((a) => (
                  <tr key={`${k}:${a.accountId}`} className="text-sm text-fg-muted">
                    <Td className="pl-14"><Link className="hover:text-accent" href={`/orgs/${orgId}/reports/general-ledger?accountId=${a.accountId}&from=${s!.from}&to=${s!.to}`}><span className="num">{a.code}</span> {a.name}</Link></Td>
                    <Td numeric><Money value={a.amount} currency={s!.currency} /></Td>
                    {s!.previous ? <Td /> : null}
                  </tr>
                )) : null}
              </Fragment>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );

  return (
    <>
      <PageHeader
        title="Statutory statements"
        description="Your balance sheet and profit and loss in the layout your country’s law or standard sets, with the year before. A starting point for your accountant: not a filing, not audited, and without the notes."
        actions={
          <>
            <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted print:hidden">
              Layout
              <Select className="w-[23rem]" aria-label="Layout" value={chosen} onChange={(e) => setFormat(e.target.value)}>
                {(formats.data?.formats ?? []).map((f) => <option key={f.id} value={f.id}>{f.name}{f.id === formats.data?.default ? ' (your country)' : ''}</option>)}
              </Select>
            </label>
            <DateInput label="From" value={from} onChange={setFrom} />
            <DateInput label="To" value={to} onChange={setTo} />
            <Button variant="ghost" className="print:hidden" onClick={() => window.print()}>Print</Button>
          </>
        }
      />
      {from > to ? <Alert title="Check the dates">The start date must be on or before the end date.</Alert> : null}
      <ErrorAlert title="Could not build the statements" error={q.error ?? formats.error} />
      {s ? (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <span className="font-medium text-fg">{s.organisation.legalName || s.organisation.name}</span>
            <span>· {s.format.name}</span>
            <span>· {s.currency}</span>
            {s.checks.balanced ? <Badge tone="positive">Balances</Badge> : <Badge tone="negative">Does not balance</Badge>}
            {s.checks.profitAgrees ? <Badge tone="positive">Agrees with profit and loss</Badge> : <Badge tone="negative">Profit does not agree</Badge>}
            {!s.format.isCountryDefault ? <Badge tone="warning">Not your country’s layout</Badge> : null}
          </div>
          {s.unclassified.length ? (
            <div className="mb-6">
              <Alert tone="warning" title={`${s.unclassified.length} ${s.unclassified.length === 1 ? 'account has' : 'accounts have'} no subtype`}>
                Placed by type only. Give {s.unclassified.length === 1 ? 'it' : 'them'} a subtype in the <Link className="underline" href={`/orgs/${orgId}/accounts`}>chart of accounts</Link> so {s.unclassified.length === 1 ? 'it lands' : 'they land'} on the right line:{' '}
                {s.unclassified.map((u) => `${u.code} ${u.name}`).join(', ')}.
              </Alert>
            </div>
          ) : null}
          {statement('bs', s.format.balanceSheetTitle, `As at ${date(s.to)}${s.previous ? `, with ${date(s.previous.to)}` : ''}`, s.balanceSheet, [date(s.to), s.previous ? date(s.previous.to) : ''])}
          {statement('pl', s.format.profitAndLossTitle, `For ${date(s.from)} to ${date(s.to)}${s.previous ? `, with ${date(s.previous.from)} to ${date(s.previous.to)}` : ''}`, s.profitAndLoss, ['This period', 'Same period last year'])}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card aria-label="Basis">
              <CardHeader title="Basis" />
              <div className="px-5 pb-5 pt-3 text-sm text-fg-muted">
                <p>{s.format.basis}</p>
                <p className="mt-2">Each account sits on one line by its type and subtype, so the statements always agree with the trial balance. Profit not yet closed to retained earnings is shown in equity.</p>
                <ul className="mt-2 space-y-1">
                  {s.format.sources.map((x) => <li key={x.url}><a className="underline" href={x.url} target="_blank" rel="noreferrer noopener">{x.title}</a></li>)}
                </ul>
              </div>
            </Card>
            <Card aria-label="Not included">
              <CardHeader title="Not included" description="Your accountant adds these for the statutory accounts." />
              <ul className="list-disc space-y-1 px-9 pb-5 pt-3 text-sm text-fg-muted">
                {s.format.notIncluded.map((x) => <li key={x}>{x}</li>)}
              </ul>
            </Card>
          </div>
        </>
      ) : null}
    </>
  );
}
