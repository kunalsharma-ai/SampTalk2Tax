import { describe, expect, it } from 'vitest';
import { concentrationLevel, financialDependencies } from '../src';

const p = (id: string, amount: string) => ({ id, name: id, amount });

describe('financial dependencies', () => {
  it('shares, concentration and the dependencies worth watching', () => {
    const r = financialDependencies({
      customers: [p('Asha', '450'), p('Banyan', '300'), p('Cedar', '150'), p('Deodar', '100'), p('Zero', '0'), p('Refund', '-20')],
      vendors: [p('V1', '100'), p('V2', '100'), p('V3', '100'), p('V4', '100'), p('V5', '100')],
      cash: [p('Main bank', '950'), p('Petty cash', '50')],
      borrowing: [p('Term loan', '1500'), p('Card', '500')],
      top: 3,
      scale: 2,
    });
    expect(r.groups.CUSTOMERS).toEqual({
      group: 'CUSTOMERS',
      total: '1000.00',
      count: 4,
      hhi: 3250, // 45² + 30² + 15² + 10²
      concentration: 'HIGH',
      largestShare: 45,
      parties: [{ id: 'Asha', name: 'Asha', amount: '450.00', share: 45 }, { id: 'Banyan', name: 'Banyan', amount: '300.00', share: 30 }, { id: 'Cedar', name: 'Cedar', amount: '150.00', share: 15 }],
      others: { count: 1, amount: '100.00', share: 10 },
    });
    expect(r.groups.VENDORS).toMatchObject({ hhi: 2000, concentration: 'MODERATE', largestShare: 20 });
    expect(r.dependencies.map((d) => `${d.severity} ${d.group} ${d.name} ${d.share}`)).toEqual([
      'CRITICAL CUSTOMERS Asha 45',
      'HIGH BORROWING All borrowing 200',
      'HIGH CASH Main bank 95',
      'HIGH BORROWING Term loan 75',
      'HIGH CUSTOMERS Banyan 30',
      'WATCH VENDORS V1 20',
      'WATCH VENDORS V2 20',
      'WATCH VENDORS V3 20',
      'WATCH CUSTOMERS Cedar 15',
    ]);
    expect(r.dependencies.find((d) => d.id === 'ALL')!.reason).toBe('Borrowing is 2 times the cash held');
  });

  it('does not flag one cash account, and is empty without data', () => {
    const r = financialDependencies({ customers: [], vendors: [], cash: [p('Only bank', '10')], borrowing: [], scale: 2 });
    expect(r.dependencies).toEqual([]);
    expect(r.groups.CUSTOMERS).toMatchObject({ total: '0.00', count: 0, hhi: 0, concentration: null, largestShare: null, parties: [] });
    expect([1499, 1500, 2500, 2501].map(concentrationLevel)).toEqual(['LOW', 'MODERATE', 'MODERATE', 'HIGH']);
  });
});
