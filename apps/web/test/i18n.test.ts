import { describe, expect, it } from 'vitest';
import { hi } from '../src/lib/messages/hi';
import { EMPLOYEE_NAV, NAV } from '../src/lib/nav';

describe('Hindi interface text', () => {
  const labels = [...NAV, ...EMPLOYEE_NAV].flatMap((g) => [g.group, ...g.items.map((i) => i.label)]);

  it('covers every navigation group and item', () => {
    expect(labels.filter((l) => !hi[l])).toEqual([]);
  });

  it('never gives two different navigation entries the same words', () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const l of new Set(labels)) {
      const h = hi[l]!;
      if (seen.has(h)) clashes.push(`${seen.get(h)} / ${l} → ${h}`);
      seen.set(h, l);
    }
    expect(clashes).toEqual([]);
  });

  it('keeps every {placeholder} of the English text', () => {
    const bad = Object.entries(hi).filter(([en, h]) => (en.match(/\{\w+\}/g) ?? []).some((p) => !h.includes(p)));
    expect(bad).toEqual([]);
  });
});
