import { describe, expect, it } from 'vitest';
import { normaliseNarration, unusualBankActivity, type BankActivityLine } from '../src/bank-activity';
import { addDays } from '../src/documents';

const T = '2026-11-21';
let n = 0;
const line = (ago: number, amount: string, description: string, extra: Partial<BankActivityLine> = {}): BankActivityLine => ({ id: `l${++n}`, accountId: 'bank', date: addDays(T, -ago), amount, description, matched: true, ...extra });
const money = (a: string) => `₹${a}`;
const codes = (f: { indicators: { code: string }[] }) => f.indicators.map((i) => i.code);
/** Ordinary history: twelve small receipts and payments over the last half year. */
const history = () => Array.from({ length: 12 }, (_, k) => line(170 - k * 10, k % 2 ? '-4000.00' : '6000.00', k % 2 ? `UPI DR VENDOR ${k}` : `NEFT CR CUSTOMER ${k}`));

describe('unusual bank activity (BANK-019)', () => {
  it('normalises narrations without numbers or punctuation', () => {
    expect(normaliseNarration('NEFT-CR/UTR 99812 Lotus  Retail')).toBe('neft cr utr lotus retail');
  });

  it('flags duplicates, splitting under the threshold and money straight in and out', () => {
    n = 0;
    const lines = [
      ...history(),
      line(10, '-25000.00', 'IMPS TEAK SUPPLIES REF 1'),
      line(9, '-25000.00', 'IMPS TEAK SUPPLIES REF 2'),
      line(6, '48000.00', 'CASH DEPOSIT'),
      line(5, '49500.00', 'CASH DEPOSIT BRANCH 2'),
      line(3, '47000.00', 'CASH DEPOSIT'),
      line(2, '300000.00', 'RTGS CR UNKNOWN PARTY'),
      line(1, '-295000.00', 'RTGS DR ONWARD TRANSFER'),
    ];
    const f = unusualBankActivity(lines, T, money);
    const by = (amount: string) => f.find((x) => x.line.amount === amount)!;
    expect(codes(by('-25000.00'))).toEqual(['DUPLICATE']);
    expect(by('-25000.00').indicators[0]!.detail).toMatch(/Same amount and narration as the line of/);
    expect(codes(by('48000.00'))).toEqual(['JUST_UNDER']);
    expect(by('49500.00').indicators[0]!.detail).toBe('One of 3 credits within 7 days each just under ₹50000');
    expect(by('-295000.00')).toMatchObject({ level: 'HIGH' });
    expect(codes(by('-295000.00'))).toEqual(['PASS_THROUGH', 'NEW_PAYEE', 'ROUND']);
    expect(by('-295000.00').indicators[0]!.detail).toBe('Paid out 1 day after ₹300000.00 came in');
    expect(codes(by('300000.00'))).toEqual(['LARGE', 'ROUND']);
    // Most serious first, newest first within a level.
    expect(f.map((x) => x.level)).toEqual(['HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'MEDIUM']);
    expect(f[0]!.line.amount).toBe('-295000.00');
    // The history itself is ordinary.
    expect(f.some((x) => x.line.description.includes('CUSTOMER'))).toBe(false);
  });

  it('flags money out not in the books, and keeps to the window', () => {
    n = 0;
    const f = unusualBankActivity([line(20, '-1500.00', 'POS SOMEWHERE', { matched: false }), line(10, '-1500.00', 'POS ELSEWHERE', { matched: false }), line(40, '-900.00', 'OLD ONE', { matched: false })], T, money);
    expect(f.map((x) => [x.line.description, codes(x)])).toEqual([['POS SOMEWHERE', ['NOT_RECORDED']]]);
    expect(f[0]!.indicators[0]!.detail).toBe('Left the bank 20 days ago and still not matched to anything in the books');
    expect(unusualBankActivity([line(40, '-900.00', 'OLD ONE', { matched: false })], T, money, { days: 60 })).toHaveLength(1);
  });

  it('needs enough history before calling something large or a payee new', () => {
    n = 0;
    const f = unusualBankActivity([line(30, '1000.00', 'A'), line(20, '-150000.00', 'NEW VENDOR LTD')], T, money);
    expect(f.map(codes)).toEqual([['ROUND']]);
    const two = unusualBankActivity([line(30, '-60000.00', 'X'), line(29, '-45500.00', 'Y'), line(28, '-46000.00', 'Z')], T, money, { threshold: '50000' });
    expect(two.map(codes)).toEqual([]);
  });

  it('uses another threshold for splitting', () => {
    n = 0;
    const f = unusualBankActivity([line(3, '-9500.00', 'A'), line(2, '-9200.00', 'B'), line(1, '-9900.00', 'C')], T, money, { threshold: '10000' });
    expect(f.map(codes)).toEqual([['JUST_UNDER'], ['JUST_UNDER'], ['JUST_UNDER']]);
  });
});
