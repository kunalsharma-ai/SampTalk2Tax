import { describe, expect, it } from 'vitest';
import { SCHEDULED_REPORTS } from '../src/report-schedules';
import { searchStudio, STUDIO_CATEGORIES, STUDIO_REPORTS, studioTools, isStudioReport } from '../src/report-studio';
import { VIEW_REPORT_KEYS } from '../src/report-views';

describe('reporting studio catalogue', () => {
  it('lists each report once, in a known category, with a page to open', () => {
    const keys = STUDIO_REPORTS.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of STUDIO_REPORTS) {
      expect(STUDIO_CATEGORIES).toContain(r.category);
      expect(r.href.startsWith('/')).toBe(true);
      expect(r.question.length).toBeGreaterThan(10);
    }
  });

  it('covers every report that can be saved as a view or scheduled', () => {
    for (const k of [...VIEW_REPORT_KEYS, ...SCHEDULED_REPORTS]) expect(isStudioReport(k)).toBe(true);
    expect(studioTools('income-statement')).toEqual({ savedViews: true, schedules: true });
    expect(studioTools('vendor-spend')).toEqual({ savedViews: true, schedules: false });
    expect(studioTools('kpis')).toEqual({ savedViews: false, schedules: false });
    expect(isStudioReport('nope')).toBe(false);
  });

  it('finds reports by every word searched for, in name, question or category', () => {
    expect(searchStudio(STUDIO_REPORTS, 'ageing').map((r) => r.key)).toEqual(['receivables-ageing', 'payables-ageing']);
    expect(searchStudio(STUDIO_REPORTS, 'OWE late').map((r) => r.key)).toEqual(['receivables-ageing']);
    expect(searchStudio(STUDIO_REPORTS, 'tax').map((r) => r.key)).toContain('tax');
    expect(searchStudio(STUDIO_REPORTS, '  ')).toHaveLength(STUDIO_REPORTS.length);
    expect(searchStudio(STUDIO_REPORTS, 'zzzz')).toEqual([]);
  });
});
