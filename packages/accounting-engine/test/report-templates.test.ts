import { describe, expect, it } from 'vitest';
import { checkReportLayout, REPORT_TEMPLATES, reportTemplate } from '../src';

describe('report templates (RPT-030)', () => {
  it('every template is a layout the designer accepts as it is', () => {
    expect(REPORT_TEMPLATES.map((t) => t.id)).toEqual(['MANAGEMENT_PACK', 'BOARD_REPORT', 'INVESTOR_UPDATE', 'CASH_AND_COLLECTIONS']);
    for (const t of REPORT_TEMPLATES) {
      const r = checkReportLayout(t.layout);
      expect(r.issues, t.id).toEqual([]);
      expect(r.layout, t.id).toEqual(t.layout);
      expect(t.layout.sections.some((s) => s.type === 'COMMENTARY'), t.id).toBe(true);
    }
  });

  it('finds a template by id', () => {
    expect(reportTemplate('BOARD_REPORT')?.name).toBe('Board report');
    expect(reportTemplate('NOPE')).toBeUndefined();
  });
});
