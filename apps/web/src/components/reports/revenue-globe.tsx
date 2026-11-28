'use client';
import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { money } from '@/lib/format';
import { bubbleRadius, clampLat, graticule, orthographic, wrapLon, type GlobeView } from '@/lib/globe';
import { coast } from '@/lib/motion';

export interface GlobePlace {
  key: string;
  kind: 'COUNTRY' | 'STATE' | 'UNPLACED';
  code: string | null;
  name: string;
  country: string | null;
  lat: number | null;
  lon: number | null;
  amount: string;
  share: string;
  customers: number;
  values: string[];
}
export interface RevenueGlobeData {
  currency: string;
  from: string;
  to: string;
  fromDate: string;
  toDate: string;
  homeCountry: string;
  months: string[];
  places: GlobePlace[];
  monthTotals: string[];
  total: string;
  home: string;
  abroad: string;
  abroadShare: string;
  countries: number;
  customers: number;
}

const W = 760; // not money: drawing units
const H = 560; // not money
const CX = W / 2; // not money
const CY = H / 2; // not money
const R = 240; // not money

/** The amount of a place in the period shown: one month, or all months when `month` is null. */
export const placeAmount = (p: GlobePlace, month: number | null) => (month === null ? p.amount : p.values[month]);

/**
 * The revenue globe (DASH-025): one bubble per place, its area in proportion to the revenue
 * earned there, on a globe you can turn by dragging or with the arrow keys. Places on the far
 * side are hidden; places with no position are listed in the table only.
 */
export function RevenueGlobe({
  d,
  month,
  periodLabel,
  view,
  onView,
  selected,
}: {
  d: RevenueGlobeData;
  month: number | null;
  periodLabel: string;
  view: GlobeView;
  onView: (v: GlobeView) => void;
  selected: string | null;
}) {
  const drag = useRef<{ x: number; y: number; view: GlobeView; last: { x: number; y: number; t: number }; speed: [number, number] } | null>(null);
  // A flung globe keeps turning and slows to a stop (not when motion is reduced).
  const coasting = useRef<() => void>(() => {});
  const live = useRef(view);
  live.current = view;
  useEffect(() => () => coasting.current(), []);
  const placed = d.places.filter((p) => p.lat !== null && p.lon !== null);
  const largest = Math.max(0, ...placed.map((p) => Number(placeAmount(p, month)))); // not money: drawing only
  const step = 2 / view.zoom; // not money: degrees per pixel
  const turn = (e: KeyboardEvent) => {
    const by = (e.shiftKey ? 15 : 5) / view.zoom; // not money
    const next =
      e.key === 'ArrowLeft'
        ? { ...view, lon: wrapLon(view.lon - by) }
        : e.key === 'ArrowRight'
          ? { ...view, lon: wrapLon(view.lon + by) }
          : e.key === 'ArrowUp'
            ? { ...view, lat: clampLat(view.lat + by) }
            : e.key === 'ArrowDown'
              ? { ...view, lat: clampLat(view.lat - by) }
              : null;
    if (next) {
      e.preventDefault();
      coasting.current();
      onView(next);
    }
  };
  const down = (e: PointerEvent<SVGSVGElement>) => {
    coasting.current();
    drag.current = { x: e.clientX, y: e.clientY, view, last: { x: e.clientX, y: e.clientY, t: e.timeStamp }, speed: [0, 0] };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const s = drag.current;
    if (!s) return;
    const dt = Math.max(1, e.timeStamp - s.last.t); // not money: milliseconds
    // Degrees per frame (about 16 ms) at the speed the pointer is moving.
    s.speed = [(-(e.clientX - s.last.x) * step * 0.5 * 16) / dt, ((e.clientY - s.last.y) * step * 0.5 * 16) / dt]; // not money
    s.last = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    onView({ ...s.view, lon: wrapLon(s.view.lon - (e.clientX - s.x) * step * 0.5), lat: clampLat(s.view.lat + (e.clientY - s.y) * step * 0.5) });
  };
  const up = (e: PointerEvent<SVGSVGElement>) => {
    const s = drag.current;
    drag.current = null;
    // Only a pointer still moving when let go sets the globe coasting.
    if (!s || e.timeStamp - s.last.t > 80) return;
    coasting.current = coast(s.speed, ([dlon, dlat]) => {
      const v = live.current;
      onView({ ...v, lon: wrapLon(v.lon + dlon), lat: clampLat(v.lat + dlat) });
    });
  };
  const bubbles = placed
    .map((p) => ({ p, at: orthographic(p.lat!, p.lon!, view, R, CX, CY), r: bubbleRadius(Number(placeAmount(p, month)), largest) })) // not money: drawing only
    .filter((b) => b.at.visible && b.r > 0)
    .sort((a, b) => b.r - a.r);
  const labelled = new Set(bubbles.slice(0, 6).map((b) => b.p.key));
  if (selected) labelled.add(selected);
  return (
    <div
      tabIndex={0}
      role="group"
      aria-label="Turn the globe: arrow keys turn it, hold Shift for bigger steps"
      onKeyDown={turn}
      className="rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mx-auto h-auto w-full max-w-3xl touch-none select-none"
        role="img"
        aria-label={`Revenue by where customers are, ${periodLabel}, as bubbles on a globe, each as large as the revenue earned there. Every figure is in the Revenue by place table.`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => (drag.current = null)}
        style={{ cursor: 'grab' }}
      >
        <defs>
          <radialGradient id="globe-shade" cx="40%" cy="35%" r="75%">
            <stop offset="0%" stopColor="var(--t2t-surface-raised)" />
            <stop offset="100%" stopColor="var(--t2t-surface)" />
          </radialGradient>
          <clipPath id="globe-clip">
            <rect x={0} y={0} width={W} height={H} />
          </clipPath>
        </defs>
        <g clipPath="url(#globe-clip)">
          <circle cx={CX} cy={CY} r={R * view.zoom} fill="url(#globe-shade)" stroke="var(--t2t-border)" />
          {graticule(view, R, CX, CY, view.zoom > 2 ? 5 : 30).map((p, i) => (
            <path key={i} d={p} fill="none" stroke="var(--t2t-border)" strokeWidth={0.6} opacity={0.7} />
          ))}
          {bubbles.map(({ p, at, r }) => {
            const on = selected === p.key;
            return (
              <g key={p.key} opacity={selected && !on ? 0.45 : 1}>
                <circle
                  cx={at.x}
                  cy={at.y}
                  r={r}
                  fill={p.kind === 'STATE' ? 'hsl(158 65% 50% / 0.55)' : 'hsl(200 75% 58% / 0.55)'}
                  stroke={on ? 'var(--t2t-text)' : p.kind === 'STATE' ? 'hsl(158 65% 60%)' : 'hsl(200 75% 68%)'}
                  strokeWidth={on ? 2.5 : 1.2}
                />
                <circle cx={at.x} cy={at.y} r={2} fill="var(--t2t-text)" />
                <title>{`${p.name}: ${money(placeAmount(p, month), d.currency)}`}</title>
              </g>
            );
          })}
          {bubbles
            .filter((b) => labelled.has(b.p.key))
            .map(({ p, at, r }) => (
              <text key={`l-${p.key}`} x={at.x + r + 4} y={at.y + 4} fontSize={12} fill="var(--t2t-text)" fontWeight={selected === p.key ? 600 : 400}>
                {p.name.length > 22 ? `${p.name.slice(0, 21)}…` : p.name}
              </text>
            ))}
        </g>
        <text x={16} y={26} fontSize={13} fontWeight={600} fill="var(--t2t-text)">{`Revenue · ${periodLabel}`}</text>
        <g fontSize={11} fill="var(--t2t-text-muted)">
          <circle cx={22} cy={H - 40} r={6} fill="hsl(200 75% 58% / 0.55)" stroke="hsl(200 75% 68%)" />
          <text x={34} y={H - 36}>
            Country
          </text>
          <circle cx={22} cy={H - 20} r={6} fill="hsl(158 65% 50% / 0.55)" stroke="hsl(158 65% 60%)" />
          <text x={34} y={H - 16}>
            State at home
          </text>
        </g>
      </svg>
    </div>
  );
}
