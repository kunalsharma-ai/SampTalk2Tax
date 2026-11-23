import { describe, expect, it } from 'vitest';
import { applyLayoutOps, checkDashboard, dropMetric, MAX_WIDGETS, moveWidget, type Widget } from '../src';

const widgets = checkDashboard({
  widgets: [
    { type: 'STAT', title: 'Revenue', metric: 'revenue', compare: 'PREVIOUS_MONTH' },
    { type: 'LINE', title: 'Profit', metrics: ['grossProfit'], months: 6 },
    { type: 'TABLE', title: 'Margins', metrics: ['grossMargin'], months: 3 },
    { type: 'TOP_CUSTOMERS', title: 'Biggest customers', count: 5, months: 12 },
  ],
}).config.widgets;

describe('arranging a dashboard', () => {
  it('moves a widget to a new position', () => {
    const r = moveWidget(widgets, 3, 0);
    expect(r.error).toBeNull();
    expect(r.widgets.map((w) => w.title)).toEqual(['Biggest customers', 'Revenue', 'Profit', 'Margins']);
    expect(moveWidget(widgets, 0, 3).widgets.map((w) => w.title)).toEqual(['Profit', 'Margins', 'Biggest customers', 'Revenue']);
    expect(moveWidget(widgets, 0, 4).error).toBe('A widget can only move to a position from 1 to 4');
    expect(moveWidget(widgets, 7, 0).error).toBe('There is no widget 8 to move');
  });

  it('drops a metric between widgets as a new figure', () => {
    const r = dropMetric(widgets, 'cash', { kind: 'new', at: 1 });
    expect(r.error).toBeNull();
    expect(r.widgets[1]).toEqual({ type: 'STAT', title: 'Cash and bank', size: 'SMALL', metric: 'cash', compare: 'PREVIOUS_MONTH' });
    expect(r.widgets).toHaveLength(5);
    expect(dropMetric(widgets, 'cash', { kind: 'new', at: 5 }).error).toBe('A new figure can only go at a position from 1 to 5');
    expect(dropMetric(widgets, 'magic', { kind: 'new', at: 0 }).error).toBe('"magic" is not an approved metric');
    const full: Widget[] = Array.from({ length: MAX_WIDGETS }, () => widgets[0]!);
    expect(dropMetric(full, 'cash', { kind: 'new', at: 0 }).error).toBe(`A dashboard holds at most ${MAX_WIDGETS} widgets; remove one first`);
  });

  it('drops a metric onto a figure, a chart and a table', () => {
    const stat = dropMetric(widgets, 'cash', { kind: 'into', index: 0 });
    expect(stat.widgets[0]).toMatchObject({ type: 'STAT', metric: 'cash', title: 'Cash and bank' });
    const named = [{ ...widgets[0]!, title: 'Top line' } as Widget];
    expect(dropMetric(named, 'cash', { kind: 'into', index: 0 }).widgets[0]).toMatchObject({ metric: 'cash', title: 'Top line' });
    expect(dropMetric(widgets, 'revenue', { kind: 'into', index: 0 }).error).toBe('Revenue already shows Revenue');

    expect(dropMetric(widgets, 'netIncome', { kind: 'into', index: 1 }).widgets[1]).toMatchObject({ metrics: ['grossProfit', 'netIncome'] });
    expect(dropMetric(widgets, 'grossMargin', { kind: 'into', index: 1 }).error).toBe('Profit shows amounts; Gross margin is measured in percentages, so it needs its own chart');
    expect(dropMetric(widgets, 'grossProfit', { kind: 'into', index: 1 }).error).toBe('Profit already shows Gross profit');

    expect(dropMetric(widgets, 'cash', { kind: 'into', index: 2 }).widgets[2]).toMatchObject({ metrics: ['grossMargin', 'cash'] });
    expect(dropMetric(widgets, 'cash', { kind: 'into', index: 3 }).error).toBe('Biggest customers lists customers; drop the metric between widgets to add it as a figure');
    expect(dropMetric(widgets, 'cash', { kind: 'into', index: 9 }).error).toBe('There is no widget 10 to drop onto');
    // the original list is never changed
    expect(widgets[0]).toMatchObject({ metric: 'revenue' });
  });

  it('applies a series of changes and checks the result', () => {
    const r = applyLayoutOps({ widgets }, [
      { op: 'dropMetric', metric: 'cash', target: { kind: 'new', at: 0 } },
      { op: 'move', from: 4, to: 1 },
      { op: 'remove', index: 3 },
    ]);
    expect(r.issues).toEqual([]);
    expect(r.config.widgets.map((w) => w.title)).toEqual(['Cash and bank', 'Biggest customers', 'Revenue', 'Margins']);
    const bad = applyLayoutOps({ widgets }, [{ op: 'move', from: 0, to: 1 }, { op: 'dropMetric', metric: 'cash', target: { kind: 'into', index: 3 } }]);
    expect(bad.issues).toEqual(['Change 2: Biggest customers lists customers; drop the metric between widgets to add it as a figure']);
    expect(bad.config.widgets).toBe(widgets);
    expect(applyLayoutOps({ widgets }, []).issues).toEqual(['Nothing was changed']);
    expect(applyLayoutOps({ widgets: [widgets[0]!] }, [{ op: 'remove', index: 0 }]).issues).toEqual(['A dashboard needs at least one widget']);
  });
});
