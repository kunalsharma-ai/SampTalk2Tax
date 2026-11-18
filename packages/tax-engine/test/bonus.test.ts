import { D } from '@talk2tax/accounting-engine';
import { describe, expect, it } from 'vitest';
import { BonusRuleError, bonusYearMonths, statutoryBonus } from '../src';

const month = (period: string, wages: string, paidDays = '30', fullMonthWages?: string) => ({ period, wages: new D(wages), paidDays: new D(paidDays), fullMonthWages: fullMonthWages ? new D(fullMonthWages) : undefined });
const year = (wages: string) => bonusYearMonths('2025-26').map((p) => month(p, wages));

describe('statutory bonus', () => {
  it('lists the twelve months of an April-March year', () => {
    expect(bonusYearMonths('2025-26')).toEqual(['2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03']);
    expect(() => bonusYearMonths('2025-27')).toThrow(BonusRuleError);
    expect(() => bonusYearMonths('25-26')).toThrow(BonusRuleError);
  });

  it('caps each month at the calculation ceiling', () => {
    // 12 x 7,000 x 8.33% = 6,997.20
    expect(statutoryBonus(year('15000'), { ratePct: '8.33' })).toMatchObject({ eligible: true, bonusWages: '84000.00', bonus: '6997.20' });
    // At 20%: 16,800.
    expect(statutoryBonus(year('15000'), { ratePct: '20' }).bonus).toBe('16800.00');
    // Below the ceiling, the wages themselves count.
    expect(statutoryBonus(year('6000'), { ratePct: '8.33' })).toMatchObject({ bonusWages: '72000.00', bonus: '5997.60' });
  });

  it('uses a higher ceiling, such as the state minimum wage', () => {
    expect(statutoryBonus(year('15000'), { ratePct: '8.33', calculationCeiling: '12000' }).bonus).toBe('11995.20');
  });

  it('leaves out months above the eligibility amount', () => {
    const months = [...bonusYearMonths('2025-26').slice(0, 6).map((p) => month(p, '20000')), ...bonusYearMonths('2025-26').slice(6).map((p) => month(p, '25000'))];
    const r = statutoryBonus(months, { ratePct: '10' });
    expect(r).toMatchObject({ eligible: true, bonusWages: '42000.00', bonus: '4200.00' });
    expect(r.months.filter((m) => !m.eligible)).toHaveLength(6);
    expect(statutoryBonus(year('30000'), { ratePct: '10' })).toMatchObject({ eligible: false, bonus: '0.00', reason: 'Wages were above 21000 a month all year' });
    // Unpaid leave does not make a high earner eligible: the full-month wage decides.
    expect(statutoryBonus([month('2025-04', '15000', '15', '30000'), month('2025-05', '30000', '31')], { ratePct: '10' }).eligible).toBe(false);
  });

  it('needs 30 days worked, then pays at least Rs 100', () => {
    expect(statutoryBonus([month('2026-03', '7000', '20')], { ratePct: '8.33' })).toMatchObject({ eligible: false, reason: 'Worked fewer than 30 days in the year', bonus: '0.00' });
    expect(statutoryBonus([month('2026-02', '500', '28'), month('2026-03', '500', '31')], { ratePct: '8.33' })).toMatchObject({ eligible: true, atRate: '83.30', bonus: '100.00', daysWorked: '59' });
    expect(statutoryBonus([], { ratePct: '8.33' })).toMatchObject({ eligible: false, reason: 'Not paid in the year' });
  });

  it('refuses a rate outside 8.33% to 20% and a ceiling of zero', () => {
    expect(() => statutoryBonus(year('10000'), { ratePct: '8' })).toThrow('from 8.33% to 20%');
    expect(() => statutoryBonus(year('10000'), { ratePct: '20.01' })).toThrow(BonusRuleError);
    expect(() => statutoryBonus(year('10000'), { ratePct: '10', calculationCeiling: '0' })).toThrow('calculation ceiling');
  });
});
