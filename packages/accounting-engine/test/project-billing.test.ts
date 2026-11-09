import { describe, expect, it } from 'vitest';
import { milestoneIssues, progressIssues, shareQuantities, sharesTotal } from '../src';

const lines = [
  { id: 'a', lineNo: 1, quantity: '3', billed: '0' },
  { id: 'b', lineNo: 2, quantity: '1', billed: '0' },
];

describe('shares of an order', () => {
  it('bills a share of every line, and the rest at 100%', () => {
    expect(shareQuantities(lines, '30')).toEqual([{ orderLineId: 'a', quantity: '0.9' }, { orderLineId: 'b', quantity: '0.3' }]);
    const thirds = shareQuantities([{ id: 'a', lineNo: 1, quantity: '1', billed: '0' }], '33.33');
    expect(thirds).toEqual([{ orderLineId: 'a', quantity: '0.3333' }]);
    expect(shareQuantities([{ id: 'a', lineNo: 1, quantity: '1', billed: '0.6666' }], '100')).toEqual([{ orderLineId: 'a', quantity: '0.3334' }]);
  });
  it('bills to a cumulative target less what is billed', () => {
    expect(shareQuantities([{ id: 'a', lineNo: 1, quantity: '10', billed: '4' }], '60')).toEqual([{ orderLineId: 'a', quantity: '2' }]);
    expect(shareQuantities([{ id: 'a', lineNo: 1, quantity: '10', billed: '7' }], '60')).toEqual([]);
    expect(shareQuantities([{ id: 'a', lineNo: 1, quantity: '10', billed: '10' }], '100')).toEqual([]);
  });
});

describe('milestone plans and progress claims', () => {
  it('checks milestones', () => {
    expect(milestoneIssues([{ name: 'Design', percent: '30' }, { name: 'Build', percent: '70' }])).toEqual([]);
    expect(milestoneIssues([{ name: '', percent: '0' }])).toEqual(['Milestone 1: give it a name', 'Milestone 1: the share must be above 0%']);
    expect(milestoneIssues([{ name: 'A', percent: '60' }, { name: 'B', percent: '50.5' }])).toEqual(['The milestones add up to 110.5%; they can be at most 100%']);
    expect(milestoneIssues([])).toEqual(['Add at least one milestone']);
    expect(sharesTotal([{ percent: '30' }, { percent: '20.5' }])).toBe('50.5');
  });
  it('checks progress claims', () => {
    expect(progressIssues('40', '0')).toEqual([]);
    expect(progressIssues('40', '40')).toEqual(['Earlier claims already bill 40% complete; claim a higher percent']);
    expect(progressIssues('101', '0')).toEqual(['Work cannot be more than 100% complete']);
  });
});
