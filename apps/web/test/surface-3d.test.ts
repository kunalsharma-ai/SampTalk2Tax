import { describe, expect, it } from 'vitest';
import { clampPitch, heightOf, project, surfaceColour, surfaceQuads } from '../src/lib/surface-3d';

describe('3D scenario surface drawing (DASH-027)', () => {
  it('projects the cube: from above, height does not move a point; from the side, it does', () => {
    const above = { yaw: 0, pitch: 90 };
    expect(project(0.5, 0, 0.3, above, 100, 0, 0)).toMatchObject({ x: 50 });
    expect(project(0.5, 0, 0.3, above, 100, 0, 0).y).toBeCloseTo(0, 6);
    const side = { yaw: 0, pitch: 0 };
    // Higher values are drawn higher up the screen (smaller y).
    expect(project(0, 0, 0.3, side, 100, 0, 0).y).toBeCloseTo(-30, 6);
    // Turning a quarter moves x onto y.
    const turned = project(0.5, 0, 0, { yaw: 90, pitch: 90 }, 100, 0, 0);
    expect(turned.x).toBeCloseTo(0, 6);
    expect(turned.y).toBeCloseTo(50, 6);
  });

  it('places values between the lowest and highest, and keeps the tilt in range', () => {
    expect(heightOf(10, 10, 20)).toBeCloseTo(-0.35);
    expect(heightOf(20, 10, 20)).toBeCloseTo(0.35);
    expect(heightOf(5, 5, 5)).toBe(0);
    expect(clampPitch(120)).toBe(85);
    expect(clampPitch(-3)).toBe(5);
  });

  it('cuts the grid into cells painted far to near, each with its mean value', () => {
    const q = surfaceQuads(
      [
        [0, 1, 2],
        [3, 4, 5],
      ],
      { yaw: -35, pitch: 30 },
      300,
      500,
      300,
    );
    expect(q).toHaveLength(2);
    expect(q.map((c) => c.value).sort()).toEqual([2, 3]);
    for (let i = 1; i < q.length; i++) expect(q[i - 1].depth).toBeLessThanOrEqual(q[i].depth);
    // Seen from above, the higher point is the nearer one.
    expect(project(0, 0, 0.3, { yaw: 0, pitch: 90 }, 1, 0, 0).depth).toBeGreaterThan(project(0, 0, -0.3, { yaw: 0, pitch: 90 }, 1, 0, 0).depth);
    expect(surfaceQuads([[1, 2]], { yaw: 0, pitch: 30 }, 100, 0, 0)).toEqual([]);
  });

  it('colours losses red and gains green', () => {
    expect(surfaceColour(-10, -10, 10)).toMatch(/^hsl\(0 /);
    expect(surfaceColour(10, -10, 10)).toMatch(/^hsl\(158 /);
    expect(surfaceColour(0, -10, 10)).toMatch(/^hsl\(215 /);
  });
});

describe('3D financial landscape towers (DASH-023)', () => {
  it('builds one tower per cell, as tall as its value, nearest last', async () => {
    const { towers } = await import('../src/lib/surface-3d');
    const t = towers(
      [
        [10, 0],
        [5, -5],
      ],
      { yaw: -35, pitch: 30 },
      400,
      500,
      300,
    );
    expect(t).toHaveLength(4);
    for (let i = 1; i < t.length; i++) expect(t[i - 1].depth).toBeLessThanOrEqual(t[i].depth);
    const tall = t.find((x) => x.xi === 0 && x.yi === 0)!;
    const half = t.find((x) => x.xi === 0 && x.yi === 1)!;
    const height = (tw: typeof tall) => {
      const top = tw.faces.find((f) => f.face === 'top')!.points[0];
      const side = tw.faces.find((f) => f.face !== 'top')!.points[0];
      return side.y - top.y;
    };
    // From above-ish, the taller tower's top rises twice as far above its base.
    expect(height(tall)).toBeCloseTo(2 * height(half), 6);
    // A tower for a negative value goes below the floor, and its top is drawn first.
    const neg = t.find((x) => x.xi === 1 && x.yi === 1)!;
    expect(neg.faces[0].face).toBe('top');
    expect(tall.faces[tall.faces.length - 1].face).toBe('top');
    expect(towers([], { yaw: 0, pitch: 30 }, 1, 0, 0)).toEqual([]);
  });
});
