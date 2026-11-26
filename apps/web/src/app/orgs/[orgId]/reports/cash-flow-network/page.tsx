'use client';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, CardHeader, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { CashFlowNetwork, type CashFlowNetworkData, nodeName } from '@/components/reports/cash-flow-network';
import { monthLabel } from '@/components/reports/financial-visuals';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { today } from '@/lib/format';
import { useOrg } from '@/lib/org';

const shift = (month: string, by: number) => {
  const m = Number(month.slice(5, 7)) - 1 + by; // not money
  const y = Number(month.slice(0, 4)) + Math.floor(m / 12); // not money
  return `${y}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
};

/**
 * Reports → Cash-flow network (DASH-024): where cash came from and went to, per cash and bank
 * account, drawn as an animated network you can play month by month. The same flows are in the
 * tables below.
 */
export default function CashFlowNetworkPage() {
  const { org, orgId } = useOrg();
  const [to, setTo] = useState(() => today().slice(0, 7));
  const [from, setFrom] = useState(() => shift(today().slice(0, 7), -11));
  /** Index into the months, or -1 for all months together. */
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => setReducedMotion(window.matchMedia('(prefers-reduced-motion: reduce)').matches), []);
  const q = useQuery({
    queryKey: ['cash-flow-network', orgId, from, to],
    queryFn: () => api<CashFlowNetworkData>(`/v1/orgs/${orgId}/reports/cash-flow-network?from=${from}&to=${to}`),
    enabled: /^\d{4}-\d{2}$/.test(from) && /^\d{4}-\d{2}$/.test(to),
  });
  const d = q.data;
  const count = d?.months.length ?? 0;
  useEffect(() => {
    if (!playing || !count) return;
    const t = setInterval(() => setIndex((i) => (i + 1 >= count ? 0 : i + 1)), 1600);
    return () => clearInterval(t);
  }, [playing, count]);
  if (!org) return null;
  const c = d?.currency ?? org.functionalCurrency;
  const period = d ? (index >= 0 && index < d.months.length ? d.months[index] : d.total) : null;
  const periodName = d && period ? (period.month === 'ALL' ? `${monthLabel(d.from)} to ${monthLabel(d.to)}` : monthLabel(period.month)) : '';
  const shown = period && picked ? period.flows.filter((f) => f.from === picked || f.to === picked) : (period?.flows ?? []);
  const reset = () => {
    setIndex(-1);
    setPlaying(false);
    setPicked(null);
  };
  return (
    <>
      <PageHeader
        title="Cash-flow network"
        description="Where your cash came from and where it went, for each cash and bank account, from posted entries. Play it month by month to watch the money move, or choose a month. Lines are as wide as the money that moved."
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
      <ErrorAlert title="Could not work out the cash flows" error={q.error} />
      {d && period ? (
        <div className="grid gap-4">
          <Card role="region" aria-label="Cash moving">
            <CardHeader
              title="Cash moving"
              description={`${periodName}: ${d.entries.toLocaleString('en-IN')} posted entries moved cash over the months chosen. Choose an account or group to pick out its flows.`}
            />
            <div className="flex flex-wrap items-center gap-3 px-5 pb-3">
              <Button
                variant="secondary"
                onClick={() => {
                  if (!playing && index < 0) setIndex(0);
                  setPlaying((p) => !p);
                }}
                aria-pressed={playing}
              >
                {playing ? 'Pause' : 'Play months'}
              </Button>
              <Button
                variant={index < 0 ? 'primary' : 'secondary'}
                onClick={() => {
                  setPlaying(false);
                  setIndex(-1);
                }}
              >
                All months
              </Button>
              <label className="flex min-w-[14rem] flex-1 items-center gap-3 text-sm">
                <span className="text-fg-muted">Month</span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, count - 1)}
                  value={index < 0 ? count - 1 : index}
                  onChange={(e) => {
                    setPlaying(false);
                    setIndex(Number(e.target.value));
                  }}
                  className="flex-1"
                  aria-label="Month to show"
                  aria-valuetext={index < 0 ? 'All months' : monthLabel(d.months[index].month)}
                />
                <span className="w-24 text-right font-medium" aria-live="polite" data-testid="cash-period">
                  {index < 0 ? 'All months' : monthLabel(period.month)}
                </span>
              </label>
            </div>
            <dl className="grid grid-cols-3 gap-3 px-5 pb-3 text-sm">
              <div>
                <dt className="text-fg-muted">Money in</dt>
                <dd className="text-base font-semibold">
                  <Money value={period.inflow} currency={c} />
                </dd>
              </div>
              <div>
                <dt className="text-fg-muted">Money out</dt>
                <dd className="text-base font-semibold">
                  <Money value={period.outflow} currency={c} />
                </dd>
              </div>
              <div>
                <dt className="text-fg-muted">Net change</dt>
                <dd className="text-base font-semibold">
                  <Money value={period.net} currency={c} signed />
                </dd>
              </div>
            </dl>
            {period.flows.length ? (
              <div className="px-4 pb-4">
                <CashFlowNetwork d={d} period={period} picked={picked} onPick={setPicked} animate={!reducedMotion} />
              </div>
            ) : (
              <p className="px-5 pb-5 text-sm text-fg-muted">No cash moved in {periodName}. Post receipts, payments or bank entries, or choose other months.</p>
            )}
          </Card>
          <Card role="region" aria-label="Cash flows">
            <CardHeader title="Cash flows" description={`Every flow drawn above for ${periodName}${picked ? `, for ${nodeName(picked, d.nodes)}` : ''}, largest first.`} />
            <Table aria-label={`Cash flows, ${periodName}`}>
              <thead>
                <tr>
                  <Th>From</Th>
                  <Th>To</Th>
                  <Th numeric>Amount</Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((f) => (
                  <Tr key={`${f.from}>${f.to}`}>
                    <Td>{nodeName(f.from, d.nodes)}</Td>
                    <Td>{nodeName(f.to, d.nodes)}</Td>
                    <Td numeric>
                      <Money value={f.amount} currency={c} />
                    </Td>
                  </Tr>
                ))}
                {!shown.length ? (
                  <Tr>
                    <Td colSpan={3} className="text-fg-muted">
                      No flows.
                    </Td>
                  </Tr>
                ) : null}
              </tbody>
            </Table>
          </Card>
          <Card role="region" aria-label="Cash by month">
            <CardHeader title="Cash by month" description="Money in and out of the business each month. Money moved between your own accounts is in neither. Choose a month to draw it." />
            <Table aria-label="Cash in and out by month">
              <thead>
                <tr>
                  <Th>Month</Th>
                  <Th numeric>Money in</Th>
                  <Th numeric>Money out</Th>
                  <Th numeric>Net change</Th>
                </tr>
              </thead>
              <tbody>
                {d.months.map((m, i) => (
                  <Tr key={m.month}>
                    <Td>
                      <button
                        type="button"
                        className="text-accent hover:underline"
                        onClick={() => {
                          setPlaying(false);
                          setIndex(i);
                        }}
                      >
                        {monthLabel(m.month)}
                      </button>
                    </Td>
                    <Td numeric>
                      <Money value={m.inflow} currency={c} />
                    </Td>
                    <Td numeric>
                      <Money value={m.outflow} currency={c} />
                    </Td>
                    <Td numeric>
                      <Money value={m.net} currency={c} signed />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <p className="px-5 py-3 text-xs text-fg-muted">
              Each entry that moves cash is split over the other side of the entry in proportion. See{' '}
              <Link className="text-accent hover:underline" href={`/orgs/${orgId}/reports/cash-flow-statement`}>
                the cash flow statement
              </Link>{' '}
              for the statutory view.
            </p>
          </Card>
        </div>
      ) : null}
    </>
  );
}
