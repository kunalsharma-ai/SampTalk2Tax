import { describe, expect, it } from 'vitest';
import { countryName, revenueGlobe } from '../src/revenue-globe';

const months = ['2026-10', '2026-11'];
const stateNames = { '27': 'Maharashtra', '29': 'Karnataka' };

describe('revenueGlobe', () => {
  it('places home revenue by state and the rest by country, largest first', () => {
    const g = revenueGlobe({
      homeCountry: 'IN',
      months,
      stateNames,
      scale: 2,
      sales: [
        { contactId: 'a', country: 'IN', state: '27', month: '2026-10', amount: '50000' },
        { contactId: 'a', country: 'IN', state: '27', month: '2026-11', amount: '30000' },
        { contactId: 'b', country: 'IN', state: '29', month: '2026-11', amount: '20000' },
        { contactId: 'c', country: 'US', state: null, month: '2026-11', amount: '60000' },
        { contactId: 'c', country: 'US', state: null, month: '2026-11', amount: '-10000' },
        { contactId: 'd', country: 'IN', state: null, month: '2026-10', amount: '5000' },
        { contactId: 'e', country: 'IN', state: '27', month: '2025-01', amount: '999' },
      ],
    });
    expect(g.places.map((p) => [p.key, p.kind, p.name, p.amount, p.share, p.customers])).toEqual([
      ['IN-27', 'STATE', 'Maharashtra', '80000.00', '0.5161', 1],
      ['US', 'COUNTRY', 'United States', '50000.00', '0.3226', 1],
      ['IN-29', 'STATE', 'Karnataka', '20000.00', '0.1290', 1],
      ['IN', 'COUNTRY', 'India, state not recorded', '5000.00', '0.0323', 1],
    ]);
    expect(g.places[0].values).toEqual(['50000.00', '30000.00']);
    expect(g.places[0].lat).toBeCloseTo(19.4);
    expect(g.total).toBe('155000.00');
    expect(g.monthTotals).toEqual(['55000.00', '100000.00']);
    expect([g.home, g.abroad, g.abroadShare]).toEqual(['105000.00', '50000.00', '0.3226']);
    expect([g.countries, g.customers]).toEqual([2, 4]);
  });

  it('keeps places it cannot draw, unnamed exports included', () => {
    const g = revenueGlobe({
      homeCountry: 'IN',
      months,
      scale: 2,
      sales: [
        { contactId: 'a', country: 'FJ', state: null, month: '2026-10', amount: '100' },
        { contactId: 'b', country: null, state: null, month: '2026-10', amount: '50' },
        { contactId: 'c', country: 'IN', state: '97', month: '2026-10', amount: '25' },
      ],
    });
    expect(g.places.map((p) => [p.key, p.kind, p.lat])).toEqual([
      ['FJ', 'UNPLACED', null],
      ['abroad-unknown', 'UNPLACED', null],
      ['IN-97', 'UNPLACED', null],
    ]);
    expect(g.places[1].name).toBe('Abroad, country not recorded');
    expect(g.abroad).toBe('150.00');
    expect(countryName('FJ')).toBe('Fiji');
  });

  it('gives nothing for empty books and no share when revenue is negative', () => {
    expect(revenueGlobe({ homeCountry: 'IN', months, scale: 2, sales: [] })).toMatchObject({
      places: [],
      total: '0.00',
      abroadShare: '0.0000',
      countries: 0,
      customers: 0,
      monthTotals: ['0.00', '0.00'],
    });
    const g = revenueGlobe({ homeCountry: 'GB', months, scale: 2, sales: [{ contactId: 'a', country: 'GB', state: null, month: '2026-11', amount: '-10' }] });
    expect(g.places[0]).toMatchObject({ kind: 'COUNTRY', name: 'United Kingdom', share: '0.0000' });
  });
});
