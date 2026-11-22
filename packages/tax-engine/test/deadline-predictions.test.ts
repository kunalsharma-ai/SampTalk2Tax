import { describe, expect, it } from 'vitest';
import { deadlinePredictions } from '../src';

const up = (key: string, dueDate: string, extra: Record<string, unknown> = {}) => ({ key, kind: key.split(':')[0]!, name: key.split(':')[0]!, period: key.split(':')[1]!, periodLabel: key.split(':')[1]!, dueDate, periodOver: true, ...extra });
const T = '2026-11-22';

describe('deadlinePredictions', () => {
  it('rates by past lateness, the usual date and signals from the books', () => {
    const past = [
      { kind: 'GSTR1', dueDate: '2026-08-11', doneOn: '2026-08-14' },
      { kind: 'GSTR1', dueDate: '2026-09-11', doneOn: '2026-09-13' },
      { kind: 'GSTR1', dueDate: '2026-10-11', doneOn: '2026-10-11' },
      { kind: 'GSTR3B', dueDate: '2026-09-20', doneOn: '2026-09-15' },
      { kind: 'GSTR3B', dueDate: '2026-10-20', doneOn: '2026-10-17' },
      { kind: 'TDS_DEPOSIT', dueDate: '2026-10-07', doneOn: null },
      { kind: 'TDS_DEPOSIT', dueDate: '2026-09-07', doneOn: '2026-09-06' },
    ];
    const p = deadlinePredictions(
      [
        up('GSTR1:2026-11', '2026-12-11'),
        up('GSTR3B:2026-11', '2026-12-20', { signals: [{ severity: 'WARN', message: 'Books differ' }] }),
        up('GSTR3B:2026-10', '2026-11-20'),
        up('TDS_DEPOSIT:2026-11', '2026-12-07', { periodOver: false }),
        up('PT:2026-11', '2026-11-30', { periodOver: false }),
      ],
      past,
      T,
    );
    const by = Object.fromEntries(p.map((x) => [x.key, x]));
    // Late twice out of three, usually two days after the due date.
    expect(by['GSTR1:2026-11']).toMatchObject({ risk: 'HIGH', history: 3, late: 2, lateRate: '67', usualLeadDays: -2, predictedDate: '2026-12-13' });
    expect(by['GSTR1:2026-11'].reasons).toEqual(['Late 2 of the last 3 times', 'Usually done 2 days after the due date']);
    // Always early, but the books differ: one warning point.
    expect(by['GSTR3B:2026-11']).toMatchObject({ risk: 'MEDIUM', usualLeadDays: 4, predictedDate: '2026-12-16', reasons: [] });
    // Overdue.
    expect(by['GSTR3B:2026-10']).toMatchObject({ risk: 'HIGH', daysLeft: -2, reasons: ['Overdue by 2 days'] });
    // One late (never done) out of two.
    expect(by['TDS_DEPOSIT:2026-11']).toMatchObject({ risk: 'MEDIUM', lateRate: '50', reasons: ['Late 1 of the last 2 times'] });
    expect(by['PT:2026-11']).toMatchObject({ risk: 'LOW', history: 0, lateRate: null, reasons: ['The period has not ended yet'] });
    expect(p.map((x) => x.key)).toEqual(['GSTR3B:2026-10', 'GSTR1:2026-11', 'TDS_DEPOSIT:2026-11', 'GSTR3B:2026-11', 'PT:2026-11']);
  });

  it('is low when it is always on time, and flags a usual date gone by', () => {
    const past = [
      { kind: 'GSTR3B', dueDate: '2026-09-20', doneOn: '2026-09-10' },
      { kind: 'GSTR3B', dueDate: '2026-10-20', doneOn: '2026-10-10' },
    ];
    expect(deadlinePredictions([up('GSTR3B:2026-11', '2026-12-20')], past, T)[0]).toMatchObject({ risk: 'LOW', reasons: ['Done on time 2 of the last 2 times, usually 10 days early'] });
    expect(deadlinePredictions([up('GSTR3B:2026-11', '2026-11-30')], past, T)[0]).toMatchObject({ risk: 'MEDIUM', predictedDate: '2026-11-20', reasons: ['Usually done by 20 Nov 2026, and not done yet'] });
    expect(deadlinePredictions([up('GSTR9:2025-26', '2026-11-24')], [], T)[0]).toMatchObject({ risk: 'MEDIUM', reasons: ['Due in 2 days with no record of how it was done before'] });
  });
});
