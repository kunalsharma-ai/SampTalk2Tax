import { describe, expect, it } from 'vitest';
import { CARD_FEED_TOKEN_PATTERN, cardClaimMatches, cardFeedTokenPrefix, cardJournalLines, cardLimitStatus, makeCardFeedToken, normaliseCardTransactions } from '../src';

const cards = [
  { id: 'c1', last4: '4242', providerRef: 'card_A1', status: 'ACTIVE' as const },
  { id: 'c2', last4: '1111', providerRef: null, status: 'FROZEN' as const },
  { id: 'c3', last4: '1111', providerRef: 'card_C3', status: 'ACTIVE' as const },
  { id: 'c4', last4: null, providerRef: null, status: 'REQUESTED' as const },
];
const opts = { currency: 'INR', today: '2026-11-23', cards };

describe('company cards', () => {
  it('makes provider tokens', () => {
    let i = 0;
    const t = makeCardFeedToken((n) => Uint8Array.from({ length: n }, () => i++ % 256));
    expect(CARD_FEED_TOKEN_PATTERN.test(t)).toBe(true);
    expect(cardFeedTokenPrefix(t)).toHaveLength(8);
  });

  it('checks a delivery of card transactions and says why each refused one is refused', () => {
    const r = normaliseCardTransactions(
      [
        { id: 't1', card: 'card_A1', date: '2026-11-20', amount: '1250.50', merchant: 'Cloud Hosting Co', mcc: '7372' },
        { id: 't2', card: '4242', date: '2026-11-21', amount: '-200.00', merchant: 'Cloud Hosting Co', state: 'settled' },
        { id: 't3', card: 'card_C3', date: '2026-11-22', amount: '99', merchant: 'Cafe', state: 'AUTHORISED', currency: 'inr' },
        { id: 't1', card: 'card_A1', date: '2026-11-20', amount: '1.00', merchant: 'x' },
        { id: 't5', card: '1111', date: '2026-11-20', amount: '1.00', merchant: 'x' },
        { id: 't6', card: 'nope', date: '2026-11-31', amount: 12, merchant: '' },
        { id: 't7', card: 'c4', date: '2026-11-25', amount: '1.005', merchant: 'x', currency: 'USD', mcc: '12', state: 'PENDING' },
        'junk',
        { card: '4242', date: '2026-11-20', amount: '0', merchant: 'x' },
      ],
      opts,
    );
    expect(r.lines.map((l) => [l.externalId, l.cardId, l.date, l.amount.toFixed(2), l.merchant, l.mcc, l.state])).toEqual([
      ['t1', 'c1', '2026-11-20', '1250.50', 'Cloud Hosting Co', '7372', 'SETTLED'],
      ['t2', 'c1', '2026-11-21', '-200.00', 'Cloud Hosting Co', null, 'SETTLED'],
      ['t3', 'c3', '2026-11-22', '99.00', 'Cafe', null, 'AUTHORISED'],
    ]);
    expect(r.rejected).toEqual([
      { position: 4, id: 't1', reasons: ['the same id appears earlier in this delivery'] },
      { position: 5, id: 't5', reasons: ['more than one card ends in 1111; send the card reference'] },
      { position: 6, id: 't6', reasons: ['no card "nope" in this programme', 'date "2026-11-31" (use YYYY-MM-DD)', 'amount sent as a number; send it as a string, like "1250.00"', 'no merchant'] },
      { position: 7, id: 't7', reasons: ['the card has not been issued yet', 'dated in the future', 'amount "1.005" (at most 2 decimals)', 'currency USD; this programme is in INR (send the converted amount)', 'mcc must be four digits', 'state must be AUTHORISED or SETTLED'] },
      { position: 8, id: null, reasons: ['not an object'] },
      { position: 9, id: null, reasons: ['no id', 'amount is zero'] },
    ]);
  });

  it('works out where a card stands against its monthly limit', () => {
    expect(cardLimitStatus('10000', '2500.50')).toEqual({ limit: '10000.00', spent: '2500.50', remaining: '7499.50', usedPercent: 25, over: false });
    expect(cardLimitStatus('1000', '1200')).toEqual({ limit: '1000.00', spent: '1200.00', remaining: '0.00', usedPercent: 120, over: true });
    expect(cardLimitStatus(null, '5')).toEqual({ limit: null, spent: '5.00', remaining: null, usedPercent: null, over: false });
  });

  it('finds expense claim lines that look like the same spending, by the same person', () => {
    const lines = [
      { claimId: 'e1', claimNumber: 'EXP-0002', claimStatus: 'SUBMITTED', claimantId: 'u1', lineNo: 1, date: '2026-11-22', amount: '1250.50', merchant: 'Cloud Hosting' },
      { claimId: 'e2', claimNumber: 'EXP-0001', claimStatus: 'APPROVED', claimantId: 'u1', lineNo: 2, date: '2026-11-20', amount: '1250.50', merchant: null },
      { claimId: 'e3', claimNumber: 'EXP-0003', claimStatus: 'VOID', claimantId: 'u1', lineNo: 1, date: '2026-11-20', amount: '1250.50', merchant: null },
      { claimId: 'e4', claimNumber: 'EXP-0004', claimStatus: 'SUBMITTED', claimantId: 'u2', lineNo: 1, date: '2026-11-20', amount: '1250.50', merchant: null },
      { claimId: 'e5', claimNumber: 'EXP-0005', claimStatus: 'DRAFT', claimantId: 'u1', lineNo: 1, date: '2026-11-24', amount: '1250.50', merchant: null },
      { claimId: 'e6', claimNumber: 'EXP-0006', claimStatus: 'DRAFT', claimantId: 'u1', lineNo: 1, date: '2026-11-20', amount: '1250.00', merchant: null },
    ];
    expect(cardClaimMatches({ holderId: 'u1', date: '2026-11-20', amount: '1250.50' }, lines).map((m) => [m.claimNumber, m.lineNo, m.claimStatus])).toEqual([
      ['EXP-0001', 2, 'APPROVED'],
      ['EXP-0002', 1, 'SUBMITTED'],
    ]);
    expect(cardClaimMatches({ holderId: 'u1', date: '2026-11-20', amount: '-1250.50' }, lines)).toEqual([]);
  });

  it('posts spending and refunds against the card account', () => {
    expect(cardJournalLines({ amount: '1250.50', merchant: 'Cloud Hosting Co', note: 'November' }, 'exp', 'card')).toEqual([
      { accountId: 'exp', debit: '1250.50', description: 'Cloud Hosting Co · November' },
      { accountId: 'card', credit: '1250.50', description: 'Cloud Hosting Co · November' },
    ]);
    expect(cardJournalLines({ amount: '-200', merchant: 'Cloud Hosting Co', note: null }, 'exp', 'card')).toEqual([
      { accountId: 'card', debit: '200.00', description: 'Cloud Hosting Co' },
      { accountId: 'exp', credit: '200.00', description: 'Cloud Hosting Co' },
    ]);
  });
});
