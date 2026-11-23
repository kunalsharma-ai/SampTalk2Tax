import { describe, expect, it } from 'vitest';
import { BANK_FEED_TOKEN_PATTERN, bankFeedHealth, bankFeedOutcome, bankFeedTokenPrefix, makeBankFeedToken, normaliseFeedTransactions } from '../src';

const rnd = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256);

describe('bank feed transactions', () => {
  it('accepts signed and directed amounts and refuses what it cannot trust', () => {
    const r = normaliseFeedTransactions(
      [
        { id: 'tx-1', date: '2026-11-20', amount: '1,250.50', description: '  NEFT from  Acme ', reference: 'UTR123' },
        { id: 'tx-2', date: '2026-11-21', amount: '99.00', direction: 'debit', description: 'Card fee' },
        { id: 'tx-3', date: '2026-11-21', amount: -40, description: 'number' },
        { id: 'tx-1', date: '2026-11-21', amount: '1.00', description: 'repeat' },
        { id: 'tx-4', date: '2026-02-30', amount: '1.005', description: '' },
        { id: 'tx-5', date: '2026-11-25', amount: '-5', direction: 'CREDIT', description: 'x', currency: 'USD' },
        'nope',
        { id: 'tx-6', date: '2026-11-24', amount: '0.00', description: 'tomorrow but zero' },
      ],
      { currency: 'INR', today: '2026-11-23' },
    );
    expect(r.lines.map((l) => [l.externalId, l.amount.toFixed(2), l.description, l.reference])).toEqual([
      ['tx-1', '1250.50', 'NEFT from Acme', 'UTR123'],
      ['tx-2', '-99.00', 'Card fee', null],
    ]);
    expect(r.rejected.map((x) => [x.position, x.id, x.reasons.length])).toEqual([
      [3, 'tx-3', 1],
      [4, 'tx-1', 1],
      [5, 'tx-4', 3],
      [6, 'tx-5', 3],
      [7, null, 1],
      [8, 'tx-6', 1],
    ]);
    expect(r.rejected[0]!.reasons[0]).toMatch(/as a string/);
    expect(r.rejected[1]!.reasons[0]).toMatch(/earlier in this delivery/);
    expect(r.rejected[3]!.reasons).toEqual(['dated in the future', 'a direction with a negative amount; send one or the other', 'currency USD; this account is in INR']);
  });

  it('allows no decimals for a zero-decimal currency', () => {
    const r = normaliseFeedTransactions([{ id: 'a', date: '2026-01-01', amount: '1500.5', description: 'x' }, { id: 'b', date: '2026-01-01', amount: '1500', description: 'y' }], { currency: 'JPY', today: '2026-01-02' });
    expect(r.lines.map((l) => l.externalId)).toEqual(['b']);
    expect(r.rejected[0]!.reasons[0]).toMatch(/no decimals/);
  });
});

describe('bank feed tokens, outcomes and health', () => {
  it('makes tokens of the expected shape', () => {
    const t = makeBankFeedToken(rnd);
    expect(BANK_FEED_TOKEN_PATTERN.test(t)).toBe(true);
    expect(bankFeedTokenPrefix(t)).toHaveLength(8);
  });

  it('names the outcome of a delivery', () => {
    expect(bankFeedOutcome({ imported: 1, duplicates: 0, rejected: 3 })).toBe('IMPORTED');
    expect(bankFeedOutcome({ imported: 0, duplicates: 2, rejected: 0 })).toBe('NOTHING_NEW');
    expect(bankFeedOutcome({ imported: 0, duplicates: 2, rejected: 1 })).toBe('REJECTED');
  });

  it('tells healthy, late, failing and waiting feeds apart', () => {
    const now = new Date('2026-11-23T12:00:00Z');
    const base = { status: 'ACTIVE' as const, createdAt: new Date('2026-11-23T08:00:00Z'), expectEveryHours: 6, lastDeliveryAt: null, lastOutcome: null, lastAcceptedAt: null };
    expect(bankFeedHealth(base, now).health).toBe('WAITING');
    expect(bankFeedHealth({ ...base, createdAt: new Date('2026-11-22T00:00:00Z') }, now).health).toBe('LATE');
    const ok = { ...base, lastDeliveryAt: new Date('2026-11-23T10:00:00Z'), lastOutcome: 'NOTHING_NEW' as const, lastAcceptedAt: new Date('2026-11-23T10:00:00Z') };
    expect(bankFeedHealth(ok, now).health).toBe('HEALTHY');
    expect(bankFeedHealth({ ...ok, lastAcceptedAt: new Date('2026-11-23T01:00:00Z') }, now)).toEqual({ health: 'LATE', message: 'Nothing for 11 hours; expected every 6' });
    expect(bankFeedHealth({ ...ok, lastOutcome: 'REJECTED' }, now).health).toBe('FAILING');
    expect(bankFeedHealth({ ...ok, status: 'PAUSED' }, now).health).toBe('PAUSED');
  });
});
