/**
 * Drawing a scenario surface in 3D (DASH-027) without a 3D library: the grid of values is
 * placed in a unit cube, turned (yaw around the vertical, pitch towards the viewer), projected
 * straight onto the screen, and its cells are painted far to near so nearer cells cover farther
 * ones. Exact numbers are always in the table beside it.
 */
export interface View3D {
  /** Turn around the vertical axis, degrees. */
  yaw: number;
  /** Tilt towards the viewer, degrees (0 looks from the side, 90 from above). */
  pitch: number;
}
export interface Projected {
  x: number;
  y: number;
  /** Larger is nearer the viewer. */
  depth: number;
}
export interface SurfaceQuad {
  xi: number;
  yi: number;
  points: [Projected, Projected, Projected, Projected];
  depth: number;
  /** Mean of the four corners, for the colour. */
  value: number;
}

export const DEFAULT_VIEW: View3D = { yaw: -35, pitch: 30 };
export const clampPitch = (p: number) => Math.min(85, Math.max(5, p));

const rad = (d: number) => (d * Math.PI) / 180;

/** A point of the unit cube (each coordinate from -0.5 to 0.5; z up) on the screen, scaled to `size`. */
export function project(px: number, py: number, pz: number, view: View3D, size: number, cx: number, cy: number): Projected {
  const a = rad(view.yaw);
  const b = rad(view.pitch);
  // Turn around z, then tilt around the screen's x axis.
  const x1 = px * Math.cos(a) - py * Math.sin(a);
  const y1 = px * Math.sin(a) + py * Math.cos(a);
  const sy = y1 * Math.sin(b) - pz * Math.cos(b);
  const depth = y1 * Math.cos(b) + pz * Math.sin(b);
  return { x: cx + x1 * size, y: cy + sy * size, depth };
}

/** Where 0..1 of the value range sits on the vertical axis. */
export const heightOf = (v: number, min: number, max: number) => (max > min ? (v - min) / (max - min) - 0.5 : 0) * 0.7;

/** The grid's cells as screen quads, farthest first. values[yi][xi]. */
export function surfaceQuads(values: number[][], view: View3D, size: number, cx: number, cy: number, range?: { min: number; max: number }): SurfaceQuad[] {
  const rows = values.length;
  const cols = rows ? values[0].length : 0;
  if (rows < 2 || cols < 2) return [];
  const flat = values.flat();
  const min = range?.min ?? Math.min(...flat);
  const max = range?.max ?? Math.max(...flat);
  const at = (xi: number, yi: number) => project(xi / (cols - 1) - 0.5, yi / (rows - 1) - 0.5, heightOf(values[yi][xi], min, max), view, size, cx, cy);
  const quads: SurfaceQuad[] = [];
  for (let yi = 0; yi < rows - 1; yi++) {
    for (let xi = 0; xi < cols - 1; xi++) {
      const points: SurfaceQuad['points'] = [at(xi, yi), at(xi + 1, yi), at(xi + 1, yi + 1), at(xi, yi + 1)];
      quads.push({ xi, yi, points, depth: points.reduce((t, p) => t + p.depth, 0) / 4, value: (values[yi][xi] + values[yi][xi + 1] + values[yi + 1][xi + 1] + values[yi + 1][xi]) / 4 });
    }
  }
  // Painter's order: depth grows towards the viewer, so the smallest depth (farthest) goes first.
  return quads.sort((p, q) => p.depth - q.depth);
}

/** Red below zero, green above, by how far towards the extremes; grey for zero. */
export function surfaceColour(v: number, min: number, max: number): string {
  if (v < 0 && min < 0) {
    const t = Math.min(1, v / min);
    return `hsl(0 ${Math.round(45 + 35 * t)}% ${Math.round(62 - 18 * t)}%)`;
  }
  if (v > 0 && max > 0) {
    const t = Math.min(1, v / max);
    return `hsl(158 ${Math.round(35 + 40 * t)}% ${Math.round(58 - 18 * t)}%)`;
  }
  return 'hsl(215 15% 55%)';
}
