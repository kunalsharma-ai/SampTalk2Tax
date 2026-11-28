import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * DASH-040: every chart has its figures in a table as well, for screen readers and for anyone
 * who needs exact numbers. A chart is drawn inside a labelled role="img" box that names the
 * table (or, when the chart holds controls such as clickable bars, a labelled role="group" with
 * aria-roledescription="chart", since an image cannot contain controls), or is decorative
 * (aria-hidden) next to figures shown as text.
 */
const SRC = join(__dirname, '../src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith('.tsx') ? [join(dir, f)] : []));
const all = files(SRC).map((f) => ({ path: relative(SRC, f), text: readFileSync(f, 'utf8') }));

describe('charts and their data tables', () => {
  const charts = all.filter((f) => f.text.includes('<ResponsiveContainer'));

  it('finds the charts', () => {
    expect(charts.length).toBeGreaterThanOrEqual(8);
  });

  it('labels every chart, or marks it decorative', () => {
    for (const f of charts) {
      const labelled = /role="(?:img|group" aria-roledescription="chart)"\s+aria-label=/.test(f.text);
      const decorative = f.text.includes('aria-hidden="true"');
      expect(labelled || decorative, `${f.path} draws a chart without a label`).toBe(true);
    }
  });

  it('says where the figures are, and every fixed label points to a table', () => {
    for (const f of charts.filter((c) => /role="(?:img|group" aria-roledescription="chart)"\s+aria-label="/.test(c.text))) {
      const label = /role="(?:img|group" aria-roledescription="chart)"\s+aria-label="([^"]+)"/.exec(f.text)![1]!;
      expect(label, f.path).toMatch(/table/i);
    }
    // Charts whose label is passed in (the month-end cash chart) get it from each page.
    for (const f of all.filter((x) => x.text.includes('<TwinCashChart'))) {
      for (const m of f.text.matchAll(/<TwinCashChart[\s\S]*?label="([^"]+)"/g)) expect(m[1], f.path).toMatch(/table/i);
    }
  });

  it('gives the month-end cash chart its own table where the page has none', () => {
    for (const p of ['app/orgs/[orgId]/planning/twin/compare/page.tsx', 'app/orgs/[orgId]/planning/recovery/page.tsx', 'app/orgs/[orgId]/planning/recovery/[planId]/page.tsx']) {
      expect(all.find((f) => f.path === p)?.text, p).toMatch(/<TwinCashChart[\s\S]*?withTable/);
    }
  });
});
