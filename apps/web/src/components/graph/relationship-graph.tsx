'use client';
import { useState, type KeyboardEvent } from 'react';
import { type GraphNeighbourhood, type GraphNodeType, NODE_TYPE_LABEL, relationLabel } from '@/lib/graph';
import { GRAPH_SIZE, type PlacedEdge, radialLayout } from '@/lib/graph-layout';

export const NODE_COLOUR: Record<GraphNodeType, string> = {
  CONTACT: '#38bdf8',
  DOCUMENT: '#818cf8',
  PAYMENT: '#34d399',
  JOURNAL: '#a78bfa',
  ACCOUNT: '#22d3ee',
  PROJECT: '#f472b6',
  DEPARTMENT: '#fb7185',
  LOAN: '#fbbf24',
  ASSET: '#a3e635',
  ALERT: '#f87171',
};

const { width: W, height: H } = GRAPH_SIZE;
const CX = W / 2; // not money: drawing units
const CY = H / 2; // not money
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Financial relationship graph (DASH-026): the chosen record in the centre and what it is
 * connected to around it, one sector per kind of connection, coloured by kind of record. Point
 * at or focus a record to read why it is connected; choose it (click, or Enter) to walk to it and
 * see its own connections. The same connections are listed, with their reasons, below.
 */
export function RelationshipGraph({ hood, onWalk }: { hood: GraphNeighbourhood; onWalk: (e: PlacedEdge) => void }) {
  const layout = radialLayout(hood.edges, hood.more);
  const [active, setActive] = useState<PlacedEdge | null>(null);
  const key = (e: PlacedEdge) => `${e.relation}:${e.node.type}:${e.node.id}`;
  const types = [...new Set(layout.nodes.map((n) => n.node.type))];
  const press = (e: PlacedEdge) => (ev: KeyboardEvent) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      onWalk(e);
    }
  };
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`A network of ${hood.node.label} and the ${layout.nodes.length} records drawn around it, grouped by how they are connected. Every connection is also listed with its reason in the lists below.`}
      >
        {layout.sectors
          .filter((s) => s.end > s.start && layout.sectors.length > 1)
          .map((s) => (
            <line key={`sep-${s.relation}`} x1={CX} y1={CY} x2={CX + 300 * Math.cos(s.start)} y2={CY + 300 * Math.sin(s.start)} stroke="var(--t2t-border)" strokeDasharray="3 6" />
          ))}
        {layout.nodes.map((n) => (
          <line
            key={`l-${key(n)}`}
            x1={CX}
            y1={CY}
            x2={n.x}
            y2={n.y}
            stroke={NODE_COLOUR[n.node.type]}
            strokeOpacity={active ? (key(active) === key(n) ? 0.95 : 0.12) : 0.45}
            strokeWidth={active && key(active) === key(n) ? 3 : 1.5}
            className="transition-[stroke-opacity] duration-200 motion-reduce:transition-none"
          />
        ))}
        {layout.sectors
          .filter((s) => s.shown > 0)
          .map((s) => (
            <text
              key={`s-${s.relation}`}
              x={s.labelX}
              y={s.labelY}
              textAnchor={s.labelX < CX - 40 ? 'end' : s.labelX > CX + 40 ? 'start' : 'middle'}
              fontSize={13}
              fontWeight={600}
              fill="var(--t2t-text-muted)"
            >
              {relationLabel(s.relation)}
              {s.hidden ? ` (+${s.hidden})` : ''}
            </text>
          ))}
        <g>
          <circle cx={CX} cy={CY} r={58} fill="var(--t2t-surface-raised)" stroke={NODE_COLOUR[hood.node.type]} strokeWidth={3} />
          <text x={CX} y={CY - 4} textAnchor="middle" fontSize={14} fontWeight={600} fill="var(--t2t-text)">
            {short(hood.node.label, 18)}
          </text>
          <text x={CX} y={CY + 16} textAnchor="middle" fontSize={11} fill="var(--t2t-text-muted)">
            {NODE_TYPE_LABEL[hood.node.type]}
          </text>
        </g>
        {layout.nodes.map((n) => {
          const on = !!active && key(active) === key(n);
          return (
            <g
              key={`n-${key(n)}`}
              role="button"
              tabIndex={0}
              aria-label={`${NODE_TYPE_LABEL[n.node.type]} ${n.node.label}: ${n.explanation} Explore its connections.`}
              className="cursor-pointer focus:outline-none"
              onMouseEnter={() => setActive(n)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(n)}
              onBlur={() => setActive(null)}
              onClick={() => onWalk(n)}
              onKeyDown={press(n)}
              opacity={active && !on ? 0.5 : 1}
            >
              <circle cx={n.x} cy={n.y} r={on ? 13 : 10} fill={NODE_COLOUR[n.node.type]} fillOpacity={0.9} stroke={on ? 'var(--t2t-text)' : 'var(--t2t-surface)'} strokeWidth={on ? 3 : 2} />
              <text x={n.x} y={n.y + 28} textAnchor="middle" fontSize={12} fill="var(--t2t-text)">
                {short(n.node.label, 20)}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="min-h-[2.5rem] px-5 text-sm text-fg-muted" aria-live="polite" data-testid="graph-reason">
        {active ? (
          <>
            <span className="font-medium text-fg">{`${active.node.label} · ${relationLabel(active.relation)}`}</span>
            {`: ${active.explanation}`}
          </>
        ) : (
          'Point at a record to see why it is connected; choose it to walk to its own connections.'
        )}
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 px-5 pb-4 text-xs text-fg-muted" aria-label="Kinds of record">
        {types.map((t) => (
          <li key={t} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: NODE_COLOUR[t] }} aria-hidden="true" />
            {NODE_TYPE_LABEL[t]}
          </li>
        ))}
        {layout.hidden ? <li>{`${layout.hidden} more not drawn: see the lists below`}</li> : null}
      </ul>
    </div>
  );
}
