import { describe, expect, it } from 'vitest';
import { addDays } from '../src/documents';
import { collectionPriorities, type PriorityCustomer, type PriorityInvoice } from '../src/collection-priorities';

const T = '2026-11-21';
const inv = (id: string, dueIn: number, outstanding: string, lateChance: number, disputed = '0'): PriorityInvoice => ({ id, number: id.toUpperCase(), dueDate: addDays(T, dueIn), outstanding, lateChance, disputed });
const cust = (name: string, invoices: PriorityInvoice[], extra: Partial<PriorityCustomer> = {}): PriorityCustomer => ({ contactId: name, name, email: `${name}@x.test`, creditHold: false, lastReminderOn: null, invoices, ...extra });

describe('collection priorities (AR-034)', () => {
  it('ranks by money to chase, age, chance of lateness and contact, with the points behind each', () => {
    const r = collectionPriorities(
      [
        cust('big-old', [inv('a', -75, '100000.00', 100)]),
        cust('small-new', [inv('b', -5, '10000.00', 100)]),
        cust('reminded', [inv('c', -40, '50000.00', 100)], { lastReminderOn: addDays(T, -3) }),
        cust('nothing', [inv('d', 20, '5000.00', 10)]),
      ],
      T,
      2,
    );
    expect(r.map((x) => [x.name, x.rank, x.score, x.action])).toEqual([
      ['big-old', 1, 90, 'CALL_AND_HOLD'],
      ['reminded', 2, 55, 'WAIT'],
      ['small-new', 3, 42, 'REMIND'],
    ]);
    expect(r[0]!.factors.map((f) => [f.key, f.points])).toEqual([['AMOUNT', 40], ['AGE', 20], ['LIKELY_LATE', 20], ['DUE_SOON', 0], ['NOT_CONTACTED', 10]]);
    expect(r[0]!).toMatchObject({ open: '100000.00', overdue: '100000.00', toChase: '100000.00', oldestOverdueDays: 75, overdueInvoices: 1 });
    expect(r[1]!.factors.find((f) => f.key === 'NOT_CONTACTED')).toMatchObject({ points: 0, detail: 'Last reminder 3 days ago' });
  });

  it('leaves disputed money out and says to settle a dispute that covers everything overdue', () => {
    const r = collectionPriorities([cust('x', [inv('a', -50, '30000.00', 100, '30000.00'), inv('b', 30, '1000.00', 20)]), cust('y', [inv('c', -10, '20000.00', 100, '5000.50')])], T, 2);
    const x = r.find((p) => p.name === 'x')!;
    expect(x).toMatchObject({ action: 'SETTLE_DISPUTE', toChase: '0.00', disputed: '30000.00', overdue: '30000.00' });
    expect(x.factors[0]).toMatchObject({ points: 0, detail: 'Everything overdue is disputed' });
    const y = r.find((p) => p.name === 'y')!;
    expect(y).toMatchObject({ toChase: '14999.50', action: 'REMIND', rank: 1 });
    expect(y.factors[0]!.points).toBe(40);
  });

  it('suggests a friendly note for an invoice due within a week that is likely late, and a call on credit hold', () => {
    const r = collectionPriorities([cust('soon', [inv('a', 5, '8000.00', 70)]), cust('held', [inv('b', -95, '1000.00', 100)], { creditHold: true, lastReminderOn: addDays(T, -10) })], T, 2);
    expect(r.find((p) => p.name === 'soon')).toMatchObject({ action: 'NUDGE', oldestOverdueDays: 0 });
    expect(r.find((p) => p.name === 'soon')!.factors.find((f) => f.key === 'DUE_SOON')!.points).toBe(5);
    const held = r.find((p) => p.name === 'held')!;
    expect(held).toMatchObject({ action: 'CALL' });
    expect(held.factors.find((f) => f.key === 'NOT_CONTACTED')!.points).toBe(5);
    expect(collectionPriorities([], T, 2)).toEqual([]);
  });
});
