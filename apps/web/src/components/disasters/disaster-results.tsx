'use client';
import { Badge, Card, CardHeader, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import { Money } from '@/components/money';
import { TwinCashChart } from '@/components/twin/twin-chart';
import { VERDICT, type DisasterResult } from '@/lib/disasters';
import { monthLabel } from '@/lib/twin';

/** What the shocks do: the verdict, cash with and without them, each shock on its own, and every month. */
export function DisasterResults({ r, actual, currency }: { r: DisasterResult; actual: { month: string; cash: string }[]; currency: string }) {
  const i = r.impact;
  const v = VERDICT[i.verdict];
  const months = r.stressed.projection.months;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={<span className="flex items-center gap-2">What happens <Badge tone={v.tone}>{v.label}</Badge></span>} description="Played forward from the posted books with the digital twin. Hypothetical: nothing is posted." />
        <div className="space-y-4 px-5 pb-5">
          <p className="text-sm" data-testid="disaster-summary">{r.summary}</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Lowest cash" value={<Money value={i.lowestCash.amount} currency={currency} signed />} sub={monthLabel(i.lowestCash.month)} tone={i.verdict === 'SURVIVES' ? 'neutral' : 'negative'} />
            <Stat label="Most cash lost" value={<Money value={i.largestCashGap.amount} currency={currency} signed />} sub={`Against no shock, in ${monthLabel(i.largestCashGap.month)}`} tone={i.largestCashGap.amount.startsWith('-') ? 'negative' : 'neutral'} />
            <Stat label="Change in profit" value={<Money value={i.profitChange} currency={currency} signed />} sub={`Over ${months.length} months`} tone={i.profitChange.startsWith('-') ? 'negative' : 'neutral'} />
            <Stat label="Cash to raise" value={<Money value={i.cashRequired} currency={currency} />} sub={i.cashNegativeFrom ? `Runs out in ${monthLabel(i.cashNegativeFrom)}` : 'To stay at or above the minimum balance'} tone={Number(i.cashRequired) > 0 ? 'negative' : 'neutral'} />
          </div>
          <TwinCashChart actual={actual} series={[{ name: 'No shock', months: r.noShock.months }, { name: 'With the shocks', months }]} currency={currency} label="Month-end cash: actual months, then the projection with no shock and with the shocks. The same figures are in the table below." />
        </div>
      </Card>

      <Card>
        <CardHeader title="Each shock on its own" description="How each shock moves cash and profit if it happened alone. Together they can be worse than the sum." />
        <Table aria-label="Each shock on its own">
          <thead>
            <tr>
              <Th>Shock</Th>
              <Th>How it is worked out</Th>
              <Th numeric>Lowest cash</Th>
              <Th numeric>Most cash lost</Th>
              <Th numeric>Change in profit</Th>
              <Th>Result</Th>
            </tr>
          </thead>
          <tbody>
            {r.shocks.map((s) => (
              <Tr key={s.index}>
                <Td className="font-medium">{s.index}. {s.title}</Td>
                <Td><ul className="max-w-[460px] list-disc space-y-1 pl-4 text-xs text-fg-muted">{s.explanation.map((e) => <li key={e}>{e}</li>)}</ul></Td>
                <Td numeric><Money value={s.alone.lowestCash.amount} currency={currency} signed /></Td>
                <Td numeric><Money value={s.alone.largestCashGap.amount} currency={currency} signed /><p className="text-xs text-fg-muted">{monthLabel(s.alone.largestCashGap.month)}</p></Td>
                <Td numeric><Money value={s.alone.profitChange} currency={currency} signed /></Td>
                <Td><Badge tone={VERDICT[s.alone.verdict].tone}>{VERDICT[s.alone.verdict].label}</Badge></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card>
        <CardHeader title="Month by month" description="With the shocks, against no shock." />
        <Table aria-label="Month by month">
          <thead>
            <tr>
              <Th>Month</Th>
              <Th numeric>Revenue</Th>
              <Th numeric>Net profit</Th>
              <Th numeric>Cash flow</Th>
              <Th numeric>Month-end cash</Th>
              <Th numeric>No shock</Th>
            </tr>
          </thead>
          <tbody>
            {months.map((m, k) => (
              <Tr key={m.month}>
                <Td>{monthLabel(m.month)}</Td>
                <Td numeric><Money value={m.revenue} currency={currency} /></Td>
                <Td numeric><Money value={m.netProfit} currency={currency} signed /></Td>
                <Td numeric><Money value={m.cashFlow} currency={currency} signed /></Td>
                <Td numeric className="font-medium"><Money value={m.closingCash} currency={currency} signed /></Td>
                <Td numeric className="text-fg-muted"><Money value={r.noShock.months[k]!.closingCash} currency={currency} signed /></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {r.stressed.assumptions.length ? (
        <Card>
          <CardHeader title="Assumptions" />
          <ul className="list-disc space-y-1 px-5 pb-5 pl-9 text-sm text-fg-muted">{r.stressed.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
        </Card>
      ) : null}
    </div>
  );
}
