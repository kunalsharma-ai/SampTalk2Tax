import { describe, expect, it } from 'vitest';
import { GRAPH_SIZE, radialLayout, shareOut } from '../src/lib/graph-layout';
import type { GraphEdge } from '../src/lib/graph';

const edge = (relation: string, id: string): GraphEdge => ({ relation, explanation: `${relation} ${id}`, node: { type: 'DOCUMENT', id, label: id, subtitle: null, path: null } });

describe('Relationship graph layout (DASH-026)', () => {
  it('shares places out in turn so every kind of connection is drawn', () => {
    expect(shareOut([30, 1, 5], 8)).toEqual([4, 1, 3]);
    expect(shareOut([2, 1], 10)).toEqual([2, 1]);
    expect(shareOut([3, 3], 0)).toEqual([0, 0]);
  });

  it('puts each kind of connection in its own sector, clockwise from the top', () => {
    const l = radialLayout([edge('ISSUED_TO', 'a'), edge('ISSUED_TO', 'b'), edge('PAID_BY', 'c')]);
    expect(l.sectors.map((s) => [s.relation, s.shown, s.hidden])).toEqual([
      ['ISSUED_TO', 2, 0],
      ['PAID_BY', 1, 0],
    ]);
    // Two of three shares of the circle go to the invoices.
    expect(l.sectors[0].end - l.sectors[0].start).toBeCloseTo((Math.PI * 4) / 3, 6);
    expect(l.sectors[0].start).toBeCloseTo(-Math.PI / 2, 6);
    for (const n of l.nodes) {
      const r = Math.hypot(n.x - GRAPH_SIZE.width / 2, n.y - GRAPH_SIZE.height / 2);
      expect(Math.abs(r - GRAPH_SIZE.radius)).toBeLessThan(1);
    }
    // The one payment takes the last third of the circle, up on the left.
    const c = l.nodes.find((n) => n.node.id === 'c')!;
    expect(c.angle).toBeCloseTo((Math.PI * 7) / 6, 6);
    expect(c.x).toBeLessThan(GRAPH_SIZE.width / 2);
    expect(c.y).toBeLessThan(GRAPH_SIZE.height / 2);
  });

  it('caps the records drawn and counts the rest, including those the server left out', () => {
    const edges = Array.from({ length: 40 }, (_, i) => edge('POSTED_IN', `j${i}`)).concat([edge('FLAGGED_BY', 'x')]);
    const l = radialLayout(
      edges,
      [
        { relation: 'POSTED_IN', count: 12 },
        { relation: 'EVIDENCE', count: 2 },
      ],
      10,
    );
    expect(l.nodes).toHaveLength(10);
    expect(l.sectors.find((s) => s.relation === 'FLAGGED_BY')!.shown).toBe(1);
    expect(l.sectors.find((s) => s.relation === 'POSTED_IN')).toMatchObject({ shown: 9, hidden: 31 + 12 });
    expect(l.sectors.find((s) => s.relation === 'EVIDENCE')).toMatchObject({ shown: 0, hidden: 2 });
    expect(l.hidden).toBe(45);
    // Crowded sectors use an inner ring for every other record.
    expect(new Set(l.nodes.filter((n) => n.relation === 'POSTED_IN').map((n) => Math.round(Math.hypot(n.x - 500, n.y - 330))))).toEqual(new Set([170, 230]));
  });

  it('draws nothing around a record with no connections', () => {
    expect(radialLayout([])).toEqual({ nodes: [], sectors: [], hidden: 0 });
  });
});
