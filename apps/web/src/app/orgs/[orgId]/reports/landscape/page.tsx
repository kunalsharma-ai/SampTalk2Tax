'use client';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, CardHeader, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { type FinancialLandscapeData, Landscape3D, type LandscapeView, rowColour } from '@/components/reports/financial-landscape';
import { monthLabel } from '@/components/reports/financial-visuals';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { today } from '@/lib/format';
import { shortestTurn, tween } from '@/lib/motion';
import { useOrg } from '@/lib/org';
import type { View3D } from '@/lib/surface-3d';

const shift = (month: string, by: number) => {
  const m = Number(month.slice(5, 7)) - 1 + by; // not money
  const y = Number(month.slice(0, 4)) + Math.floor(m / 12); // not money
  return `${y}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
};

/**
 * Reports → Financial landscape (DASH-023): spending or income by account and month as a 3D
 * landscape of towers you can turn and play over the months; every figure in a table, each
 * linking to the account's general ledger for that month.
 */
export default function FinancialLandscapePage() {
  const { org, orgId } = useOrg();
  const [to, setTo] = useState(() => today().slice(0, 7));
  const [from, setFrom] = useState(() => shift(today().slice(0, 7), -11));
  const [kind, setKind] = useState<LandscapeView>('EXPENSES');
  const [view, setView] = useState<View3D>({ yaw: -30, pitch: 32 });
  const [upTo, setUpTo] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [mark, setMark] = useState<{ row: number; col: number } | null>(null);
  // Buttons glide the camera to the new view (at once when motion is reduced).
  const glide = useRef<() => void>(() => {});
  const viewRef = useRef(view);
  viewRef.current = view;
  const glideTo = (to: View3D) => {
    glide.current();
    const from = viewRef.current;
    glide.current = tween([from.yaw, from.pitch], [from.yaw + shortestTurn(from.yaw, to.yaw), to.pitch], 600, ([yaw, pitch]) => setView({ yaw, pitch }));
  };
  useEffect(() => () => glide.current(), []);
  const q = useQuery({
    queryKey: ['landscape', orgId, from, to, kind],
    queryFn: () => api<FinancialLandscapeData>(`/v1/orgs/${orgId}/reports/landscape?from=${from}&to=${to}&view=${kind}`),
    enabled: /^\d{4}-\d{2}$/.test(from) && /^\d{4}-\d{2}$/.test(to),
  });
  const d = q.data;
  const count = d?.months.length ?? 0;
  useEffect(() => {
    if (!playing || !count) return;
    const t = setInterval(() => setUpTo((i) => (i === null || i + 1 >= count ? 0 : i + 1)), 900);
    return () => clearInterval(t);
  }, [playing, count]);
  if (!org) return null;
  const last = upTo === null ? count - 1 : Math.min(upTo, count - 1);
  const reset = () => {
    setUpTo(null);
    setPlaying(false);
    setMark(null);
  };
  const ledger = (row: FinancialLandscapeData['rows'][number], month: string) =>
    row.accountIds.length === 1
      ? `/orgs/${orgId}/reports/general-ledger?accountId=${row.accountIds[0]}&from=${month}-01&to=${new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10)}`
      : null;
  return (
    <>
      <PageHeader
        title="Financial landscape"
        description="Your spending or income by account and month as a 3D landscape: one row of towers per account, one column per month, each tower as tall as the amount. Turn it to look from any side and play the months to watch it grow. Every figure is in the table below."
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Show">
          {(p) => (
            <Select
              {...p}
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as LandscapeView);
                reset();
              }}
            >
              <option value="EXPENSES">Spending</option>
              <option value="REVENUE">Income</option>
            </Select>
          )}
        </Field>
        <Field label="From month">
          {(p) => (
            <Input
              {...p}
              type="month"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                reset();
              }}
            />
          )}
        </Field>
        <Field label="To month">
          {(p) => (
            <Input
              {...p}
              type="month"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                reset();
              }}
            />
          )}
        </Field>
      </div>
      <ErrorAlert title="Could not build the landscape" error={q.error} />
      {d ? (
        d.rows.length === 0 ? (
          <Card>
            <p className="p-5 text-sm text-fg-muted">{`No ${kind === 'REVENUE' ? 'income' : 'spending'} posted from ${monthLabel(d.from)} to ${monthLabel(d.to)}. Post invoices, bills or journals, or choose other months.`}</p>
          </Card>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
            <section aria-label="Landscape summary" className="grid gap-4 sm:grid-cols-3">
              <Stat label={kind === 'REVENUE' ? 'Income' : 'Spending'} value={<Money value={d.total} currency={d.currency} />} sub={`${monthLabel(d.from)} to ${monthLabel(d.to)}`} tone="accent" />
              <Stat
                label="Tallest tower"
                value={d.peak ? <Money value={d.peak.amount} currency={d.currency} /> : '—'}
                sub={d.peak ? `${d.peak.row}, ${monthLabel(d.peak.month)}` : ''}
                tone="neutral"
              />
              <Stat
                label="Busiest month"
                value={d.busiestMonth ? monthLabel(d.busiestMonth) : '—'}
                sub={d.busiestMonth ? <Money value={d.monthTotals[d.months.indexOf(d.busiestMonth)]} currency={d.currency} /> : ''}
                tone="neutral"
              />
            </section>
            <Card role="region" aria-label="Landscape">
              <CardHeader title="Landscape" description="Drag to turn it, or focus it and use the arrow keys. Largest accounts at the front; the rest are joined as one row." />
              <div className="flex flex-wrap items-center gap-3 px-5 pb-3">
                <Button
                  variant="secondary"
                  aria-pressed={playing}
                  onClick={() => {
                    if (!playing && last >= count - 1) setUpTo(0);
                    setPlaying((p) => !p);
                  }}
                >
                  {playing ? 'Pause' : 'Play months'}
                </Button>
                <Button variant="ghost" onClick={() => glideTo({ yaw: -30, pitch: 32 })}>
                  Reset view
                </Button>
                <Button variant="ghost" onClick={() => glideTo({ yaw: 0, pitch: 8 })}>
                  View from the front
                </Button>
                <label className="flex min-w-[14rem] flex-1 items-center gap-3 text-sm">
                  <span className="text-fg-muted">Up to</span>
                  <input
                    type="range"
                    className="flex-1"
                    min={0}
                    max={count - 1}
                    value={last}
                    onChange={(e) => {
                      setPlaying(false);
                      setUpTo(Number(e.target.value));
                    }}
                    aria-label="Show months up to"
                    aria-valuetext={monthLabel(d.months[last])}
                  />
                  <span className="w-16 text-right font-medium" aria-live="polite" data-testid="landscape-month">
                    {monthLabel(d.months[last])}
                  </span>
                </label>
              </div>
              <div className="px-4 pb-4">
                <Landscape3D
                  d={d}
                  upTo={last}
                  view={view}
                  onView={(v) => {
                    glide.current();
                    setView(v);
                  }}
                  mark={mark}
                />
              </div>
            </Card>
            <Card role="region" aria-label="Landscape figures">
              <CardHeader title="Landscape figures" description="Every tower's amount. Choose an amount to pick out its tower; open an account's ledger for the month from its name." />
              <div className="overflow-x-auto">
                <Table aria-label={`${kind === 'REVENUE' ? 'Income' : 'Spending'} by account and month`}>
                  <thead>
                    <tr>
                      <Th>Account</Th>
                      {d.months.map((m) => (
                        <Th key={m} numeric>
                          {monthLabel(m)}
                        </Th>
                      ))}
                      <Th numeric>Total</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.rows.map((r, ri) => (
                      <Tr key={r.key}>
                        <Th scope="row" className="whitespace-nowrap normal-case">
                          <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full" style={{ background: rowColour(ri) }} aria-hidden="true" />
                          {r.label}
                        </Th>
                        {r.values.map((v, ci) => {
                          const on = mark?.row === ri && mark?.col === ci;
                          const href = ledger(r, d.months[ci]);
                          return (
                            <Td key={ci} numeric className={on ? 'bg-accent/15' : undefined}>
                              <button
                                type="button"
                                className="hover:underline"
                                aria-pressed={on}
                                aria-label={`${r.label}, ${monthLabel(d.months[ci])}`}
                                onClick={() => setMark(on ? null : { row: ri, col: ci })}
                              >
                                <Money value={v} currency={d.currency} />
                              </button>
                              {on && href ? (
                                <Link className="ml-2 text-xs text-accent hover:underline" href={href}>
                                  Ledger
                                </Link>
                              ) : null}
                            </Td>
                          );
                        })}
                        <Td numeric>
                          <Money value={r.total} currency={d.currency} />
                        </Td>
                      </Tr>
                    ))}
                    <Tr>
                      <Th scope="row" className="normal-case">
                        Total
                      </Th>
                      {d.monthTotals.map((t, i) => (
                        <Td key={i} numeric>
                          <Money value={t} currency={d.currency} />
                        </Td>
                      ))}
                      <Td numeric>
                        <Money value={d.total} currency={d.currency} />
                      </Td>
                    </Tr>
                  </tbody>
                </Table>
              </div>
            </Card>
          </div>
        )
      ) : null}
    </>
  );
}
