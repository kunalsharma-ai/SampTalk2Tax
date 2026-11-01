import { D, Dec, dec } from '@talk2tax/accounting-engine';
import { taxYearOf } from './withholding';

/**
 * India monthly payroll: earnings, the Code on Social Security 2020 "wages",
 * EPF/EPS/EDLI, ESI, professional tax and income tax deducted from salary
 * (Income-tax Act 2025 s.392, new tax regime).
 *
 * Every statutory figure below carries its source and the date it applies from,
 * because they change by notification. The functions are pure: callers supply
 * the employee's history (earlier payslips in the tax year and contribution period).
 *
 * Not modelled: the old tax regime, exemptions and deductions an employee
 * declares (none apply under the new regime except the standard deduction and
 * employer NPS), perquisites, arrears, gratuity, bonus under the Code, labour
 * welfare fund, professional tax outside Maharashtra, ESI on daily wages up to
 * Rs 176 (no employee share), and the EPF administrative-charge minimum per establishment.
 */

export const COMPONENT_KINDS = ['WAGES', 'EXCLUDED'] as const;
/**
 * WAGES: part of "wages" under the Code on Social Security 2020 s.2(88): basic pay,
 * dearness allowance, retaining allowance and any other pay not excluded.
 * EXCLUDED: one of the items s.2(88) leaves out of wages (HRA, conveyance, bonus,
 * commission, overtime and so on). If those exceed half of total remuneration,
 * the excess counts as wages (the proviso to s.2(88)).
 */
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export const PT_CATEGORIES = ['GENERAL', 'WOMAN', 'EXEMPT'] as const;
/** GENERAL: the standard slab. WOMAN: Maharashtra's slab for women. EXEMPT: an exemption under the state's Act (for example age 65+, disability). */
export type PtCategory = (typeof PT_CATEGORIES)[number];

export interface DatedValue {
  from: string;
  value: string;
  source: string;
}

/** EPF and EPS wage ceiling per month. */
export const PF_WAGE_CEILINGS: DatedValue[] = [
  { from: '2014-09-01', value: '15000', source: 'EPF Scheme 1952 para 2(f), as amended from 1 September 2014' },
  { from: '2026-09-17', value: '25000', source: 'Notification S.O. 5109(E) of 17 September 2026 (EPF Scheme 2026)' },
];

export const PF_RATES = {
  /** Employee share, of PF wages. */
  employee: '12',
  /** Employer share in total, of PF wages; EPS is taken out of it. */
  employer: '12',
  /** Employees' Pension Scheme, of PF wages capped at the ceiling. */
  eps: '8.33',
  /** Employees' Deposit-Linked Insurance, of PF wages capped at the ceiling. */
  edli: '0.5',
  /** EPF administrative charges, of PF wages. */
  admin: '0.5',
  source: 'EPF Scheme para 29; EPS para 3; EDLI Scheme para 8; EPFO administrative charges from 1 June 2018',
} as const;

export const ESI_RULES = {
  /** Employees whose ESI wages are at or below this at the start of a contribution period are covered for the whole period. */
  ceiling: '21000',
  employee: '0.75',
  employer: '3.25',
  source: 'ESI (Central) Rules rule 50 (Rs 21,000 from 1 January 2017); contribution rates from 1 July 2019',
} as const;

export interface PtSlab {
  /** Applies when monthly gross is above this (or always when null). */
  above: string | null;
  monthly: string;
  /** Amount in February instead of `monthly`, if different. */
  february?: string;
}

/** Maharashtra State Tax on Professions, Trades, Callings and Employments Act 1975, Schedule I entry 1. */
export const PT_MAHARASHTRA: Record<Exclude<PtCategory, 'EXEMPT'>, PtSlab[]> = {
  GENERAL: [
    { above: '7500', monthly: '175' },
    { above: '10000', monthly: '200', february: '300' },
  ],
  WOMAN: [{ above: '25000', monthly: '200', february: '300' }],
};

export const PT_STATES_SUPPORTED = ['27'] as const;

/** New tax regime (Income-tax Act 2025 s.202; rates in the Finance Act for the tax year). */
export const NEW_REGIME_2026_27 = {
  taxYear: '2026-27',
  slabs: [
    { upTo: '400000', rate: '0' },
    { upTo: '800000', rate: '5' },
    { upTo: '1200000', rate: '10' },
    { upTo: '1600000', rate: '15' },
    { upTo: '2000000', rate: '20' },
    { upTo: '2400000', rate: '25' },
    { upTo: null, rate: '30' },
  ],
  standardDeduction: '75000',
  /** Full rebate when total income does not exceed this; marginal relief just above it. */
  rebateIncomeLimit: '1200000',
  rebateMax: '60000',
  surcharge: [
    { above: '5000000', rate: '10' },
    { above: '10000000', rate: '15' },
    { above: '20000000', rate: '25' },
  ],
  cess: '4',
  source: 'Income-tax Act 2025 s.202 (new regime default), s.392 (TDS on salary); slabs, Rs 75,000 standard deduction and Rs 60,000 rebate up to Rs 12 lakh as in the Finance Act 2025, unchanged by the Finance Act 2026',
} as const;

/** Rate when an employee with taxable income has not given a PAN (applied if higher than the normal monthly TDS). */
export const NO_PAN_SALARY_RATE = '20';

// ---------------------------------------------------------------- helpers

const rupee = (v: Dec) => v.toDecimalPlaces(0, D.ROUND_HALF_UP);
const rupeeUp = (v: Dec) => v.toDecimalPlaces(0, D.ROUND_UP);
const paise = (v: Dec) => v.toDecimalPlaces(2, D.ROUND_HALF_EVEN);
const pct = (v: Dec, rate: string) => v.times(rate).div(100);

export function daysInMonth(period: string): number {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function periodStart(period: string) {
  return `${period}-01`;
}

export function periodEnd(period: string) {
  return `${period}-${String(daysInMonth(period)).padStart(2, '0')}`;
}

/** ESI contribution periods run April–September and October–March. Returns the first month (YYYY-MM) of the period. */
export function esiContributionPeriodStart(period: string): string {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  if (m >= 4 && m <= 9) return `${y}-04`;
  return m >= 10 ? `${y}-10` : `${y - 1}-10`;
}

/** Months left in the tax year counting this one: 12 in April, 1 in March. */
export function monthsLeftInTaxYear(period: string): number {
  const m = Number(period.slice(5, 7));
  return m >= 4 ? 16 - m : 4 - m;
}

/** The tax-year label (for example 2026-27) for a month. */
export function taxYearLabel(period: string): string {
  return taxYearOf(periodStart(period)).label;
}

/** Day-weighted PF wage ceiling for each part of the month (a ceiling change mid-month splits the month). */
export function pfCeilingSegments(period: string): { days: number; ceiling: Dec }[] {
  const n = daysInMonth(period);
  const end = periodEnd(period);
  const out: { days: number; ceiling: Dec }[] = [];
  let day = 1;
  while (day <= n) {
    const iso = `${period}-${String(day).padStart(2, '0')}`;
    const current = [...PF_WAGE_CEILINGS].reverse().find((c) => c.from <= iso)!;
    const next = PF_WAGE_CEILINGS.find((c) => c.from > iso && c.from <= end);
    const last = next ? Number(next.from.slice(8, 10)) - 1 : n;
    out.push({ days: last - day + 1, ceiling: dec(current.value) });
    day = last + 1;
  }
  return out;
}

// ---------------------------------------------------------------- inputs and outputs

export interface PayComponentInput {
  code: string;
  name: string;
  kind: ComponentKind;
  /** Full-month amount. */
  monthly: string;
}

export interface OneOffInput {
  name: string;
  kind: ComponentKind;
  amount: string;
}

export interface PayslipInput {
  period: string;
  /** Days the employee is paid for (whole or half days), at most the days in the month. */
  paidDays: string;
  components: PayComponentInput[];
  oneOffs?: OneOffInput[];
  pf: { member: boolean; eps: boolean; onFullWages: boolean };
  /**
   * ESI coverage, decided once per contribution period. `null` when this is the
   * employee's first month in the period: coverage is then decided on this month's
   * full-month wages.
   */
  esiCoveredForPeriod: boolean | null;
  pt: { stateCode: string | null; category: PtCategory };
  tax: {
    /** Taxable salary already paid this tax year (earlier payslips and any previous employer). */
    incomeBefore: string;
    /** Tax already deducted from salary this tax year (including any previous employer). */
    tdsBefore: string;
    /** Further months this employee is expected to be paid in the tax year after this one (0 in March or the month they leave). */
    futureMonths: number;
    /** Whether the employee has given a PAN. Without one, tax is deducted at 20% of the month's taxable salary when that is higher (the higher rate for a missing PAN, formerly s.206AA of the 1961 Act). */
    hasPan?: boolean;
  };
}

export interface EarningLine {
  code: string;
  name: string;
  kind: ComponentKind;
  amount: string;
}

export interface PayslipResult {
  daysInMonth: number;
  paidDays: string;
  earnings: EarningLine[];
  gross: string;
  /** Wages under the Code on Social Security s.2(88), after the 50% rule. */
  wages: string;
  wagesAddedBack: string;
  pf: { wages: string; employee: string; eps: string; epfEmployer: string; edli: string; admin: string };
  esi: { covered: boolean; wages: string; employee: string; employer: string };
  pt: { amount: string; note: string };
  tds: { amount: string; projectedIncome: string; taxableIncome: string; annualTax: string; note: string };
  deductions: string;
  net: string;
  employerCost: string;
}

// ---------------------------------------------------------------- calculation

/** Wages under s.2(88): wage components plus the part of excluded items above half of total remuneration. */
export function codeWages(lines: { kind: ComponentKind; amount: Dec }[]): { wages: Dec; addedBack: Dec } {
  const total = lines.reduce((s, l) => s.plus(l.amount), new D(0));
  const excluded = lines.filter((l) => l.kind === 'EXCLUDED').reduce((s, l) => s.plus(l.amount), new D(0));
  const base = total.minus(excluded);
  const limit = total.div(2);
  const addedBack = excluded.gt(limit) ? excluded.minus(limit) : new D(0);
  return { wages: paise(base.plus(addedBack)), addedBack: paise(addedBack) };
}

export interface PfContributions {
  wages: Dec;
  employee: Dec;
  eps: Dec;
  epfEmployer: Dec;
  edli: Dec;
  admin: Dec;
}

export function pfContributions(period: string, wages: Dec, opts: { member: boolean; eps: boolean; onFullWages: boolean }): PfContributions {
  const zero = { wages: new D(0), employee: new D(0), eps: new D(0), epfEmployer: new D(0), edli: new D(0), admin: new D(0) };
  if (!opts.member || wages.lte(0)) return zero;
  const n = daysInMonth(period);
  // Capped wages: each part of the month is capped at its own ceiling, pro rata by days.
  const capped = pfCeilingSegments(period).reduce((s, seg) => {
    const part = wages.times(seg.days).div(n);
    const cap = seg.ceiling.times(seg.days).div(n);
    return s.plus(D.min(part, cap));
  }, new D(0));
  const pfWages = rupee(opts.onFullWages ? wages : capped);
  const cappedWages = rupee(capped);
  const employee = rupee(pct(pfWages, PF_RATES.employee));
  const employerTotal = rupee(pct(pfWages, PF_RATES.employer));
  const eps = opts.eps ? rupee(pct(cappedWages, PF_RATES.eps)) : new D(0);
  return {
    wages: pfWages,
    employee,
    eps,
    epfEmployer: employerTotal.minus(eps),
    edli: rupee(pct(cappedWages, PF_RATES.edli)),
    admin: rupee(pct(pfWages, PF_RATES.admin)),
  };
}

export function esiCovers(fullMonthWages: Dec): boolean {
  return fullMonthWages.lte(ESI_RULES.ceiling);
}

export function esiContributions(wages: Dec, covered: boolean): { employee: Dec; employer: Dec } {
  if (!covered || wages.lte(0)) return { employee: new D(0), employer: new D(0) };
  // ESI contributions are rounded up to the next rupee (ESI (Central) Rules rule 51).
  return { employee: rupeeUp(pct(wages, ESI_RULES.employee)), employer: rupeeUp(pct(wages, ESI_RULES.employer)) };
}

export function professionalTax(period: string, gross: Dec, stateCode: string | null, category: PtCategory): { amount: Dec; note: string } {
  if (!stateCode) return { amount: new D(0), note: 'No work state' };
  if (stateCode !== '27') return { amount: new D(0), note: `Professional tax for state ${stateCode} is not built yet` };
  if (category === 'EXEMPT') return { amount: new D(0), note: 'Exempt' };
  const slab = [...PT_MAHARASHTRA[category]].reverse().find((s) => s.above === null || gross.gt(s.above));
  if (!slab) return { amount: new D(0), note: category === 'WOMAN' ? 'Below the Maharashtra limit for women (Rs 25,000)' : 'Below the Maharashtra limit (Rs 7,500)' };
  const feb = period.slice(5, 7) === '02' && slab.february;
  return { amount: dec(feb ? slab.february! : slab.monthly), note: feb ? 'Maharashtra, February' : 'Maharashtra' };
}

/** Tax on total income under the new regime, after rebate, surcharge (with marginal relief) and cess, rounded to the nearest Rs 10. */
export function newRegimeTax(totalIncome: Dec, rules = NEW_REGIME_2026_27): Dec {
  const income = totalIncome.lt(0) ? new D(0) : totalIncome;
  const slabTax = (x: Dec) => {
    let tax = new D(0);
    let lower = new D(0);
    for (const s of rules.slabs) {
      const upper = s.upTo === null ? null : dec(s.upTo);
      if (x.lte(lower)) break;
      const top = upper === null ? x : D.min(x, upper);
      tax = tax.plus(pct(top.minus(lower), s.rate));
      if (upper === null) break;
      lower = upper;
    }
    return tax;
  };
  let tax = slabTax(income);
  const limit = dec(rules.rebateIncomeLimit);
  if (income.lte(limit)) tax = D.max(new D(0), tax.minus(D.min(tax, dec(rules.rebateMax))));
  else tax = D.min(tax, income.minus(limit)); // marginal relief on the rebate
  // Surcharge with marginal relief: tax plus surcharge may not exceed the amount at the threshold plus the income above it.
  const bands = [...rules.surcharge].reverse();
  const band = bands.find((b) => income.gt(b.above));
  if (band) {
    const withSurcharge = tax.plus(pct(tax, band.rate));
    const threshold = dec(band.above);
    const below = bands.find((b) => threshold.gt(b.above));
    const atThreshold = slabTax(threshold);
    const atThresholdTotal = atThreshold.plus(below ? pct(atThreshold, below.rate) : new D(0));
    tax = D.min(withSurcharge, atThresholdTotal.plus(income.minus(threshold)));
  }
  const total = tax.plus(pct(tax, rules.cess));
  return total.div(10).toDecimalPlaces(0, D.ROUND_HALF_UP).times(10);
}

export function computePayslip(input: PayslipInput): PayslipResult {
  const n = daysInMonth(input.period);
  const paid = dec(input.paidDays);
  if (paid.lt(0) || paid.gt(n)) throw new RangeError(`Paid days must be between 0 and ${n}`);
  if (!paid.times(2).isInteger()) throw new RangeError('Paid days must be whole or half days');
  const factor = paid.div(n);
  const earnings: { code: string; name: string; kind: ComponentKind; amount: Dec }[] = [
    ...input.components.map((c) => ({ code: c.code, name: c.name, kind: c.kind, amount: paise(dec(c.monthly).times(factor)) })),
    ...(input.oneOffs ?? []).map((o, i) => ({ code: `ONEOFF${i + 1}`, name: o.name, kind: o.kind, amount: paise(dec(o.amount)) })),
  ].filter((e) => !e.amount.isZero());
  const gross = earnings.reduce((s, e) => s.plus(e.amount), new D(0));
  const { wages, addedBack } = codeWages(earnings);

  const pf = pfContributions(input.period, wages, input.pf);

  // ESI coverage is decided on full-month wages (before loss of pay), once per contribution period.
  const fullMonth = codeWages(input.components.map((c) => ({ kind: c.kind, amount: dec(c.monthly) }))).wages;
  const covered = input.esiCoveredForPeriod ?? esiCovers(fullMonth);
  const esi = esiContributions(wages, covered);

  const pt = professionalTax(input.period, gross, input.pt.stateCode, input.pt.category);

  // Income tax: project the year's salary, tax it, and spread what is still due over the months left.
  const fullMonthGross = input.components.reduce((s, c) => s.plus(c.monthly), new D(0));
  const projected = dec(input.tax.incomeBefore).plus(gross).plus(fullMonthGross.times(input.tax.futureMonths));
  const taxable = D.max(new D(0), projected.minus(NEW_REGIME_2026_27.standardDeduction));
  const annualTax = newRegimeTax(taxable);
  const due = D.max(new D(0), annualTax.minus(input.tax.tdsBefore));
  let tds = rupee(due.div(input.tax.futureMonths + 1));
  const noPan = input.tax.hasPan === false && annualTax.gt(0);
  if (noPan) {
    const monthTaxable = D.max(new D(0), gross.minus(dec(NEW_REGIME_2026_27.standardDeduction).div(12)));
    tds = D.max(tds, rupee(pct(monthTaxable, NO_PAN_SALARY_RATE)));
  }
  const tdsNote = noPan
    ? `No PAN: the higher of the projected tax spread over the year and ${NO_PAN_SALARY_RATE}% of the month's taxable salary`
    : annualTax.isZero()
    ? `No tax: projected taxable income ${taxable.toFixed(0)} is within the rebate`
    : `Projected tax ${annualTax.toFixed(0)} for ${NEW_REGIME_2026_27.taxYear}, less ${dec(input.tax.tdsBefore).toFixed(0)} already deducted, over ${input.tax.futureMonths + 1} month${input.tax.futureMonths ? 's' : ''}`;

  const deductions = pf.employee.plus(esi.employee).plus(pt.amount).plus(tds);
  const net = gross.minus(deductions);
  if (net.lt(0)) throw new RangeError('Deductions exceed the gross pay');
  const employerCost = gross.plus(pf.eps).plus(pf.epfEmployer).plus(pf.edli).plus(pf.admin).plus(esi.employer);
  const s = (v: Dec) => v.toFixed(2);
  return {
    daysInMonth: n,
    paidDays: paid.toFixed(),
    earnings: earnings.map((e) => ({ code: e.code, name: e.name, kind: e.kind, amount: s(e.amount) })),
    gross: s(gross),
    wages: s(wages),
    wagesAddedBack: s(addedBack),
    pf: { wages: s(pf.wages), employee: s(pf.employee), eps: s(pf.eps), epfEmployer: s(pf.epfEmployer), edli: s(pf.edli), admin: s(pf.admin) },
    esi: { covered, wages: s(covered ? wages : new D(0)), employee: s(esi.employee), employer: s(esi.employer) },
    pt: { amount: s(pt.amount), note: pt.note },
    tds: { amount: s(tds), projectedIncome: s(projected), taxableIncome: s(taxable), annualTax: s(annualTax), note: tdsNote },
    deductions: s(deductions),
    net: s(net),
    employerCost: s(employerCost),
  };
}

/** Due dates: PF and ESI by the 15th of the next month; TDS on salary by the 7th (30 April for March); Maharashtra PT by the end of the next month for monthly payers. */
export function payrollDueDates(period: string) {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const next = `${ny}-${String(nm).padStart(2, '0')}`;
  return {
    PF: `${next}-15`,
    ESI: `${next}-15`,
    TDS: m === 3 ? `${y}-04-30` : `${next}-07`,
    PT: periodEnd(next),
  };
}
