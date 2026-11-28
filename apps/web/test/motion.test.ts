import { afterEach, describe, expect, it, vi } from 'vitest';
import { between, coast, easeInOut, shortestTurn, tween } from '../src/lib/motion';

afterEach(() => vi.unstubAllGlobals());

describe('motion', () => {
  it('eases and interpolates', () => {
    expect([easeInOut(0), easeInOut(0.5), easeInOut(1)]).toEqual([0, 0.5, 1]);
    expect(easeInOut(0.25)).toBeLessThan(0.25);
    expect(between([0, 10], [10, 30], 0.5)).toEqual([5, 20]);
    expect(between([0], [10], 2)).toEqual([10]);
    expect([shortestTurn(170, -170), shortestTurn(-170, 170), shortestTurn(10, 40)]).toEqual([20, -20, 30]);
  });

  it('jumps straight to the end when motion is reduced, and glides through frames otherwise', () => {
    const still: number[][] = [];
    tween([0], [100], 500, (v) => still.push(v), true);
    expect(still).toEqual([[100]]);

    let now = 0;
    const queue: FrameRequestCallback[] = [];
    vi.stubGlobal('performance', { now: () => now });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => queue.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const frames: number[][] = [];
    tween([0], [100], 400, (v) => frames.push(v), false);
    for (const t of [100, 200, 300, 400]) {
      now = t;
      queue.shift()!(t);
    }
    expect(frames.map((f) => Math.round(f[0]))).toEqual([13, 50, 88, 100]);
    expect(queue).toHaveLength(0);
  });

  it('coasts after a fling, slowing to a stop, but not when motion is reduced', () => {
    const queue: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => queue.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const moved: number[][] = [];
    coast([4], (d) => moved.push(d), 0.5, false);
    while (queue.length) queue.shift()!(0);
    expect(moved.map((d) => d[0])).toEqual([2, 1, 0.5, 0.25, 0.125, 0.0625, 0.03125]);
    const none: number[][] = [];
    coast([4], (d) => none.push(d), 0.5, true);
    expect(queue).toHaveLength(0);
    expect(none).toEqual([]);
  });
});
