'use client';
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { money } from '@/lib/format';
import { clampPitch, project, surfaceColour, surfaceQuads, type View3D } from '@/lib/surface-3d';

export type SurfaceMeasure = 'NET_PROFIT' | 'EBITDA' | 'CLOSING_CASH' | 'MINIMUM_CASH';
export interface SurfaceAxisView {
  axis: string;
  label: string;
  unit: string;
  values: string[];
}
export interface SurfaceFrame {
  month: string;
  values: string[][];
  min: string;
  max: string;
}
export interface SurfaceCell {
  x: string;
  y: string;
  value: string;
}
export interface ScenarioSurfaceData {
  baselineMonths: number;
  actualFrom: string | null;
  actualTo: string | null;
  x: SurfaceAxisView;
  y: SurfaceAxisView;
  measure: SurfaceMeasure;
  currency: string;
  frames: SurfaceFrame[];
  current: string | null;
  best: SurfaceCell;
  worst: SurfaceCell;
  cashNegativeCells: number;
  runs: number;
}

export const MEASURE_LABEL: Record<SurfaceMeasure, string> = {
  NET_PROFIT: 'Net profit so far',
  EBITDA: 'EBITDA so far',
  CLOSING_CASH: 'Cash at month end',
  MINIMUM_CASH: 'Lowest cash so far',
};
export const axisValue = (v: string, unit: string) => `${Number(v) > 0 ? '+' : ''}${v}${unit === 'days' ? ' days' : unit === '% a month' ? '% a month' : '%'}`;

const W = 1000; // not money: drawing units
const H = 620; // not money
const CX = W / 2; // not money
const CY = H / 2 + 50; // not money
const SIZE = 400; // not money

/**
 * A scenario surface drawn in 3D (DASH-027): the two changes across the floor, the outcome up,
 * green above zero and red below. Drag to turn it, or use the arrow keys when it has focus; the
 * month slider beside it plays how the surface builds up over the projection (what a "4D" view
 * means here, DASH-039). The table below has every value.
 */
export function ScenarioSurface3D({
  d,
  frame,
  view,
  onView,
  mark,
}: {
  d: ScenarioSurfaceData;
  frame: SurfaceFrame;
  view: View3D;
  onView: (v: View3D) => void;
  mark: { xi: number; yi: number } | null;
}) {
  const drag = useRef<{ x: number; y: number; view: View3D } | null>(null);
  // Every frame on one height scale, so playing the months shows the surface rising or falling.
  const all = d.frames.flatMap((f) => [Number(f.min), Number(f.max)]);
  const range = { min: Math.min(0, ...all), max: Math.max(0, ...all) };
  const values = frame.values.map((row) => row.map(Number));
  const quads = surfaceQuads(values, view, SIZE, CX, CY, range);
  const floor = (px: number, py: number) => project(px, py, -0.35, view, SIZE, CX, CY);
  const corners = [floor(-0.5, -0.5), floor(0.5, -0.5), floor(0.5, 0.5), floor(-0.5, 0.5)];
  const zero = range.max > range.min ? ((0 - range.min) / (range.max - range.min)) * 0.7 - 0.35 : 0; // not money: drawing height
  const plane = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ].map(([x, y]) => project(x, y, zero, view, SIZE, CX, CY));
  const label = (px: number, py: number, text: string, key: string) => {
    const p = floor(px, py);
    return (
      <text key={key} x={p.x} y={p.y + 18} textAnchor="middle" fontSize={12} fill="var(--t2t-text-muted)">
        {text}
      </text>
    );
  };
  const markPoint = mark
    ? project(
        mark.xi / (d.x.values.length - 1) - 0.5,
        mark.yi / (d.y.values.length - 1) - 0.5,
        range.max > range.min ? ((values[mark.yi][mark.xi] - range.min) / (range.max - range.min)) * 0.7 - 0.35 : 0,
        view,
        SIZE,
        CX,
        CY,
      )
    : null;
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
    if (!s) return;
    onView({ yaw: s.view.yaw + (e.clientX - s.x) * 0.4, pitch: clampPitch(s.view.pitch + (e.clientY - s.y) * 0.3) });
  };
  return (
    <div
      tabIndex={0}
      role="group"
      aria-label="Turn the surface: arrow keys turn and tilt it, hold Shift for bigger steps"
      onKeyDown={turn}
      className="rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full touch-none select-none"
        role="img"
        aria-label={`${MEASURE_LABEL[d.measure]} by ${d.x.label.toLowerCase()} and ${d.y.label.toLowerCase()} in ${frame.month}, drawn as a surface: green above zero, red below. Every value is in the Surface values table.`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        style={{ cursor: 'grab' }}
      >
        <polygon points={corners.map((p) => `${p.x},${p.y}`).join(' ')} fill="var(--t2t-surface-raised)" stroke="var(--t2t-border)" />
        {(
          [
            [0, 0],
            [values[0].length - 1, 0],
            [values[0].length - 1, values.length - 1],
            [0, values.length - 1],
          ] as const
        ).map(([xi, yi]) => {
          // Posts from the floor up to each corner of the surface, to show its height.
          const px = xi / (values[0].length - 1) - 0.5;
          const py = yi / (values.length - 1) - 0.5;
          const top = project(px, py, range.max > range.min ? ((values[yi][xi] - range.min) / (range.max - range.min)) * 0.7 - 0.35 : 0, view, SIZE, CX, CY);
          const bottom = floor(px, py);
          return <line key={`post-${xi}-${yi}`} x1={bottom.x} y1={bottom.y} x2={top.x} y2={top.y} stroke="var(--t2t-text-muted)" strokeOpacity={0.5} strokeDasharray="2 4" />;
        })}
        {range.min < 0 && range.max > 0 ? <polygon points={plane.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="var(--t2t-text-muted)" strokeDasharray="4 6" strokeOpacity={0.6} /> : null}
        {(
          [
            [-0.5, -0.5, 0, 0],
            [0.5, -0.5, 1, 0],
            [0.5, 0.5, 1, 1],
            [-0.5, 0.5, 0, 1],
          ] as const
        ).map(([px, py, a, b]) => label(px, py, `${axisValue(d.x.values[a ? d.x.values.length - 1 : 0], d.x.unit)} · ${axisValue(d.y.values[b ? d.y.values.length - 1 : 0], d.y.unit)}`, `c${a}${b}`))}
        {quads.map((q) => (
          <polygon
            key={`${q.xi}-${q.yi}`}
            points={q.points.map((p) => `${p.x},${p.y}`).join(' ')}
            fill={surfaceColour(q.value, range.min, range.max)}
            fillOpacity={0.92}
            stroke="var(--t2t-surface)"
            strokeWidth={1}
          >
            <title>{`${d.x.label} ${axisValue(d.x.values[q.xi], d.x.unit)} to ${axisValue(d.x.values[q.xi + 1], d.x.unit)}, ${d.y.label} ${axisValue(d.y.values[q.yi], d.y.unit)} to ${axisValue(d.y.values[q.yi + 1], d.y.unit)}: about ${money(String(Math.round(q.value)), d.currency)}`}</title>
          </polygon>
        ))}
        {markPoint ? <circle cx={markPoint.x} cy={markPoint.y} r={8} fill="none" stroke="var(--t2t-text)" strokeWidth={3} /> : null}
        <text x={20} y={30} fontSize={13} fontWeight={600} fill="var(--t2t-text)">{`${MEASURE_LABEL[d.measure]} · ${frame.month}`}</text>
        <text x={20} y={50} fontSize={12} fill="var(--t2t-text-muted)">{`Corners: ${d.x.label.toLowerCase()} · ${d.y.label.toLowerCase()}`}</text>
        <text x={20} y={68} fontSize={12} fill="var(--t2t-text-muted)">{`Height from ${money(String(range.min), d.currency)} to ${money(String(range.max), d.currency)}`}</text>
      </svg>
    </div>
  );
}
