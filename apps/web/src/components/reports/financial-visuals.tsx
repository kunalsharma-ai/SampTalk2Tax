'use client';
import { chartSeries } from '@talk2tax/design-system';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Sankey, Tooltip, Treemap, XAxis, YAxis } from 'recharts';
import { money } from '@/lib/format';

export interface WaterfallStep { key: string; label: string; kind: 'START' | 'UP' | 'DOWN' | 'SUBTOTAL'; amount: string; from: string; to: string; accountIds: string[] }
export interface SankeyNode { key: string; label: string; kind: 'REVENUE' | 'INCOME' | 'GROUP' | 'EXPENSE' | 'PROFIT' | 'LOSS'; accountId: string | null }
export interface Visuals {
  from: string;
  to: string;
  fromDate: string;
  toDate: string;
  months: string[];
  currency: string;
  empty: boolean;
  accounts: { id: string; code: string; name: string; type: 'REVENUE' | 'EXPENSE'; total: string }[];
  waterfall: WaterfallStep[];
  sankey: { nodes: SankeyNode[]; links: { source: number; target: number; amount: string }[]; income: string; profit: string; leftOut: { accountId: string; amount: string }[] };
  heatmap: { months: string[]; max: string; rows: { accountId: string; code: string; name: string; total: string; cells: { month: string; amount: string; intensity: number }[] }[] };
  treemap: { total: string; groups: { key: string; label: string; amount: string; share: number; accounts: { accountId: string; code: string; name: string; amount: string; share: number }[] }[] };
}

const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const TIP = { background: 'var(--t2t-surface-raised)', border: '1px solid var(--t2t-border)', borderRadius: 10, fontSize: 12 };
const STEP_FILL: Record<WaterfallStep['kind'], string> = { START: chartSeries[0], SUBTOTAL: chartSeries[1], UP: chartSeries[2], DOWN: '#f87171' };
export const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });

/**
 * Revenue down to net profit as floating bars. The bars only place the marks (floats); every
 * figure shown comes from the API's strings. Choosing a bar opens the accounts behind it.
 */
export function WaterfallChart({ steps, currency, onPick }: { steps: WaterfallStep[]; currency: string; onPick: (s: WaterfallStep) => void }) {
  const rows = steps.map((s) => {
    const a = Number(s.from);
    const b = Number(s.to);
    return { label: s.label, base: Math.min(a, b), size: Math.abs(b - a), step: s }; // not money: bar geometry
  });
  return (
    <div className="h-80 w-full" role="img" aria-label="Waterfall from revenue to net profit. The same figures are in the table below the chart.">
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 24 }}>
          <CartesianGrid stroke="var(--t2t-border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={11} interval={0} angle={-20} textAnchor="end" height={48} />
          <YAxis stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} tickFormatter={(v) => compact.format(v)} width={56} />
          <Tooltip cursor={{ fill: 'rgba(14,165,233,0.08)' }} contentStyle={TIP} formatter={(_v, _n, item) => [money((item.payload as { step: WaterfallStep }).step.amount, currency), (item.payload as { step: WaterfallStep }).step.label]} labelFormatter={() => ''} />
          <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
          <Bar dataKey="size" stackId="w" radius={[4, 4, 4, 4]} isAnimationActive={!reduced()} animationDuration={700} cursor="pointer" onClick={(d) => onPick((d as unknown as { payload: { step: WaterfallStep } }).payload.step)}>
            {rows.map((r) => <Cell key={r.step.key} fill={STEP_FILL[r.step.kind]} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

const NODE_FILL: Record<SankeyNode['kind'], string> = { REVENUE: chartSeries[0], INCOME: chartSeries[1], GROUP: chartSeries[3], EXPENSE: chartSeries[4], PROFIT: chartSeries[2], LOSS: '#f87171' };

/** Where the period's income came from and where it went. Choosing an account opens its ledger. */
export function IncomeSankeyChart({ sankey, currency, onPick }: { sankey: Visuals['sankey']; currency: string; onPick: (n: SankeyNode) => void }) {
  if (!sankey.links.length) return <p className="px-4 pb-4 text-sm text-fg-muted">No income or spending in these months.</p>;
  const data = { nodes: sankey.nodes.map((n) => ({ name: n.label, node: n })), links: sankey.links.map((l) => ({ source: l.source, target: l.target, value: Number(l.amount), amount: l.amount })) };
  const Node = (p: { x: number; y: number; width: number; height: number; index: number; payload: { name: string; node: SankeyNode } }) => {
    const n = p.payload.node;
    const right = p.x > 400;
    return (
      <g cursor="pointer" onClick={() => onPick(n)}>
        <rect x={p.x} y={p.y} width={p.width} height={Math.max(p.height, 1)} rx={2} fill={NODE_FILL[n.kind]} />
        <text x={right ? p.x - 6 : p.x + p.width + 6} y={p.y + p.height / 2} textAnchor={right ? 'end' : 'start'} dominantBaseline="middle" fontSize={11} fill="var(--t2t-text)">
          {p.payload.name}
        </text>
      </g>
    );
  };
  return (
    <div className="h-96 w-full" role="img" aria-label={`Income of ${money(sankey.income, currency)} flowing to spending and ${Number(sankey.profit) >= 0 ? 'profit' : 'a loss'} of ${money(sankey.profit, currency)}. The flows are in the table below the chart.`}>
      <ResponsiveContainer>
        <Sankey data={data} nodePadding={18} nodeWidth={10} margin={{ top: 8, right: 140, bottom: 8, left: 8 }} link={{ stroke: 'var(--t2t-accent)', strokeOpacity: 0.22 }} node={Node as never}>
          <Tooltip contentStyle={TIP} formatter={(_v, name, item) => [money(String((item.payload as { payload?: { amount?: string } }).payload?.amount ?? _v), currency), name]} />
        </Sankey>
      </ResponsiveContainer>
    </div>
  );
}

/** Spending by account and month as a table whose cells are shaded by size; each cell opens that month's ledger. */
export function SpendHeatmap({ heatmap, currency, ledger }: { heatmap: Visuals['heatmap']; currency: string; ledger: (accountId: string, month?: string) => string }) {
  if (!heatmap.rows.length) return <p className="px-4 pb-4 text-sm text-fg-muted">No spending in these months.</p>;
  return (
    <div className="overflow-x-auto px-4 pb-4">
      <table className="w-full border-separate border-spacing-0.5 text-xs" aria-label="Spending by account and month">
        <thead>
          <tr>
            <th className="sticky left-0 bg-surface px-2 py-1 text-left font-medium text-fg-muted">Account</th>
            {heatmap.months.map((m) => <th key={m} className="px-1 py-1 text-center font-medium text-fg-muted">{monthLabel(m)}</th>)}
            <th className="px-2 py-1 text-right font-medium text-fg-muted">Total</th>
          </tr>
        </thead>
        <tbody>
          {heatmap.rows.map((r) => (
            <tr key={r.accountId}>
              <th scope="row" className="sticky left-0 whitespace-nowrap bg-surface px-2 py-1 text-left font-normal"><span className="num text-fg-muted">{r.code}</span> {r.name}</th>
              {r.cells.map((c) => (
                <td key={c.month} className="p-0">
                  <a
                    href={ledger(r.accountId, c.month)}
                    title={`${r.name}, ${monthLabel(c.month)}: ${money(c.amount, currency)}`}
                    aria-label={`${r.name}, ${monthLabel(c.month)}: ${money(c.amount, currency)}`}
                    className="block h-7 min-w-10 rounded transition-transform hover:scale-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none motion-reduce:hover:scale-100"
                    style={{ background: c.intensity > 0 ? `color-mix(in srgb, var(--t2t-accent) ${Math.round(12 + c.intensity * 78)}%, transparent)` : 'var(--t2t-surface-hover)' }}
                  />
                </td>
              ))}
              <td className="num whitespace-nowrap px-2 py-1 text-right">{money(r.total, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-fg-muted">Darker is more, up to {money(heatmap.max, currency)} in one month. The {heatmap.rows.length} largest expense accounts are shown.</p>
    </div>
  );
}

type TreeLeaf = { name: string; size: number; amount: string; share: number; accountId: string; group: number };

/** Spending by group and account, sized by amount. Choosing an account opens its ledger. */
export function SpendTreemap({ treemap, currency, onOpen }: { treemap: Visuals['treemap']; currency: string; onOpen: (accountId: string) => void }) {
  if (!treemap.groups.length) return <p className="px-4 pb-4 text-sm text-fg-muted">No spending in these months.</p>;
  const data = treemap.groups.map((g, gi) => ({ name: g.label, children: g.accounts.map((a) => ({ name: a.name, size: Number(a.amount), amount: a.amount, share: a.share, accountId: a.accountId, group: gi }) satisfies TreeLeaf) }));
  const Content = (p: { x: number; y: number; width: number; height: number; depth: number; name: string; group?: number; share?: number; accountId?: string }) => {
    if (p.depth !== 2) return <g />;
    const fill = chartSeries[(p.group ?? 0) % chartSeries.length];
    return (
      <g cursor="pointer" onClick={() => p.accountId && onOpen(p.accountId)}>
        <rect x={p.x} y={p.y} width={p.width} height={p.height} fill={fill} fillOpacity={0.75} stroke="var(--t2t-surface)" strokeWidth={2} rx={4} />
        {p.width > 70 && p.height > 30 ? (
          <>
            <text x={p.x + 6} y={p.y + 16} fontSize={11} fill="#0b1220" fontWeight={600}>{p.name.length > p.width / 7 ? `${p.name.slice(0, Math.floor(p.width / 7) - 1)}…` : p.name}</text>
            <text x={p.x + 6} y={p.y + 30} fontSize={10} fill="#0b1220">{p.share}%</text>
          </>
        ) : null}
      </g>
    );
  };
  return (
    <div className="h-80 w-full px-4 pb-4" role="img" aria-label={`Spending of ${money(treemap.total, currency)} by group and account. The same figures are in the table below the chart.`}>
      <ResponsiveContainer>
        <Treemap data={data} dataKey="size" isAnimationActive={!reduced()} animationDuration={600} content={Content as never}>
          <Tooltip contentStyle={TIP} formatter={(_v, _n, item) => { const leaf = item.payload as TreeLeaf; return [`${money(leaf.amount, currency)} (${leaf.share}%)`, leaf.name]; }} />
        </Treemap>
      </ResponsiveContainer>
    </div>
  );
}
