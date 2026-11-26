'use client';
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { money } from '@/lib/format';
import { clampPitch, project, towers, type View3D } from '@/lib/surface-3d';
import { monthLabel } from '@/components/reports/financial-visuals';

export type LandscapeView = 'EXPENSES' | 'REVENUE';
export interface LandscapeRow {
  key: string;
  label: string;
  accountIds: string[];
  values: string[];
  total: string;
}
export interface FinancialLandscapeData {
  currency: string;
  from: string;
  to: string;
  fromDate: string;
  toDate: string;
  view: LandscapeView;
  months: string[];
  rows: LandscapeRow[];
  monthTotals: string[];
  total: string;
  peak: { row: string; month: string; amount: string } | null;
  busiestMonth: string | null;
}

const HUES = [190, 158, 265, 330, 38, 210, 95, 15, 285, 55, 175, 240, 0, 120, 300]; // not money: colours
export const rowColour = (i: number, light = 58) => `hsl(${HUES[i % HUES.length]} 70% ${light}%)`;

const W = 1000; // not money: drawing units
const H = 640; // not money
const CX = W / 2; // not money
const CY = H / 2 + 5; // not money
const SIZE = 420; // not money

/**
 * The financial landscape (DASH-023): one row of towers per account (largest at the front), one
 * column per month, each tower as tall as the amount. Drag to turn it, or use the arrow keys when
 * it has focus. While the months play, months not reached yet lie flat, so the landscape grows
 * over time. Every figure is in the table below.
 */
export function Landscape3D({ d, upTo, view, onView, mark }: { d: FinancialLandscapeData; upTo: number; view: View3D; onView: (v: View3D) => void; mark: { row: number; col: number } | null }) {
  const drag = useRef<{ x: number; y: number; view: View3D } | null>(null);
  const all = d.rows.map((r) => r.values.map(Number));
  const peak = Math.max(1e-9, ...all.flat().map(Math.abs));
  const shown = all.map((row) => row.map((v, i) => (i <= upTo ? v : 0)));
  const list = towers(shown, view, SIZE, CX, CY, { peak, footprint: 0.62 });
  const floor = (x: number, y: number) => project(x, y, -0.35, view, SIZE, CX, CY);
  const corners = [floor(-0.5, -0.5), floor(0.5, -0.5), floor(0.5, 0.5), floor(-0.5, 0.5)];
  const turn = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 15 : 5;
    const next =
      e.key === 'ArrowLeft'
        ? { ...view, yaw: view.yaw - step }
        : e.key === 'ArrowRight'
          ? { ...view, yaw: view.yaw + step }
          : e.key === 'ArrowUp'
            ? { ...view, pitch: clampPitch(view.pitch + step) }
            : e.key === 'ArrowDown'
              ? { ...view, pitch: clampPitch(view.pitch - step) }
              : null;
    if (next) {
      e.preventDefault();
      onView(next);
    }
  };
  const down = (e: PointerEvent<SVGSVGElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, view };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const s = drag.current;
    if (s) onView({ yaw: s.view.yaw + (e.clientX - s.x) * 0.4, pitch: clampPitch(s.view.pitch + (e.clientY - s.y) * 0.3) });
  };
  const cols = d.months.length;
  const rows = d.rows.length;
  return (
    <div
      tabIndex={0}
      role="group"
      aria-label="Turn the landscape: arrow keys turn and tilt it, hold Shift for bigger steps"
      onKeyDown={turn}
      className="rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full touch-none select-none"
        role="img"
        aria-label={`${d.view === 'REVENUE' ? 'Income' : 'Spending'} by account and month as a landscape of towers, each as tall as the amount, up to ${monthLabel(d.months[upTo])}. Every figure is in the Landscape figures table.`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        style={{ cursor: 'grab' }}
      >
        <polygon points={corners.map((p) => `${p.x},${p.y}`).join(' ')} fill="var(--t2t-surface-raised)" stroke="var(--t2t-border)" />
        {d.months.map((m, i) =>
          i % Math.max(1, Math.ceil(cols / 6)) === 0 || i === cols - 1 ? (
            <text key={`m-${m}`} x={floor(-0.5 + (i + 0.5) / cols, 0.52).x} y={floor(-0.5 + (i + 0.5) / cols, 0.52).y + 16} textAnchor="middle" fontSize={11} fill="var(--t2t-text-muted)">
              {monthLabel(m)}
            </text>
          ) : null,
        )}
        {list.map((t) => {
          const on = mark && mark.row === t.yi && mark.col === t.xi;
          const future = t.xi > upTo;
          const flat = all[t.yi][t.xi] === 0;
          return (
            <g key={`${t.xi}-${t.yi}`} opacity={future || flat ? 0.2 : mark && !on ? 0.55 : 1}>
              {(flat ? t.faces.filter((f) => f.face === 'top') : t.faces).map((f, k) => (
                <polygon
                  key={k}
                  points={f.points.map((p) => `${p.x},${p.y}`).join(' ')}
                  fill={rowColour(t.yi, f.face === 'top' ? 62 : f.face === 'side-x' ? 46 : 38)}
                  stroke={on ? 'var(--t2t-text)' : 'var(--t2t-surface)'}
                  strokeWidth={on ? 2 : 0.6}
                />
              ))}
              <title>{`${d.rows[t.yi].label}, ${monthLabel(d.months[t.xi])}: ${money(d.rows[t.yi].values[t.xi], d.currency)}`}</title>
            </g>
          );
        })}
        {d.rows.map((r, i) => {
          const p = floor(0.53, -0.5 + (i + 0.5) / rows);
          return (
            <text key={`r-${r.key}`} x={p.x + 6} y={p.y + 4} fontSize={11} fill={rowColour(i, 70)}>
              {r.label.length > 24 ? `${r.label.slice(0, 23)}…` : r.label}
            </text>
          );
        })}
        <text
          x={20}
          y={30}
          fontSize={13}
          fontWeight={600}
          fill="var(--t2t-text)"
        >{`${d.view === 'REVENUE' ? 'Income' : 'Spending'} · ${monthLabel(d.months[0])} to ${monthLabel(d.months[upTo])}`}</text>
        <text x={20} y={50} fontSize={12} fill="var(--t2t-text-muted)">{`Tallest tower ${money(String(peak), d.currency)}`}</text>
      </svg>
    </div>
  );
}
