'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { bucketLabel, sourceLabel, type Timeline, TimelineChart, type TimelineDeadline, type TimelineSize } from '@/components/reports/financial-timeline';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useOrg } from '@/lib/org';

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10); // not money
const PRESETS: { label: string; from: number; to: number }[] = [
  { label: 'Last 30 days', from: -29, to: 0 },
  { label: 'Last 90 days and next 30', from: -90, to: 30 },
  { label: 'Last 12 months', from: -364, to: 0 },
  { label: 'Next 6 months of deadlines', from: 0, to: 182 },
];
const DEADLINE: Record<TimelineDeadline['status'], { label: string; tone: 'negative' | 'warning' | 'neutral' | 'positive' }> = {
  OVERDUE: { label: 'Overdue', tone: 'negative' },
  DUE_SOON: { label: 'Due soon', tone: 'warning' },
  UPCOMING: { label: 'Upcoming', tone: 'neutral' },
  DONE: { label: 'Done', tone: 'positive' },
};

/**
 * Reports → Financial timeline (DASH-033): what was posted, the cash it moved and what falls due,
 * over a range of days, drawn as a timeline you can zoom, filter by kind of entry and open. Choose
 * a bar or a row to see that period's entries and deadlines; open an entry to see the journal.
 */
export default function FinancialTimelinePage() {
  const { org, orgId } = useOrg();
  const [from, setFrom] = useState(() => addDays(today(), -90));
  const [to, setTo] = useState(() => addDays(today(), 30));
  const [size, setSize] = useState<'' | TimelineSize>('');
  const [hidden, setHidden] = useState<string[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [zoom, setZoom] = useState<{ key: string; w: [number, number] } | null>(null);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to);
  const q = useQuery({ queryKey: ['timeline', orgId, from, to, size], queryFn: () => api<Timeline>(`/v1/orgs/${orgId}/reports/timeline?from=${from}&to=${to}${size ? `&size=${size}` : ''}`), enabled: valid });
  const t = q.data;
  const key = t ? `${t.from}|${t.to}|${t.size}` : '';
  const w: [number, number] = zoom && zoom.key === key ? zoom.w : [0, Math.max(0, (t?.buckets.length ?? 1) - 1)];
  const shown = useMemo(() => {
    if (!t) return { entries: [], deadlines: [], title: '' };
    const lo = t.buckets[w[0]]?.start ?? t.from;
    const hi = t.buckets[w[1]]?.end ?? t.to;
    const inView = (b: string) => (picked ? b === picked : b >= lo && b <= hi);
    const pb = picked ? t.buckets.find((b) => b.start === picked) : null;
    return {
      entries: t.entries.filter((e) => inView(e.bucket) && !hidden.includes(e.source)),
      deadlines: t.deadlines.filter((d) => inView(d.bucket)),
      title: pb ? bucketLabel(pb, t.size) : `${date(lo < t.from ? t.from : lo)} to ${date(hi > t.to ? t.to : hi)}`,
    };
  }, [t, w, picked, hidden]);
  if (!org) return null;
  const c = t?.currency ?? org.functionalCurrency;
  const preset = (p: (typeof PRESETS)[number]) => {
    setFrom(addDays(today(), p.from));
    setTo(addDays(today(), p.to));
    setPicked(null);
  };
  const toggle = (s: string) => setHidden((h) => (h.includes(s) ? h.filter((x) => x !== s) : [...h, s]));
  return (
    <>
      <PageHeader
        title="Financial timeline"
        description="What was posted, the cash it moved and what falls due, over the days you choose. Zoom with the handles under the chart, hide kinds of entries, and choose any bar or period to see the entries and deadlines in it."
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPicked(null); }} />}</Field>
        <Field label="Until">{(p) => <Input {...p} type="date" value={to} onChange={(e) => { setTo(e.target.value); setPicked(null); }} />}</Field>
        <Field label="Show by">
          {(p) => (
            <Select {...p} value={size} onChange={(e) => { setSize(e.target.value as '' | TimelineSize); setPicked(null); }}>
              <option value="">Best fit</option>
              <option value="DAY">Day</option>
              <option value="WEEK">Week</option>
              <option value="MONTH">Month</option>
            </Select>
          )}
        </Field>
        <div className="flex flex-wrap gap-2 pb-1">
          {PRESETS.map((p) => <Button key={p.label} variant="ghost" size="sm" onClick={() => preset(p)}>{p.label}</Button>)}
        </div>
      </div>
      <ErrorAlert title="Could not draw the timeline" error={q.error} />
      {t ? (
        <div className="grid gap-4">
          <Card role="region" aria-label="Cash over time">
            <CardHeader
              title="Cash over time"
              description={`Cash in and out of cash and bank accounts by ${t.size.toLowerCase()}, and the balance at the end of each. Transfers between your own accounts are left out. Amber lines mark deadlines; drag the handles under the chart to zoom.`}
            />
            <div className="grid gap-3 px-5 pb-2 sm:grid-cols-4">
              <div><p className="text-xs text-fg-muted">Cash at {date(t.from)}</p><p className="num text-lg"><Money value={t.totals.openingCash} currency={c} /></p></div>
              <div><p className="text-xs text-fg-muted">Cash in</p><p className="num text-lg text-positive"><Money value={t.totals.cashIn} currency={c} /></p></div>
              <div><p className="text-xs text-fg-muted">Cash out</p><p className="num text-lg text-negative"><Money value={t.totals.cashOut} currency={c} /></p></div>
              <div><p className="text-xs text-fg-muted">{t.to >= t.today ? "Cash now" : `Cash at ${date(t.to)}`}</p><p className="num text-lg"><Money value={t.totals.closingCash} currency={c} /></p></div>
            </div>
            <TimelineChart t={t} window={w} onWindow={(nw) => { setZoom({ key, w: nw }); setPicked(null); }} onPick={(s) => setPicked((p) => (p === s ? null : s))} picked={picked} />
            {t.sources.length ? (
              <fieldset className="flex flex-wrap items-center gap-3 px-5 pb-4 text-sm">
                <legend className="sr-only">Kinds of entries to show</legend>
                <span className="text-xs text-fg-muted">Show:</span>
                {t.sources.map((s) => (
                  <label key={s.source} className="flex items-center gap-1.5">
                    <input type="checkbox" checked={!hidden.includes(s.source)} onChange={() => toggle(s.source)} />
                    {sourceLabel(s.source)} <span className="text-fg-muted">({s.count})</span>
                  </label>
                ))}
              </fieldset>
            ) : null}
          </Card>

          <Card role="region" aria-label="What happened">
            <CardHeader
              title="What happened"
              description={`${shown.title}. ${picked ? 'Choose the bar again, or Show the whole range, to go back.' : 'Choose a bar or a period below to narrow it.'}`}
              actions={picked || zoom ? <Button variant="ghost" size="sm" onClick={() => { setPicked(null); setZoom(null); }}>Show the whole range</Button> : undefined}
            />
            {shown.entries.length ? (
              <Table aria-label="Entries in view">
                <thead><Tr><Th>Date</Th><Th>Entry</Th><Th>Kind</Th><Th>Reference and memo</Th><Th numeric>Amount</Th><Th numeric>Cash in</Th><Th numeric>Cash out</Th></Tr></thead>
                <tbody>
                  {shown.entries.slice(0, 200).map((e) => (
                    <Tr key={e.id}>
                      <Td className="whitespace-nowrap">{date(e.date)}</Td>
                      <Td><Link className="num text-accent hover:underline" href={`/orgs/${orgId}/journals/${e.id}`}>{e.entryNumber ? `JE-${String(e.entryNumber).padStart(4, '0')}` : 'Open'}</Link></Td>
                      <Td>{sourceLabel(e.source)}</Td>
                      <Td className="text-fg-muted">{[e.reference, e.memo].filter(Boolean).join(' · ')}</Td>
                      <Td numeric><Money value={e.amount} currency={c} /></Td>
                      <Td numeric>{e.cashIn === '0.00' ? '—' : <Money value={e.cashIn} currency={c} />}</Td>
                      <Td numeric>{e.cashOut === '0.00' ? '—' : <Money value={e.cashOut} currency={c} />}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : <p className="px-5 pb-4 text-sm text-fg-muted">No entries {hidden.length ? 'of the kinds shown ' : ''}in this part of the timeline.</p>}
            {shown.entries.length > 200 ? <p className="px-5 pb-3 text-xs text-fg-muted">The first 200 of {shown.entries.length} are listed. Zoom in to see the rest.</p> : null}
            <div className="border-t border-border px-5 py-3">
              <h3 className="mb-2 text-sm font-medium">Deadlines</h3>
              {!t.complianceConfigured ? (
                <p className="text-sm text-fg-muted">No compliance deadlines yet. Register for GST or set up TDS, payroll or advance tax and they appear here.</p>
              ) : shown.deadlines.length ? (
                <ul className="flex flex-col gap-1.5 text-sm" aria-label="Deadlines in view">
                  {shown.deadlines.map((d) => (
                    <li key={d.key} className="flex flex-wrap items-center gap-2">
                      <span className="num w-28 text-fg-muted">{date(d.date)}</span>
                      <Link className="hover:text-accent" href={`/orgs/${orgId}/tax/compliance`}>{d.name}</Link>
                      <Badge tone={DEADLINE[d.status].tone}>{DEADLINE[d.status].label}</Badge>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-fg-muted">None in this part of the timeline.</p>}
            </div>
          </Card>

          <Card role="region" aria-label="Timeline by period">
            <CardHeader title="Timeline by period" description="Every period of the timeline with the figures in the chart. Choose a period to see what happened in it." />
            {t.totals.entries === 0 && t.totals.deadlines === 0 ? <div className="px-5 pb-4"><EmptyState title="Nothing in these days">Nothing was posted and nothing falls due. Choose other days.</EmptyState></div> : null}
            <div className="overflow-x-auto">
              <Table aria-label="Timeline by period">
                <thead><Tr><Th>Period</Th><Th numeric>Entries</Th><Th numeric>Cash in</Th><Th numeric>Cash out</Th><Th numeric>Cash at the end</Th><Th numeric>Deadlines</Th></Tr></thead>
                <tbody>
                  {t.buckets.map((b) => (
                    <Tr key={b.start} className={picked === b.start ? 'bg-surface-hover' : ''}>
                      <Td><button type="button" className="text-left hover:text-accent" aria-pressed={picked === b.start} onClick={() => setPicked((p) => (p === b.start ? null : b.start))}>{bucketLabel(b, t.size)}</button></Td>
                      <Td numeric>{b.entries}</Td>
                      <Td numeric><Money value={b.cashIn} currency={c} /></Td>
                      <Td numeric><Money value={b.cashOut} currency={c} /></Td>
                      <Td numeric>{b.closingCash === null ? <span className="text-fg-muted">Still to come</span> : <Money value={b.closingCash} currency={c} />}</Td>
                      <Td numeric>{b.deadlines || '—'}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </Card>
        </div>
      ) : !q.error && valid ? <p className="text-sm text-fg-muted">Drawing the timeline…</p> : null}
    </>
  );
}
