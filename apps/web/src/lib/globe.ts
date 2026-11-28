/**
 * Drawing a globe (DASH-025) without a map library: places given by latitude and longitude are
 * projected orthographically, as a ball seen from far away centred on `view`. Points on the far
 * side are hidden. Positions are approximate centres, for drawing only; every figure is in a table.
 */
export interface GlobeView {
  /** Longitude at the centre of the globe, degrees. */
  lon: number;
  /** Latitude at the centre of the globe, degrees (-80..80). */
  lat: number;
  /** 1 shows the whole globe; larger zooms in. */
  zoom: number;
}
export interface GlobePoint {
  x: number;
  y: number;
  /** Towards the viewer: above 0 is on the near side. */
  z: number;
  visible: boolean;
}

export const DEFAULT_GLOBE: GlobeView = { lon: 60, lat: 20, zoom: 1 };
export const clampLat = (lat: number) => Math.min(80, Math.max(-80, lat));
/** Longitude kept within -180..180. */
export const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

const rad = (d: number) => (d * Math.PI) / 180;

/** A place on the screen, for a globe of radius `r` (before zoom) centred at (cx, cy). */
export function orthographic(lat: number, lon: number, view: GlobeView, r: number, cx: number, cy: number): GlobePoint {
  const p = rad(lat);
  const p0 = rad(view.lat);
  const dl = rad(lon - view.lon);
  const x = Math.cos(p) * Math.sin(dl);
  const y = Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(dl);
  const z = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(dl);
  const R = r * view.zoom;
  return { x: cx + R * x, y: cy - R * y, z, visible: z > 0 };
}

/** SVG paths of the meridians and parallels every `step` degrees, near side only. */
export function graticule(view: GlobeView, r: number, cx: number, cy: number, step = 30): string[] {
  const lines: [number, number][][] = [];
  for (let lon = -180; lon < 180; lon += step) {
    const line: [number, number][] = [];
    for (let lat = -90; lat <= 90; lat += 5) line.push([lat, lon]);
    lines.push(line);
  }
  for (let lat = -90 + step; lat < 90; lat += step) {
    const line: [number, number][] = [];
    for (let lon = -180; lon <= 180; lon += 5) line.push([lat, lon]);
    lines.push(line);
  }
  const paths: string[] = [];
  for (const line of lines) {
    let d = '';
    let pen = false;
    for (const [lat, lon] of line) {
      const q = orthographic(lat, lon, view, r, cx, cy);
      if (!q.visible) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`;
      pen = true;
    }
    if (d) paths.push(d);
  }
  return paths;
}

/** A bubble's radius from its share of the largest place (area in proportion), at least `min`. */
export const bubbleRadius = (value: number, largest: number, max = 42, min = 4) => (largest > 0 && value > 0 ? Math.max(min, Math.sqrt(value / largest) * max) : 0);
