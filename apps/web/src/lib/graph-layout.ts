import type { GraphEdge } from './graph';

/**
 * Layout for the relationship graph (DASH-026): the chosen record in the centre and its
 * connections around it, one sector of the circle per kind of connection, so records connected
 * the same way sit together. Sectors get room in proportion to how many records they show (at
 * least a share for one), and the drawing caps how many records it shows; the rest are counted.
 */
export interface PlacedEdge extends GraphEdge {
  x: number;
  y: number;
  angle: number;
}
export interface GraphSector {
  relation: string;
  start: number;
  end: number;
  shown: number;
  hidden: number;
  labelX: number;
  labelY: number;
}
export interface RadialLayout {
  nodes: PlacedEdge[];
  sectors: GraphSector[];
  hidden: number;
}

export const GRAPH_SIZE = { width: 1000, height: 660, radius: 230, labelRadius: 300 }; // not money: drawing units
export const GRAPH_MAX_NODES = 36; // not money: records drawn at most

/** Shares out up to `max` places across the relations in order, at least one each while places last. */
export function shareOut(counts: number[], max: number): number[] {
  const shown = counts.map(() => 0);
  let left = Math.max(0, max);
  // Round robin: each relation in turn takes one more place until places or records run out.
  while (left > 0) {
    let took = false;
    for (let i = 0; i < counts.length && left > 0; i++) {
      if (shown[i] < counts[i]) {
        shown[i] += 1;
        left -= 1;
        took = true;
      }
    }
    if (!took) break;
  }
  return shown;
}

export function radialLayout(edges: GraphEdge[], more: { relation: string; count: number }[] = [], max = GRAPH_MAX_NODES): RadialLayout {
  const { width, height, radius, labelRadius } = GRAPH_SIZE;
  const cx = width / 2; // not money
  const cy = height / 2; // not money
  const order: string[] = [];
  const byRelation = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    if (!byRelation.has(e.relation)) {
      byRelation.set(e.relation, []);
      order.push(e.relation);
    }
    byRelation.get(e.relation)!.push(e);
  }
  const extra = new Map(more.map((m) => [m.relation, m.count]));
  const shown = shareOut(
    order.map((r) => byRelation.get(r)!.length),
    max,
  );
  const weights = shown.map((n) => Math.max(1, n));
  const total = weights.reduce((a, b) => a + b, 0) || 1; // not money
  const nodes: PlacedEdge[] = [];
  const sectors: GraphSector[] = [];
  // Start at the top and go clockwise.
  let at = -Math.PI / 2;
  order.forEach((relation, i) => {
    const span = (weights[i] / total) * Math.PI * 2; // not money: angle
    const list = byRelation.get(relation)!.slice(0, shown[i]);
    list.forEach((e, j) => {
      const angle = at + (span * (j + 0.5)) / list.length; // not money: angle
      // Stagger crowded sectors over two rings so labels do not sit on top of each other.
      const r = list.length > 4 && j % 2 === 1 ? radius - 60 : radius; // not money
      nodes.push({ ...e, angle, x: Math.round(cx + r * Math.cos(angle)), y: Math.round(cy + r * Math.sin(angle)) });
    });
    const mid = at + span / 2; // not money: angle
    sectors.push({
      relation,
      start: at,
      end: at + span,
      shown: list.length,
      hidden: byRelation.get(relation)!.length - list.length + (extra.get(relation) ?? 0),
      labelX: Math.round(cx + labelRadius * Math.cos(mid)),
      labelY: Math.round(cy + labelRadius * Math.sin(mid)),
    });
    at += span;
  });
  // Relations with only hidden records (none returned) are still counted.
  for (const [relation, count] of extra) if (!byRelation.has(relation)) sectors.push({ relation, start: at, end: at, shown: 0, hidden: count, labelX: cx, labelY: cy });
  return { nodes, sectors, hidden: sectors.reduce((a, s) => a + s.hidden, 0) };
}
