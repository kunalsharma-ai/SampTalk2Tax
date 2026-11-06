import { describe, expect, it } from 'vitest';
import { CrmError, dealStageChange, leadConvertible, leadTransition, pipelineSummary, weightedByCloseMonth, weightedValue, type PipelineDeal } from '../src';

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as CrmError).code;
  }
  return null;
};

describe('leads', () => {
  it('move between statuses, with a reason to disqualify', () => {
    expect(code(() => leadTransition('NEW', 'CONTACTED'))).toBeNull();
    expect(code(() => leadTransition('CONTACTED', 'QUALIFIED'))).toBeNull();
    expect(code(() => leadTransition('NEW', 'DISQUALIFIED'))).toBe('LEAD_REASON_REQUIRED');
    expect(code(() => leadTransition('NEW', 'DISQUALIFIED', 'No budget'))).toBeNull();
    expect(code(() => leadTransition('DISQUALIFIED', 'NEW'))).toBeNull();
    expect(code(() => leadTransition('DISQUALIFIED', 'QUALIFIED'))).toBe('LEAD_REOPEN_FIRST');
    expect(code(() => leadTransition('NEW', 'NEW'))).toBe('LEAD_SAME_STATUS');
  });
  it('convert only once qualified, and then never move', () => {
    expect(code(() => leadTransition('QUALIFIED', 'CONVERTED'))).toBe('LEAD_CONVERT_ONLY');
    expect(code(() => leadTransition('CONVERTED', 'NEW'))).toBe('LEAD_CONVERTED');
    expect(code(() => leadConvertible('CONTACTED'))).toBe('LEAD_NOT_QUALIFIED');
    expect(code(() => leadConvertible('CONVERTED'))).toBe('LEAD_CONVERTED');
    expect(code(() => leadConvertible('QUALIFIED'))).toBeNull();
  });
});

describe('deal stages', () => {
  it('take the stage probability unless one is given', () => {
    expect(dealStageChange('PROSPECTING', 'PROPOSAL')).toEqual({ probability: 50, closes: false, reopens: false });
    expect(dealStageChange('PROSPECTING', 'PROPOSAL', { probability: 60 }).probability).toBe(60);
    expect(dealStageChange('PROPOSAL', 'PROPOSAL', { probability: 40 }).probability).toBe(40);
    expect(code(() => dealStageChange('PROPOSAL', 'PROPOSAL'))).toBe('DEAL_SAME_STAGE');
    expect(code(() => dealStageChange('PROPOSAL', 'NEGOTIATION', { probability: 101 }))).toBe('DEAL_PROBABILITY');
    expect(code(() => dealStageChange('PROPOSAL', 'NEGOTIATION', { probability: 33.5 }))).toBe('DEAL_PROBABILITY');
  });
  it('close at 100 or 0, losing with a reason, and reopen', () => {
    expect(dealStageChange('NEGOTIATION', 'WON')).toEqual({ probability: 100, closes: true, reopens: false });
    expect(code(() => dealStageChange('NEGOTIATION', 'LOST'))).toBe('DEAL_REASON_REQUIRED');
    expect(dealStageChange('NEGOTIATION', 'LOST', { lostReason: 'Price' }).probability).toBe(0);
    expect(code(() => dealStageChange('NEGOTIATION', 'WON', { probability: 80 }))).toBe('DEAL_PROBABILITY');
    expect(dealStageChange('LOST', 'NEGOTIATION')).toEqual({ probability: 75, closes: false, reopens: true });
  });
  it('weight values in decimals', () => {
    expect(weightedValue('100000.00', 25, 2)).toBe('25000.00');
    expect(weightedValue('0.05', 50, 2)).toBe('0.02');
    expect(weightedValue('0.15', 50, 2)).toBe('0.08');
    expect(weightedValue('1000', 33, 0)).toBe('330');
  });
});

const deal = (p: Partial<PipelineDeal>): PipelineDeal => ({ stage: 'PROPOSAL', amount: '1000.00', probability: 50, ownerId: null, expectedCloseDate: '2026-11-20', closedOn: null, createdOn: '2026-10-01', ...p });

describe('pipeline', () => {
  const deals = [
    deal({}),
    deal({ stage: 'PROSPECTING', amount: '5000.00', probability: 10, expectedCloseDate: '2026-10-15' }),
    deal({ stage: 'NEGOTIATION', amount: '2000.00', probability: 80, expectedCloseDate: '2027-09-01' }),
    deal({ stage: 'WON', amount: '3000.00', probability: 100, closedOn: '2026-10-31', createdOn: '2026-10-01' }),
    deal({ stage: 'WON', amount: '7000.00', probability: 100, closedOn: '2026-11-04', createdOn: '2026-10-25' }),
    deal({ stage: 'LOST', amount: '9000.00', probability: 0, closedOn: '2026-09-01' }),
    deal({ stage: 'WON', amount: '1.00', probability: 100, closedOn: '2026-01-01' }),
  ];
  it('summarises open, overdue and the trailing window', () => {
    const s = pipelineSummary(deals, '2026-11-06', 2);
    expect(s.open).toEqual({ count: 3, amount: '8000.00', weighted: '2600.00' });
    expect(s.stages.find((x) => x.stage === 'PROSPECTING')).toEqual({ stage: 'PROSPECTING', count: 1, amount: '5000.00', weighted: '500.00' });
    expect(s.overdue).toEqual({ count: 1, amount: '5000.00' });
    expect(s.window).toEqual({ days: 90, won: 2, lost: 1, wonAmount: '10000.00', winRate: 67, averageDaysToWin: 20 });
    expect(pipelineSummary([], '2026-11-06', 2).window).toMatchObject({ winRate: null, averageDaysToWin: null });
  });
  it('spreads weighted value by close month, overdue in this month', () => {
    const f = weightedByCloseMonth(deals, '2026-11-06', 2, 3);
    expect(f.months).toEqual([
      { month: '2026-11', count: 2, amount: '6000.00', weighted: '1000.00' },
      { month: '2026-12', count: 0, amount: '0.00', weighted: '0.00' },
      { month: '2027-01', count: 0, amount: '0.00', weighted: '0.00' },
    ]);
    expect(f.later).toEqual({ count: 1, amount: '2000.00', weighted: '1600.00' });
  });
});
