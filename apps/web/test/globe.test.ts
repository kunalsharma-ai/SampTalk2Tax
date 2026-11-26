import { describe, expect, it } from 'vitest';
import { bubbleRadius, clampLat, graticule, orthographic, wrapLon } from '../src/lib/globe';

describe('globe', () => {
  it('puts the centre of the view in the middle and the far side out of sight', () => {
    const v = { lon: 79, lat: 22, zoom: 1 };
    const c = orthographic(22, 79, v, 100, 200, 200);
    expect(c.x).toBeCloseTo(200);
    expect(c.y).toBeCloseTo(200);
    expect(c.z).toBeCloseTo(1);
    expect(orthographic(-22, -101, v, 100, 200, 200).visible).toBe(false);
    // East is to the right and north is up.
    expect(orthographic(22, 89, v, 100, 200, 200).x).toBeGreaterThan(200);
    expect(orthographic(32, 79, v, 100, 200, 200).y).toBeLessThan(200);
    // Zoom scales distances from the centre.
    const near = orthographic(22, 89, { ...v, zoom: 3 }, 100, 200, 200);
    expect(near.x - 200).toBeCloseTo((orthographic(22, 89, v, 100, 200, 200).x - 200) * 3);
  });

  it('draws the near side of the grid and keeps the view in range', () => {
    const paths = graticule({ lon: 0, lat: 0, zoom: 1 }, 100, 0, 0);
    expect(paths.length).toBeGreaterThan(8);
    expect(paths.every((d) => d.startsWith('M'))).toBe(true);
    expect([clampLat(95), clampLat(-95), wrapLon(190), wrapLon(-190), wrapLon(45)]).toEqual([80, -80, -170, 170, 45]);
  });

  it('sizes bubbles by area', () => {
    expect(bubbleRadius(100, 100)).toBe(42);
    expect(bubbleRadius(25, 100)).toBe(21);
    expect(bubbleRadius(0.01, 100)).toBe(4);
    expect(bubbleRadius(0, 100)).toBe(0);
    expect(bubbleRadius(-5, 100)).toBe(0);
  });
});
