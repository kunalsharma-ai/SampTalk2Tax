'use client';
import { useQuery } from '@tanstack/react-query';
import { COUNTRY_CENTRES } from '@talk2tax/accounting-engine';
import { Button, Card, CardHeader, Field, Input, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useEffect, useRef, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { monthLabel } from '@/components/reports/financial-visuals';
import { placeAmount, RevenueGlobe, type RevenueGlobeData } from '@/components/reports/revenue-globe';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { today } from '@/lib/format';
import { DEFAULT_GLOBE, type GlobeView } from '@/lib/globe';
import { shortestTurn, tween } from '@/lib/motion';
import { useOrg } from '@/lib/org';

const shift = (month: string, by: number) => {
  const m = Number(month.slice(5, 7)) - 1 + by; // not money
  const y = Number(month.slice(0, 4)) + Math.floor(m / 12); // not money
  return `${y}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
};
const percent = (share: string) => `${(Number(share) * 100).toFixed(1)}%`; // not money: a share for display
const KIND: Record<string, string> = { COUNTRY: 'Country', STATE: 'State', UNPLACED: 'Not on the globe' };

/**
 * Reports → Revenue globe (DASH-025): sales revenue by where customers are, as bubbles on a globe
 * you can turn, zoom into the home country and play month by month; every figure in a table.
 */
export default function RevenueGlobePage() {
  const { org, orgId } = useOrg();
  const [to, setTo] = useState(() => today().slice(0, 7));
  const [from, setFrom] = useState(() => shift(today().slice(0, 7), -11));
  const [view, setView] = useState<GlobeView>(DEFAULT_GLOBE);
  const [month, setMonth] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  // Choosing a place or zooming glides the globe there (at once when motion is reduced).
  const glide = useRef<() => void>(() => {});
  const viewRef = useRef(view);
  viewRef.current = view;
  const glideTo = (to: GlobeView) => {
    glide.current();
    const from = viewRef.current;
    glide.current = tween([from.lon, from.lat, from.zoom], [from.lon + shortestTurn(from.lon, to.lon), to.lat, to.zoom], 700, ([lon, lat, zoom]) =>
      setView({ lon: ((((lon + 180) % 360) + 360) % 360) - 180, lat, zoom }),
    );
  };
  useEffect(() => () => glide.current(), []);
  const q = useQuery({
    queryKey: ['revenue-globe', orgId, from, to],
    queryFn: () => api<RevenueGlobeData>(`/v1/orgs/${orgId}/reports/revenue-globe?from=${from}&to=${to}`),
    enabled: /^\d{4}-\d{2}$/.test(from) && /^\d{4}-\d{2}$/.test(to),
  });
  const d = q.data;
  const count = d?.months.length ?? 0;
  useEffect(() => {
    if (!playing || !count) return;
    const t = setInterval(() => setMonth((i) => (i === null || i + 1 >= count ? 0 : i + 1)), 1000);
    return () => clearInterval(t);
  }, [playing, count]);
  if (!org) return null;
  const reset = () => {
    setMonth(null);
    setPlaying(false);
    setSelected(null);
  };
  const homeAt = d ? COUNTRY_CENTRES[d.homeCountry] : undefined;
  const periodLabel = d ? (month === null ? `${monthLabel(d.from)} to ${monthLabel(d.to)}` : monthLabel(d.months[month])) : '';
  const total = d ? (month === null ? d.total : d.monthTotals[month]) : '0';
  const rows = d ? [...d.places].sort((a, b) => Number(placeAmount(b, month)) - Number(placeAmount(a, month))) : []; // not money: ordering only
  const shareOf = (v: string) => (Number(total) > 0 ? percent(String(Number(v) / Number(total))) : '—'); // not money: a share for display
  return (
    <>
      <PageHeader
        title="Revenue globe"
        description="Where your sales revenue comes from: one bubble per country, and per state at home, as large as the revenue earned there. Turn the globe, zoom into your own country and play the months. Every figure is in the table below."
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
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
      <ErrorAlert title="Could not build the revenue globe" error={q.error} />
      {d ? (
        d.places.length === 0 ? (
          <Card>
            <p className="p-5 text-sm text-fg-muted">{`No sales revenue posted from ${monthLabel(d.from)} to ${monthLabel(d.to)}. Post invoices, or choose other months.`}</p>
          </Card>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
            <section aria-label="Revenue summary" className="grid gap-4 sm:grid-cols-4">
              <Stat label="Sales revenue" value={<Money value={d.total} currency={d.currency} />} sub={`${monthLabel(d.from)} to ${monthLabel(d.to)}`} tone="accent" />
              <Stat label="Earned abroad" value={percent(d.abroadShare)} sub={<Money value={d.abroad} currency={d.currency} />} tone="neutral" />
              <Stat
                label="Places"
                value={String(d.places.length)}
                sub={`${d.countries} ${d.countries === 1 ? 'country' : 'countries'}, ${d.customers} ${d.customers === 1 ? 'customer' : 'customers'}`}
                tone="neutral"
              />
              <Stat label="Largest place" value={d.places[0].name} sub={`${percent(d.places[0].share)} of revenue`} tone="neutral" />
            </section>
            <Card role="region" aria-label="Globe">
              <CardHeader title="Globe" description="Drag to turn it, or focus it and use the arrow keys. Bubbles on the far side are hidden; turn the globe or choose a place in the table." />
              <div className="flex flex-wrap items-center gap-3 px-5 pb-3">
                <Button
                  variant="secondary"
                  aria-pressed={playing}
                  onClick={() => {
                    if (!playing && (month === null || month >= count - 1)) setMonth(0);
                    setPlaying((p) => !p);
                  }}
                >
                  {playing ? 'Pause' : 'Play months'}
                </Button>
                <Button
                  variant="ghost"
                  aria-pressed={month === null}
                  onClick={() => {
                    setPlaying(false);
                    setMonth(null);
                  }}
                >
                  All months
                </Button>
                {homeAt ? (
                  <Button variant="ghost" aria-pressed={view.zoom > 1} onClick={() => glideTo(view.zoom > 1 ? DEFAULT_GLOBE : { lat: homeAt[0], lon: homeAt[1], zoom: 4 })}>
                    {view.zoom > 1 ? 'Whole world' : 'Zoom to home country'}
                  </Button>
                ) : null}
                <label className="flex min-w-[14rem] flex-1 items-center gap-3 text-sm">
                  <span className="text-fg-muted">Month</span>
                  <input
                    type="range"
                    className="flex-1"
                    min={0}
                    max={count - 1}
                    value={month ?? count - 1}
                    onChange={(e) => {
                      setPlaying(false);
                      setMonth(Number(e.target.value));
                    }}
                    aria-label="Choose a month"
                    aria-valuetext={month === null ? 'All months' : monthLabel(d.months[month])}
                  />
                  <span className="w-24 text-right font-medium" aria-live="polite" data-testid="globe-period">
                    {month === null ? 'All months' : monthLabel(d.months[month])}
                  </span>
                </label>
              </div>
              <div className="px-4 pb-4">
                <RevenueGlobe
                  d={d}
                  month={month}
                  periodLabel={periodLabel}
                  view={view}
                  onView={(v) => {
                    glide.current();
                    setView(v);
                  }}
                  selected={selected}
                />
              </div>
            </Card>
            <Card role="region" aria-label="Revenue by place">
              <CardHeader title="Revenue by place" description={`Revenue for ${periodLabel}. Choose a place to turn the globe to it and pick out its bubble.`} />
              <div className="overflow-x-auto">
                <Table aria-label={`Revenue by place, ${periodLabel}`}>
                  <thead>
                    <tr>
                      <Th>Place</Th>
                      <Th>Kind</Th>
                      <Th numeric>Customers, all months</Th>
                      <Th numeric>Revenue</Th>
                      <Th numeric>Share</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => {
                      const on = selected === p.key;
                      const v = placeAmount(p, month);
                      return (
                        <Tr key={p.key} className={on ? 'bg-accent/10' : undefined}>
                          <Th scope="row" className="normal-case">
                            {p.lat !== null && p.lon !== null ? (
                              <button
                                type="button"
                                className="text-left hover:underline"
                                aria-pressed={on}
                                onClick={() => {
                                  if (on) return setSelected(null);
                                  setSelected(p.key);
                                  glideTo({ lat: p.lat!, lon: p.lon!, zoom: p.kind === 'STATE' ? 4 : 1 });
                                }}
                              >
                                {p.name}
                              </button>
                            ) : (
                              p.name
                            )}
                          </Th>
                          <Td>{KIND[p.kind]}</Td>
                          <Td numeric>{p.customers}</Td>
                          <Td numeric>
                            <Money value={v} currency={d.currency} />
                          </Td>
                          <Td numeric>{shareOf(v)}</Td>
                        </Tr>
                      );
                    })}
                    <Tr>
                      <Th scope="row" className="normal-case">
                        Total
                      </Th>
                      <Td />
                      <Td numeric>{d.customers}</Td>
                      <Td numeric>
                        <Money value={total} currency={d.currency} />
                      </Td>
                      <Td numeric>{Number(total) > 0 ? '100.0%' : '—'}</Td>
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
