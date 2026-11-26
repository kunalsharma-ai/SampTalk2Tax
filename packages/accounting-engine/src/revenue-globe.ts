import { D, type Dec } from './money';

/**
 * Revenue distribution globe (DASH-025): where revenue comes from, by the customer's country, and
 * within the organisation's home country by state (India: the invoice's GST place of supply, or
 * the customer's state). Each place carries an approximate centre (latitude, longitude) so it can
 * be drawn on a globe; the positions are for drawing only, never for tax. Pure: the caller reads
 * posted invoices and credit notes and says where each customer is.
 */
export interface GlobeSale {
  contactId: string;
  /** ISO 3166 two-letter code; null when the sale went abroad but the country is not recorded. */
  country: string | null;
  /** State within the home country (India: GST state code); null when not recorded. */
  state: string | null;
  month: string;
  /** Revenue in the functional currency; credit notes negative. */
  amount: string;
}

export type GlobePlaceKind = 'COUNTRY' | 'STATE' | 'UNPLACED';
export interface GlobePlace {
  key: string;
  kind: GlobePlaceKind;
  /** Country code, or the state code for a state. */
  code: string | null;
  name: string;
  country: string | null;
  lat: number | null;
  lon: number | null;
  amount: string;
  /** Share of the total, 0..1, four decimals; 0 when the total is not positive. */
  share: string;
  customers: number;
  /** One per month, in order. */
  values: string[];
}
export interface RevenueGlobe {
  homeCountry: string;
  months: string[];
  places: GlobePlace[];
  monthTotals: string[];
  total: string;
  home: string;
  abroad: string;
  /** Share earned outside the home country, 0..1. */
  abroadShare: string;
  countries: number;
  customers: number;
}

/** Approximate centres of countries (latitude, longitude), for drawing only. */
export const COUNTRY_CENTRES: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  IN: [22, 79],
  US: [39.8, -98.6],
  CA: [56, -106],
  MX: [23.6, -102.5],
  BR: [-10, -52],
  AR: [-34, -64],
  CL: [-30, -71],
  CO: [4, -73],
  PE: [-9, -75],
  GB: [54, -2],
  IE: [53.4, -8],
  FR: [46.6, 2.4],
  DE: [51.2, 10.4],
  NL: [52.2, 5.3],
  BE: [50.6, 4.6],
  LU: [49.8, 6.1],
  CH: [46.8, 8.2],
  AT: [47.6, 14.1],
  IT: [42.8, 12.6],
  ES: [40.2, -3.7],
  PT: [39.6, -8],
  SE: [62, 15],
  NO: [61, 9],
  DK: [56, 10],
  FI: [64, 26],
  PL: [52, 19.4],
  CZ: [49.8, 15.5],
  HU: [47.2, 19.5],
  RO: [45.9, 25],
  GR: [39.1, 22],
  TR: [39, 35],
  RU: [61.5, 105],
  UA: [49, 31.4],
  IL: [31.4, 35],
  SA: [24, 45],
  AE: [24, 54],
  QA: [25.3, 51.2],
  KW: [29.3, 47.6],
  OM: [21, 57],
  BH: [26, 50.55],
  EG: [26.8, 30.8],
  NG: [9, 8.7],
  KE: [0.2, 37.9],
  ZA: [-29, 24.7],
  MA: [31.8, -7.1],
  GH: [7.9, -1],
  PK: [30, 70],
  BD: [23.7, 90.4],
  LK: [7.9, 80.8],
  NP: [28.4, 84.1],
  BT: [27.5, 90.4],
  MV: [3.2, 73.2],
  CN: [35, 104],
  HK: [22.3, 114.2],
  TW: [23.7, 121],
  JP: [36.2, 138.3],
  KR: [36.5, 127.9],
  SG: [1.35, 103.8],
  MY: [4.2, 102],
  TH: [15.9, 100.9],
  VN: [14.1, 108.3],
  ID: [-2.5, 118],
  PH: [12.9, 121.8],
  AU: [-25.3, 133.8],
  NZ: [-41, 174.9],
  MU: [-20.3, 57.6],
});

/** Approximate centres of Indian states and union territories by GST state code, for drawing only. */
export const INDIA_STATE_CENTRES: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  '01': [33.7, 75],
  '02': [31.9, 77.2],
  '03': [30.9, 75.4],
  '04': [30.73, 76.78],
  '05': [30.1, 79.2],
  '06': [29.1, 76.1],
  '07': [28.65, 77.2],
  '08': [26.6, 73.8],
  '09': [26.9, 80.9],
  '10': [25.6, 85.6],
  '11': [27.5, 88.5],
  '12': [28, 94.5],
  '13': [26.1, 94.5],
  '14': [24.7, 93.9],
  '15': [23.3, 92.8],
  '16': [23.8, 91.6],
  '17': [25.5, 91.3],
  '18': [26.2, 92.9],
  '19': [23, 87.8],
  '20': [23.6, 85.3],
  '21': [20.5, 84.4],
  '22': [21.3, 81.9],
  '23': [23.5, 78.5],
  '24': [22.7, 71.6],
  '26': [20.4, 72.9],
  '27': [19.4, 76.1],
  '29': [15, 75.7],
  '30': [15.4, 74],
  '31': [10.6, 72.6],
  '32': [10.4, 76.4],
  '33': [11.1, 78.4],
  '34': [11.9, 79.8],
  '35': [11.7, 92.7],
  '36': [17.9, 79],
  '37': [15.9, 79.7],
  '38': [34.2, 77.6],
});

let regionNames: Intl.DisplayNames | null = null;
/** The English name of a country code (Intl), or the code itself. */
export function countryName(code: string): string {
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

export function revenueGlobe(input: { sales: GlobeSale[]; months: string[]; homeCountry: string; stateNames?: Record<string, string>; scale: number }): RevenueGlobe {
  const home = input.homeCountry.toUpperCase();
  const col = new Map(input.months.map((m, i) => [m, i]));
  const places = new Map<string, { kind: GlobePlaceKind; code: string | null; name: string; country: string | null; lat: number | null; lon: number | null; values: Dec[]; customers: Set<string> }>();
  const place = (s: GlobeSale) => {
    const country = s.country?.toUpperCase() ?? null;
    if (country === null) return { key: 'abroad-unknown', kind: 'UNPLACED' as const, code: null, name: 'Abroad, country not recorded', country: null, at: null };
    if (country === home && s.state) {
      const at = home === 'IN' ? (INDIA_STATE_CENTRES[s.state] ?? null) : null;
      const name = input.stateNames?.[s.state] ?? `State ${s.state}`;
      return { key: `${home}-${s.state}`, kind: at ? ('STATE' as const) : ('UNPLACED' as const), code: s.state, name, country: home, at };
    }
    const at = COUNTRY_CENTRES[country] ?? null;
    const name = country === home && home === 'IN' ? 'India, state not recorded' : countryName(country);
    return { key: country, kind: at ? ('COUNTRY' as const) : ('UNPLACED' as const), code: country, name, country, at };
  };
  for (const s of input.sales) {
    const i = col.get(s.month);
    if (i === undefined) continue;
    const p = place(s);
    let e = places.get(p.key);
    if (!e) {
      e = { kind: p.kind, code: p.code, name: p.name, country: p.country, lat: p.at?.[0] ?? null, lon: p.at?.[1] ?? null, values: input.months.map(() => new D(0)), customers: new Set() };
      places.set(p.key, e);
    }
    e.values[i] = e.values[i].plus(s.amount);
    e.customers.add(s.contactId);
  }
  const fx = (d: Dec) => d.toFixed(input.scale);
  const sum = (xs: Dec[]) => xs.reduce((t, x) => t.plus(x), new D(0));
  const rows = [...places.entries()].map(([key, e]) => ({ key, e, total: sum(e.values) })).filter((r) => !r.total.isZero() || r.e.values.some((v) => !v.isZero()));
  const total = sum(rows.map((r) => r.total));
  rows.sort((a, b) => b.total.comparedTo(a.total) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const share = (d: Dec) => (total.gt(0) ? d.div(total).toDecimalPlaces(4).toFixed(4) : '0.0000');
  const abroad = sum(rows.filter((r) => r.e.country !== home).map((r) => r.total));
  const monthTotals = input.months.map((_, i) => fx(sum(rows.map((r) => r.e.values[i]))));
  const customers = new Set(rows.flatMap((r) => [...r.e.customers]));
  return {
    homeCountry: home,
    months: input.months,
    places: rows.map((r) => ({
      key: r.key,
      kind: r.e.kind,
      code: r.e.code,
      name: r.e.name,
      country: r.e.country,
      lat: r.e.lat,
      lon: r.e.lon,
      amount: fx(r.total),
      share: share(r.total),
      customers: r.e.customers.size,
      values: r.e.values.map(fx),
    })),
    monthTotals,
    total: fx(total),
    home: fx(total.minus(abroad)),
    abroad: fx(abroad),
    abroadShare: share(abroad),
    countries: new Set(rows.map((r) => r.e.country).filter((c): c is string => c !== null)).size,
    customers: customers.size,
  };
}
