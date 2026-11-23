import { describe, expect, it } from 'vitest';
import { historyChanges, historyFacts, historyTitle, transactionTimeline } from '../src';

const ev = (id: string, action: string, extra: object = {}) => ({ id, at: `2026-11-0${id}T10:00:00.000Z`, actorId: 'u1', action, entityType: 'document', entityId: 'd1', data: null, relation: 'RECORD' as const, intact: true, ...extra });

describe('transaction history', () => {
  it('names known actions and makes others readable', () => {
    expect(historyTitle('document.posted')).toBe('Posted to the books');
    expect(historyTitle('bad_debts.marked_doubtful')).toBe('Marked doubtful');
    expect(historyTitle('x')).toBe('X');
  });

  it('pulls out plain facts and recorded changes', () => {
    expect(historyFacts({ number: 'INV-1', total: '1500.00', journalEntryId: 'j', nested: { a: 1 } })).toEqual([{ key: 'number', value: 'INV-1' }, { key: 'total', value: '1500.00' }]);
    expect(historyFacts(null)).toEqual([]);
    expect(historyChanges({ amount: { from: '8000.00', to: '10000.00' }, changed: { name: { from: 'A', to: 'B' }, receipt: { before: null, after: 'ALWAYS' } }, other: 3 })).toEqual([
      { field: 'amount', from: '8000.00', to: '10000.00' },
      { field: 'changed.name', from: 'A', to: 'B' },
      { field: 'changed.receipt', from: null, to: 'ALWAYS' },
    ]);
  });

  it('orders by the trail, drops repeats and reports tampered events', () => {
    const t = transactionTimeline([ev('9', 'allocation.created', { relation: 'ALLOCATION', actorId: 'u2' }), ev('3', 'document.draft_created'), ev('10', 'attachment.added', { intact: false }), ev('3', 'document.draft_created')]);
    expect(t.events.map((e) => [e.id, e.title])).toEqual([['3', 'Draft created'], ['9', 'Money applied'], ['10', 'File attached']]);
    expect(t.summary).toMatchObject({ events: 3, people: 2, tampered: ['10'] });
    expect(transactionTimeline([]).summary).toEqual({ events: 0, people: 0, first: null, last: null, tampered: [] });
  });
});
