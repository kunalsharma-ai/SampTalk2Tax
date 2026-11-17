'use client';
import { Badge, Card, CardHeader, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import { Money } from '@/components/money';
import { TwinCashChart } from '@/components/twin/twin-chart';
import { AREA_LABEL, PAYBACK, type Delta, type ImpactResult, type Payback } from '@/lib/impact';
import { monthLabel } from '@/lib/twin';

const tone = (v: string) => (v.startsWith('-') ? 'negative' : Number(v) > 0 ? 'positive' : 'neutral');
const pts = (v: string | null) => (v === null ? '—' : `${Number(v) > 0 ? '+' : ''}${v} pts`);

function PaybackText({ p, currency }: { p: Payback; currency: string }) {
  if (p.status === 'NO_OUTLAY') return <span className="text-sm text-fg-muted">{PAYBACK.NO_OUTLAY}</span>;
  return (
    <span className="text-sm">
      <Badge tone={p.status === 'PAYS_BACK' ? 'positive' : p.status === 'NOT_WITHIN' ? 'warning' : 'negative'}>{PAYBACK[p.status]}</Badge>
      <span className="block text-xs text-fg-muted">
        {p.status === 'PAYS_BACK' ? `Back level by ${monthLabel(p.month!)}; ` : ''}up to <Money value={p.deepest.amount} currency={currency} signed /> in {monthLabel(p.deepest.month)}
      </span>
    </span>
  );
}

function DeltaCells({ d, currency }: { d: Delta; currency: string }) {
  return (
    <>
      <Td numeric><Money value={d.revenue} currency={currency} signed /></Td>
      <Td numeric><Money value={d.grossProfit} currency={currency} signed /></Td>
      <Td numeric><Money value={d.netProfit} currency={currency} signed /></Td>
      <Td numeric><Money value={d.closingCash} currency={currency} signed /></Td>
    </>
  );
}

/** What the business changes do: before and after, each change's chain to the statements, each area, and every month. */
export function ImpactResults({ r, actual, currency }: { r: ImpactResult; actual: { month: string; cash: string }[]; currency: string }) {
  const H = r.months.length;
  const asis = r.months.map((m) => ({ month: m.month, closingCash: m.cashBefore }));
  const withChanges = r.months.map((m) => ({ month: m.month, closingCash: m.cashAfter }));
  const rows: [string, string, string, string, 'money' | 'pct'][] = [
    ['Revenue', r.before.revenue, r.after.revenue, r.change.revenue, 'money'],
    ['Gross profit', r.before.grossProfit, r.after.grossProfit, r.change.grossProfit, 'money'],
    ['Gross margin', r.before.grossMarginPercent ?? '', r.after.grossMarginPercent ?? '', r.change.grossMarginPoints ?? '', 'pct'],
    ['Operating profit', r.before.operatingProfit, r.after.operatingProfit, r.change.operatingProfit, 'money'],
    ['Operating margin', r.before.operatingMarginPercent ?? '', r.after.operatingMarginPercent ?? '', r.change.operatingMarginPoints ?? '', 'pct'],
    ['Net profit', r.before.netProfit, r.after.netProfit, r.change.netProfit, 'money'],
    ['Net margin', r.before.netMarginPercent ?? '', r.after.netMarginPercent ?? '', r.change.netMarginPoints ?? '', 'pct'],
    ['Cash at the end', r.before.closingCash, r.after.closingCash, r.change.closingCash, 'money'],
    ['Lowest cash', r.before.lowestCash.amount, r.after.lowestCash.amount, r.change.lowestCash, 'money'],
  ];
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="What the changes do" description={`Over the next ${H} months, against carrying on as is. Played forward from the posted books with the digital twin; hypothetical, nothing is posted.`} />
        <div className="space-y-4 px-5 pb-5">
          <p className="text-sm" data-testid="impact-summary">{r.summary}</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Change in net profit" value={<Money value={r.change.netProfit} currency={currency} signed />} sub={`Over ${H} months`} tone={tone(r.change.netProfit)} />
            <Stat label="Change in revenue" value={<Money value={r.change.revenue} currency={currency} signed />} sub={`Gross margin ${pts(r.change.grossMarginPoints)}`} tone={tone(r.change.revenue)} />
            <Stat label="Change in cash at the end" value={<Money value={r.change.closingCash} currency={currency} signed />} sub={r.payback.status === 'NO_OUTLAY' ? 'No cash outlay' : `${PAYBACK[r.payback.status]}${r.payback.month ? ` by ${monthLabel(r.payback.month)}` : ''}`} tone={tone(r.change.closingCash)} />
            <Stat label="Lowest cash" value={<Money value={r.after.lowestCash.amount} currency={currency} signed />} sub={r.after.cashNegativeFrom ? `Runs out in ${monthLabel(r.after.cashNegativeFrom)}` : monthLabel(r.after.lowestCash.month)} tone={r.after.cashNegativeFrom ? 'negative' : 'neutral'} />
          </div>
          <TwinCashChart actual={actual} series={[{ name: 'Carrying on as is', months: asis as never }, { name: 'With the changes', months: withChanges as never }]} currency={currency} label="Month-end cash: actual months, then the projection carrying on as is and with the changes. The same figures are in the month-by-month table." />
        </div>
      </Card>

      <Card>
        <CardHeader title="Before and after" description={`Totals over ${H} months. Margins are shares of revenue; their change is in percentage points.`} />
        <Table aria-label="Before and after">
          <thead>
            <tr>
              <Th>Figure</Th>
              <Th numeric>Carrying on as is</Th>
              <Th numeric>With the changes</Th>
              <Th numeric>Change</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, b, a, d, kind]) => (
              <Tr key={label}>
                <Td className="font-medium">{label}</Td>
                {kind === 'money' ? (
                  <>
                    <Td numeric><Money value={b} currency={currency} signed /></Td>
                    <Td numeric><Money value={a} currency={currency} signed /></Td>
                    <Td numeric><Money value={d} currency={currency} signed /></Td>
                  </>
                ) : (
                  <>
                    <Td numeric>{b ? `${b}%` : '—'}</Td>
                    <Td numeric>{a ? `${a}%` : '—'}</Td>
                    <Td numeric>{pts(d || null)}</Td>
                  </>
                )}
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card>
        <CardHeader title="Each change, and how it reaches the figures" description="Each change on its own against carrying on as is: how it is worked out from your books, and every line of the statements it moves." />
        <div className="space-y-4 px-5 pb-5">
          {r.changes.map((c) => (
            <section key={c.index} aria-label={`Change ${c.index}: ${c.title}`} className="rounded-[var(--t2t-radius-md)] border border-border p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-medium">{c.index}. {c.title} <Badge tone="neutral">{AREA_LABEL[c.area]}</Badge></h3>
                <PaybackText p={c.payback} currency={currency} />
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-fg-muted">{c.explanation.map((e) => <li key={e}>{e}</li>)}</ul>
              {c.lines.length ? (
                <Table aria-label={`Lines moved by change ${c.index}`} className="mt-3">
                  <thead>
                    <tr>
                      <Th>Line</Th>
                      <Th numeric>Change over {H} months</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.lines.map((l) => (
                      <Tr key={l.key}>
                        <Td className={l.key === 'netProfit' || l.key === 'closingCash' ? 'font-medium' : ''}>{l.label}</Td>
                        <Td numeric><Money value={l.change} currency={currency} signed /></Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <p className="mt-2 text-sm text-fg-muted">It moves no figures over this horizon.</p>
              )}
            </section>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="By business area" description="Each area’s changes together, on their own. When changes in different areas affect each other, the difference from the combined effect is shown as interaction." />
        <Table aria-label="By business area">
          <thead>
            <tr>
              <Th>Area</Th>
              <Th>Changes</Th>
              <Th numeric>Revenue</Th>
              <Th numeric>Gross profit</Th>
              <Th numeric>Net profit</Th>
              <Th numeric>Cash at the end</Th>
            </tr>
          </thead>
          <tbody>
            {r.areas.map((a) => (
              <Tr key={a.area}>
                <Td className="font-medium">{a.label}</Td>
                <Td className="text-sm">{a.changes.join(', ')}</Td>
                <DeltaCells d={a.alone} currency={currency} />
              </Tr>
            ))}
            {r.areas.length > 1 ? (
              <Tr>
                <Td className="text-fg-muted">Interaction</Td>
                <Td />
                <Td />
                <Td />
                <Td numeric className="text-fg-muted"><Money value={r.interaction.netProfit} currency={currency} signed /></Td>
                <Td numeric className="text-fg-muted"><Money value={r.interaction.closingCash} currency={currency} signed /></Td>
              </Tr>
            ) : null}
            <Tr>
              <Td className="font-medium">All changes together</Td>
              <Td />
              <DeltaCells d={r.change} currency={currency} />
            </Tr>
          </tbody>
        </Table>
      </Card>

      <Card>
        <CardHeader title="Month by month" description="With the changes, against carrying on as is." />
        <Table aria-label="Month by month">
          <thead>
            <tr>
              <Th>Month</Th>
              <Th numeric>Revenue</Th>
              <Th numeric>As is</Th>
              <Th numeric>Net profit</Th>
              <Th numeric>As is</Th>
              <Th numeric>Month-end cash</Th>
              <Th numeric>As is</Th>
            </tr>
          </thead>
          <tbody>
            {r.months.map((m) => (
              <Tr key={m.month}>
                <Td>{monthLabel(m.month)}</Td>
                <Td numeric><Money value={m.revenueAfter} currency={currency} /></Td>
                <Td numeric className="text-fg-muted"><Money value={m.revenueBefore} currency={currency} /></Td>
                <Td numeric><Money value={m.netProfitAfter} currency={currency} signed /></Td>
                <Td numeric className="text-fg-muted"><Money value={m.netProfitBefore} currency={currency} signed /></Td>
                <Td numeric className="font-medium"><Money value={m.cashAfter} currency={currency} signed /></Td>
                <Td numeric className="text-fg-muted"><Money value={m.cashBefore} currency={currency} signed /></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card>
        <CardHeader title="Assumptions" />
        <ul className="list-disc space-y-1 px-5 pb-5 pl-9 text-sm text-fg-muted">{r.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
      </Card>
    </div>
  );
}
