'use client';
import type { KeyboardEvent } from 'react';
import { money } from '@/lib/format';

export type DependencyGroup = 'CUSTOMERS' | 'VENDORS' | 'CASH' | 'BORROWING';
export type DependencySeverity = 'CRITICAL' | 'HIGH' | 'WATCH';
export interface DependencyPartyView { id: string; name: string; amount: string; share: number }
export interface DependencyGroupView {
  group: DependencyGroup;
  total: string;
  count: number;
  hhi: number;
  concentration: 'LOW' | 'MODERATE' | 'HIGH' | null;
  largestShare: number | null;
  parties: DependencyPartyView[];
  others: { count: number; amount: string; share: number };
}
export interface Dependency { group: DependencyGroup; id: string; name: string; share: number; amount: string; severity: DependencySeverity; reason: string }
export interface Dependencies { currency: string; from: string; to: string; fromDate: string; toDate: string; groups: Record<DependencyGroup, DependencyGroupView>; dependencies: Dependency[] }

export const GROUP: Record<DependencyGroup, { label: string; flow: string; colour: string }> = {
  CUSTOMERS: { label: 'Customers', flow: 'Revenue from', colour: '#38bdf8' },
  VENDORS: { label: 'Vendors', flow: 'Spending with', colour: '#a78bfa' },
  CASH: { label: 'Cash and bank', flow: 'Cash held in', colour: '#34d399' },
  BORROWING: { label: 'Lenders and cards', flow: 'Owed on', colour: '#fbbf24' },
};
export const SEVERITY: Record<DependencySeverity, { label: string; colour: string; tone: 'negative' | 'warning' | 'neutral' }> = {
  CRITICAL: { label: 'Critical', colour: '#f87171', tone: 'negative' },
  HIGH: { label: 'High', colour: '#fb923c', tone: 'warning' },
  WATCH: { label: 'Watch', colour: '#fbbf24', tone: 'neutral' },
};

export interface GraphPick { group: DependencyGroup; id: string; name: string; amount: string; share: number; others?: number }

const W = 1000; // not money: drawing units
const H = 600; // not money
const CX = W / 2; // not money
const CY = H / 2; // not money

/** Where each group's parties sit: customers left, vendors right, lenders above, cash below. */
function place(group: DependencyGroup, i: number, n: number): [number, number] {
  const spread = (span: number) => (n === 1 ? 0 : -span / 2 + (span * i) / (n - 1)); // not money
  if (group === 'CUSTOMERS') return [130, CY + spread(Math.min(460, n * 80))];
  if (group === 'VENDORS') return [W - 130, CY + spread(Math.min(460, n * 80))];
  if (group === 'BORROWING') return [CX + spread(Math.min(520, n * 170)), 60];
  return [CX + spread(Math.min(520, n * 170)), H - 60];
}

/**
 * The business at the centre with each party it depends on around it: customers paying in on the
 * left, vendors paid on the right, lenders above and cash accounts below. A line's width is the
 * party's share of its group; its colour says whether the share is a dependency to watch.
 * Choose a party (click, or Enter on the keyboard) to see its details. The tables below have
 * the same figures.
 */
export function DependencyGraph({ d, shown, picked, onPick }: { d: Dependencies; shown: DependencyGroup[]; picked: GraphPick | null; onPick: (p: GraphPick | null) => void }) {
  const severity = new Map(d.dependencies.map((x) => [`${x.group}:${x.id}`, x.severity]));
  const nodes = shown.flatMap((g) => {
    const v = d.groups[g];
    const items: GraphPick[] = v.parties.map((p) => ({ group: g, id: p.id, name: p.name, amount: p.amount, share: p.share }));
    if (v.others.count) items.push({ group: g, id: `others-${g}`, name: `${v.others.count} other${v.others.count === 1 ? '' : 's'}`, amount: v.others.amount, share: v.others.share, others: v.others.count });
    return items.map((p, i) => ({ ...p, at: place(g, i, items.length) }));
  });
  const key = (p: { group: string; id: string }) => `${p.group}:${p.id}`;
  const isPicked = (p: GraphPick) => !!picked && key(picked) === key(p);
  const press = (p: GraphPick) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onPick(isPicked(p) ? null : p);
    }
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="A network of who the business depends on: customers, vendors, cash accounts and lenders, with lines as wide as each share. The same figures are in the tables below.">
      {nodes.map((n) => {
        const sev = severity.get(key(n));
        const faded = picked && !isPicked(n);
        return <line key={`l-${key(n)}`} x1={n.at[0]} y1={n.at[1]} x2={CX} y2={CY} stroke={sev ? SEVERITY[sev].colour : GROUP[n.group].colour} strokeOpacity={faded ? 0.15 : sev ? 0.85 : 0.45} strokeWidth={2 + (n.share / 100) * 22} strokeLinecap="round" />;
      })}
      <g>
        <circle cx={CX} cy={CY} r={56} fill="var(--t2t-surface-raised)" stroke="var(--t2t-accent)" strokeWidth={2} />
        <text x={CX} y={CY - 4} textAnchor="middle" fontSize={15} fontWeight={600} fill="var(--t2t-text)">Your business</text>
        <text x={CX} y={CY + 16} textAnchor="middle" fontSize={11} fill="var(--t2t-text-muted)">{money(d.groups.CUSTOMERS.total, d.currency)} in</text>
      </g>
      {shown.filter((g) => d.groups[g].count > 0).map((g) => {
        const [x, y] = g === 'CUSTOMERS' ? [130, 22] : g === 'VENDORS' ? [W - 130, 22] : g === 'BORROWING' ? [70, 64] : [70, H - 56];
        return <text key={`h-${g}`} x={x} y={y} textAnchor="middle" fontSize={12} fontWeight={600} fill={GROUP[g].colour}>{GROUP[g].label}</text>;
      })}
      {nodes.map((n) => {
        const sev = severity.get(key(n));
        const r = 10 + Math.sqrt(n.share) * 2.2; // not money: radius from a share
        const left = n.group === 'CUSTOMERS';
        const right = n.group === 'VENDORS';
        const label = n.name.length > 26 ? `${n.name.slice(0, 25)}…` : n.name;
        return (
          <g
            key={`n-${key(n)}`}
            role="button"
            tabIndex={0}
            aria-pressed={isPicked(n)}
            aria-label={`${GROUP[n.group].flow} ${n.name}: ${money(n.amount, d.currency)}, ${n.share}%${sev ? `, ${SEVERITY[sev].label.toLowerCase()} dependency` : ''}`}
            className="cursor-pointer focus:outline-none"
            onClick={() => onPick(isPicked(n) ? null : n)}
            onKeyDown={press(n)}
            opacity={picked && !isPicked(n) ? 0.45 : 1}
          >
            <circle cx={n.at[0]} cy={n.at[1]} r={r} fill={GROUP[n.group].colour} fillOpacity={n.others ? 0.35 : 0.85} stroke={isPicked(n) ? 'var(--t2t-text)' : sev ? SEVERITY[sev].colour : 'var(--t2t-surface)'} strokeWidth={isPicked(n) || sev ? 3 : 2} />
            <text x={left ? n.at[0] - r - 6 : right ? n.at[0] + r + 6 : n.at[0]} y={left || right ? n.at[1] - 2 : n.group === 'BORROWING' ? n.at[1] - r - 16 : n.at[1] + r + 14} textAnchor={left ? 'end' : right ? 'start' : 'middle'} fontSize={12} fill="var(--t2t-text)">{label}</text>
            <text x={left ? n.at[0] - r - 6 : right ? n.at[0] + r + 6 : n.at[0]} y={left || right ? n.at[1] + 13 : n.group === 'BORROWING' ? n.at[1] - r - 3 : n.at[1] + r + 28} textAnchor={left ? 'end' : right ? 'start' : 'middle'} fontSize={11} fill="var(--t2t-text-muted)">{n.share}%</text>
          </g>
        );
      })}
    </svg>
  );
}
