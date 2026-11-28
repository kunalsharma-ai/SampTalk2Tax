'use client';
import type { KeyboardEvent } from 'react';
import { money } from '@/lib/format';

export type CashFlowGroup = 'CUSTOMERS' | 'VENDORS' | 'PAYROLL' | 'TAX' | 'FINANCING' | 'OWNERS' | 'ASSETS' | 'OTHER';
export interface CashFlowEdge {
  from: string;
  to: string;
  amount: string;
}
export interface CashFlowMonth {
  month: string;
  flows: CashFlowEdge[];
  inflow: string;
  outflow: string;
  net: string;
}
export interface CashNetworkNode {
  key: string;
  kind: 'CASH' | 'GROUP';
  name: string;
  inflow: string;
  outflow: string;
}
export interface CashFlowNetworkData {
  currency: string;
  from: string;
  to: string;
  fromDate: string;
  toDate: string;
  entries: number;
  nodes: CashNetworkNode[];
  months: CashFlowMonth[];
  total: CashFlowMonth;
}

export const CASH_GROUP: Record<CashFlowGroup, { label: string; colour: string }> = {
  CUSTOMERS: { label: 'Customers and income', colour: '#34d399' },
  VENDORS: { label: 'Vendors and spending', colour: '#a78bfa' },
  PAYROLL: { label: 'Payroll', colour: '#f472b6' },
  TAX: { label: 'Tax', colour: '#fbbf24' },
  FINANCING: { label: 'Lenders and interest', colour: '#fb923c' },
  OWNERS: { label: 'Owners', colour: '#38bdf8' },
  ASSETS: { label: 'Assets bought or sold', colour: '#a3e635' },
  OTHER: { label: 'Other', colour: '#94a3b8' },
};
const CASH_COLOUR = '#22d3ee';

/** A node's name for people: a cash account's own name, or its group's label. */
export function nodeName(key: string, nodes: CashNetworkNode[]): string {
  if (key.startsWith('group:')) return CASH_GROUP[key.slice(6) as CashFlowGroup]?.label ?? key.slice(6);
  return nodes.find((n) => n.key === key)?.name ?? key;
}

const W = 1000; // not money: drawing units
const TOP = 70; // not money
const BOTTOM = 60; // not money
const LEFT_X = 170; // not money
const MID_X = 500; // not money
const RIGHT_X = 830; // not money

const spread = (n: number, h: number) => (i: number) => (n === 1 ? h / 2 : TOP + ((h - TOP - BOTTOM) * i) / (n - 1)); // not money: positions

/**
 * Animated cash-flow network (DASH-024): money coming in from the groups on the left to each
 * cash or bank account in the middle, and going out to the groups on the right, for the month
 * chosen (or all months). A line's width is its share of the largest flow; its moving dashes run
 * the way the money goes (still under reduced motion). Money moved between cash accounts arcs on
 * the right of the middle column. Choose a node (click, or Enter) to pick out its flows.
 */
export function CashFlowNetwork({
  d,
  period,
  picked,
  onPick,
  animate,
}: {
  d: CashFlowNetworkData;
  period: CashFlowMonth;
  picked: string | null;
  onPick: (key: string | null) => void;
  animate: boolean;
}) {
  const cash = d.nodes.filter((n) => n.kind === 'CASH');
  const sources = d.nodes.filter((n) => n.kind === 'GROUP' && Number(n.outflow) > 0);
  const sinks = d.nodes.filter((n) => n.kind === 'GROUP' && Number(n.inflow) > 0);
  const H = Math.max(360, 80 * Math.max(cash.length, sources.length, sinks.length) + TOP + BOTTOM); // not money
  const at = new Map<string, [number, number]>();
  cash.forEach((n, i) => at.set(`mid:${n.key}`, [MID_X, spread(cash.length, H)(i)]));
  sources.forEach((n, i) => at.set(`left:${n.key}`, [LEFT_X, spread(sources.length, H)(i)]));
  sinks.forEach((n, i) => at.set(`right:${n.key}`, [RIGHT_X, spread(sinks.length, H)(i)]));
  const peak = Math.max(1, ...period.flows.map((f) => Number(f.amount))); // not money: drawing scale only
  const touches = (f: CashFlowEdge) => !picked || f.from === picked || f.to === picked;
  const press = (key: string) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onPick(picked === key ? null : key);
    }
  };
  const colourOf = (f: CashFlowEdge) =>
    f.from.startsWith('group:') ? CASH_GROUP[f.from.slice(6) as CashFlowGroup].colour : f.to.startsWith('group:') ? CASH_GROUP[f.to.slice(6) as CashFlowGroup].colour : CASH_COLOUR;
  const path = (f: CashFlowEdge) => {
    const a = f.from.startsWith('group:') ? at.get(`left:${f.from}`) : at.get(`mid:${f.from}`);
    const b = f.to.startsWith('group:') ? at.get(`right:${f.to}`) : at.get(`mid:${f.to}`);
    if (!a || !b) return null;
    if (a[0] === b[0]) {
      // Between two cash accounts: an arc out to the right and back.
      const bulge = 110 + Math.abs(b[1] - a[1]) / 4; // not money
      return `M ${a[0] + 22} ${a[1]} C ${a[0] + bulge} ${a[1]}, ${b[0] + bulge} ${b[1]}, ${b[0] + 22} ${b[1]}`;
    }
    const x1 = a[0] + (a[0] === LEFT_X ? 14 : 22); // not money
    const x2 = b[0] - (b[0] === RIGHT_X ? 14 : 22); // not money
    const mx = (x1 + x2) / 2; // not money
    return `M ${x1} ${a[1]} C ${mx} ${a[1]}, ${mx} ${b[1]}, ${x2} ${b[1]}`;
  };
  const node = (key: string, pos: [number, number] | undefined, label: string, sub: string, colour: string, side: 'left' | 'mid' | 'right', r: number) => {
    if (!pos) return null;
    const on = picked === key;
    const tx = side === 'left' ? pos[0] - r - 8 : side === 'right' ? pos[0] + r + 8 : pos[0];
    const anchor = side === 'left' ? 'end' : side === 'right' ? 'start' : 'middle';
    const ty = side === 'mid' ? pos[1] + r + 16 : pos[1] - 2;
    // The name starts with the words shown, so what a person sees is what a screen reader says.
    const shown = label.length > 28 ? `${label.slice(0, 27)}…` : label;
    return (
      <g
        key={`${side}-${key}`}
        role="button"
        tabIndex={0}
        aria-pressed={on}
        aria-label={`${shown} ${sub}`}
        aria-description={shown === label ? undefined : label}
        className="cursor-pointer focus:outline-none"
        onClick={() => onPick(on ? null : key)}
        onKeyDown={press(key)}
        opacity={picked && !on && !period.flows.some((f) => (f.from === picked && f.to === key) || (f.to === picked && f.from === key)) ? 0.4 : 1}
      >
        <circle cx={pos[0]} cy={pos[1]} r={r} fill={colour} fillOpacity={0.85} stroke={on ? 'var(--t2t-text)' : 'var(--t2t-surface)'} strokeWidth={on ? 3 : 2} />
        <text x={tx} y={ty} textAnchor={anchor} fontSize={12} fontWeight={600} fill="var(--t2t-text)">
          {shown}
        </text>
        <text x={tx} y={ty + 14} textAnchor={anchor} fontSize={11} fill="var(--t2t-text-muted)">
          {sub}
        </text>
      </g>
    );
  };
  const sum = (key: string, dir: 'in' | 'out') => period.flows.filter((f) => (dir === 'in' ? f.to === key : f.from === key)).reduce((t, f) => t + Number(f.amount), 0); // not money: label only, exact figures are in the table
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="group"
      aria-roledescription="chart"
      aria-label="Cash coming in from the groups on the left to each cash and bank account in the middle, and going out to the groups on the right, with lines as wide as each flow. The same flows are in the Cash flows table below."
    >
      <style>
        {
          '@keyframes t2t-cash-flow { to { stroke-dashoffset: -36; } } .t2t-cash-dash { animation: t2t-cash-flow 1.1s linear infinite; } @media (prefers-reduced-motion: reduce) { html:not([data-motion=full]) .t2t-cash-dash { animation: none; } } .t2t-cash-line { transition: stroke-width 0.5s ease, stroke-opacity 0.3s ease; } @media (prefers-reduced-motion: reduce) { html:not([data-motion=full]) .t2t-cash-line { transition: none; } }'
        }
      </style>
      <text x={LEFT_X} y={18} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--t2t-text-muted)">
        Money in from
      </text>
      <text x={MID_X} y={18} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--t2t-text-muted)">
        Cash and bank
      </text>
      <text x={RIGHT_X} y={18} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--t2t-text-muted)">
        Money out to
      </text>
      {period.flows.map((f) => {
        const p = path(f);
        if (!p) return null;
        const w = 2 + (Number(f.amount) / peak) * 22; // not money: line width
        const lit = touches(f);
        return (
          <g key={`${f.from}>${f.to}`}>
            <path d={p} fill="none" stroke={colourOf(f)} strokeOpacity={lit ? 0.35 : 0.06} strokeWidth={w} strokeLinecap="round" className="t2t-cash-line" />
            <path
              d={p}
              fill="none"
              stroke={colourOf(f)}
              strokeOpacity={lit ? 0.95 : 0.1}
              strokeWidth={Math.max(1.5, w / 3)}
              strokeDasharray="6 12"
              strokeLinecap="round"
              className={animate ? 't2t-cash-dash t2t-cash-line' : 't2t-cash-line'}
            />
          </g>
        );
      })}
      {sources.map((n) =>
        node(n.key, at.get(`left:${n.key}`), nodeName(n.key, d.nodes), `${money(String(sum(n.key, 'out')), d.currency)} in`, CASH_GROUP[n.key.slice(6) as CashFlowGroup].colour, 'left', 12),
      )}
      {cash.map((n) => node(n.key, at.get(`mid:${n.key}`), n.name, `${money(String(sum(n.key, 'in')), d.currency)} in · ${money(String(sum(n.key, 'out')), d.currency)} out`, CASH_COLOUR, 'mid', 20))}
      {sinks.map((n) =>
        node(n.key, at.get(`right:${n.key}`), nodeName(n.key, d.nodes), `${money(String(sum(n.key, 'in')), d.currency)} out`, CASH_GROUP[n.key.slice(6) as CashFlowGroup].colour, 'right', 12),
      )}
    </svg>
  );
}
