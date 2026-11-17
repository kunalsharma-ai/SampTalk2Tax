import { D } from './money';

/**
 * Usage-based billing (AR-012). A contract can carry meters: charges worked out each period
 * from the usage recorded against them (API calls, GB stored, hours, seats…). Usage is billed in
 * arrears: on the invoice for the period, made once the period has ended, alongside the
 * contract's fixed lines.
 *
 * Pricing of the billable quantity (used minus the included allowance):
 * - PER_UNIT: one price for every unit.
 * - GRADUATED: each tier prices the units that fall within it (the first 1,000 at 2.00, the
 *   next 9,000 at 1.50, the rest at 1.00).
 * - VOLUME: every unit is priced at the tier the whole quantity falls in.
 * A minimum charge tops the period up to that amount when usage comes to less.
 */

export const USAGE_PRICING = ['PER_UNIT', 'GRADUATED', 'VOLUME'] as const;
export type UsagePricing = (typeof USAGE_PRICING)[number];
export const USAGE_PRICING_LABEL: Record<UsagePricing, string> = {
  PER_UNIT: 'Per unit',
  GRADUATED: 'Graduated tiers',
  VOLUME: 'Volume tiers',
};

export interface UsageTier {
  /** The last unit (of billable quantity) in this tier; null for the open-ended last tier. */
  upTo: string | null;
  unitPrice: string;
}

export interface MeterPricing {
  pricing: UsagePricing;
  tiers: UsageTier[];
  /** Units included in each period at no charge. */
  included: string;
  /** The least the meter bills for a period, or null. */
  minimum: string | null;
}

export const METER_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

const isNum = (s: string | null | undefined) => {
  if (s === null || s === undefined || s === '') return false;
  try {
    return new D(s).isFinite();
  } catch {
    return false;
  }
};

/** What is wrong with a meter's pricing, in words; empty when it can be billed. */
export function meterPricingIssues(m: MeterPricing): string[] {
  const out: string[] = [];
  if (!(USAGE_PRICING as readonly string[]).includes(m.pricing)) out.push('Choose how usage is priced');
  if (!isNum(m.included) || new D(m.included).lt(0)) out.push('The included quantity must be zero or more');
  if (m.minimum !== null && (!isNum(m.minimum) || new D(m.minimum).lt(0))) out.push('The minimum charge must be zero or more');
  if (!m.tiers.length) out.push('Give at least one price');
  if (m.pricing === 'PER_UNIT' && m.tiers.length > 1) out.push('Per-unit pricing has one price; use tiers for more');
  if (m.tiers.length > 20) out.push('Use at most 20 tiers');
  let prev = new D(0);
  m.tiers.forEach((t, i) => {
    const last = i === m.tiers.length - 1;
    if (!isNum(t.unitPrice) || new D(t.unitPrice).lt(0)) out.push(`Tier ${i + 1}: the unit price must be zero or more`);
    if (last) {
      if (t.upTo !== null) out.push('The last tier has no upper limit');
    } else if (!isNum(t.upTo) || new D(t.upTo!).lte(prev)) {
      out.push(`Tier ${i + 1}: the upper limit must be more than ${prev.toFixed()}`);
    } else {
      prev = new D(t.upTo!);
    }
  });
  return out;
}

export interface UsageLine {
  description: string;
  quantity: string;
  unitPrice: string;
}

export interface UsageCharge {
  used: string;
  included: string;
  billable: string;
  /** Before tax, unrounded sum of the lines (each line is rounded by the invoice). */
  amount: string;
  lines: UsageLine[];
}

const fmt = (s: string | InstanceType<typeof D>) => {
  const d = new D(s);
  const [i, f] = d.toFixed().split('.');
  return `${i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? `.${f}` : ''}`;
};

/**
 * The charge for `used` units of a meter in one period: the invoice lines (description, quantity,
 * unit price) and their total. `name` and `unit` describe the meter on the invoice; `period` names
 * the period ("1 Nov 2026 to 30 Nov 2026").
 */
export function usageCharge(m: MeterPricing, used: string, label: { name: string; unit: string; period: string }): UsageCharge {
  const issues = meterPricingIssues(m);
  if (issues.length) throw new Error(issues[0]);
  const u = new D(used);
  const inc = new D(m.included);
  const billable = D.max(u.minus(inc), 0);
  const head = `${label.name}, ${label.period}: ${fmt(u)} ${label.unit} used${inc.gt(0) ? `, ${fmt(inc)} included` : ''}`;
  const lines: UsageLine[] = [];
  if (m.pricing === 'PER_UNIT') {
    lines.push({ description: head, quantity: billable.toFixed(), unitPrice: new D(m.tiers[0]!.unitPrice).toFixed() });
  } else if (m.pricing === 'VOLUME') {
    let tier = m.tiers[m.tiers.length - 1]!;
    for (const t of m.tiers) if (t.upTo === null || billable.lte(t.upTo)) { tier = t; break; }
    const i = m.tiers.indexOf(tier);
    lines.push({ description: `${head} (tier ${i + 1})`, quantity: billable.toFixed(), unitPrice: new D(tier.unitPrice).toFixed() });
  } else {
    let from = new D(0);
    m.tiers.forEach((t, i) => {
      if (billable.lte(from)) return;
      const to = t.upTo === null ? billable : D.min(billable, t.upTo);
      const q = to.minus(from);
      if (q.gt(0)) {
        const range = t.upTo === null ? (i === 0 ? 'every' : `above ${fmt(from)}`) : i === 0 ? `first ${fmt(t.upTo)}` : `over ${fmt(from)} to ${fmt(t.upTo)}`;
        lines.push({ description: `${i === 0 ? head : label.name}: ${range} ${label.unit}`, quantity: q.toFixed(), unitPrice: new D(t.unitPrice).toFixed() });
      }
      from = t.upTo === null ? billable : new D(t.upTo);
    });
    if (!lines.length) lines.push({ description: head, quantity: '0', unitPrice: new D(m.tiers[0]!.unitPrice).toFixed() });
  }
  let amount = lines.reduce((s, l) => s.plus(new D(l.quantity).times(l.unitPrice)), new D(0));
  if (m.minimum !== null && amount.lt(m.minimum)) {
    const top = new D(m.minimum).minus(amount);
    lines.push({ description: `${label.name}: minimum charge of ${fmt(m.minimum)} for the period`, quantity: '1', unitPrice: top.toFixed() });
    amount = new D(m.minimum);
  }
  return { used: u.toFixed(), included: inc.toFixed(), billable: billable.toFixed(), amount: amount.toFixed(), lines };
}

/** A one-line summary of the price ("2.00 per call after 1,000 included"). */
export function pricingSummary(m: MeterPricing, unit: string): string {
  const inc = new D(m.included).gt(0) ? ` after ${fmt(m.included)} included` : '';
  const min = m.minimum !== null && new D(m.minimum).gt(0) ? `, at least ${fmt(m.minimum)} a period` : '';
  if (m.pricing === 'PER_UNIT') return `${fmt(m.tiers[0]!.unitPrice)} per ${unit}${inc}${min}`;
  const tiers = m.tiers.map((t) => `${t.upTo === null ? 'then' : `to ${fmt(t.upTo)}`} ${fmt(t.unitPrice)}`).join(', ');
  return `${USAGE_PRICING_LABEL[m.pricing]} (${tiers}) per ${unit}${inc}${min}`;
}

export interface UsageRow {
  meter: string;
  date: string;
  quantity: string;
  reference: string | null;
}

/**
 * Usage pasted or uploaded as CSV: a header row naming `meter`, `date`, `quantity` and optionally
 * `reference` (any order, any case), then one row per reading. Returns the rows and the problems
 * by line number.
 */
export function parseUsageCsv(text: string): { rows: UsageRow[]; errors: string[] } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { rows: [], errors: ['The file is empty'] };
  const split = (l: string) => {
    const out: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i]!;
      if (ch === '"') {
        if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q;
      } else if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const head = split(lines[0]!).map((h) => h.toLowerCase());
  const col = (n: string) => head.indexOf(n);
  const [mi, di, qi, ri] = [col('meter'), col('date'), col('quantity'), col('reference')];
  if (mi < 0 || di < 0 || qi < 0) return { rows: [], errors: ['The first row must name the columns meter, date and quantity (and optionally reference)'] };
  const rows: UsageRow[] = [];
  const errors: string[] = [];
  lines.slice(1).forEach((l, i) => {
    const c = split(l);
    const n = i + 2;
    const meter = c[mi] ?? '';
    const date = c[di] ?? '';
    const quantity = (c[qi] ?? '').replace(/,/g, '');
    if (!METER_CODE_PATTERN.test(meter)) errors.push(`Line ${n}: "${meter}" is not a meter code`);
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) errors.push(`Line ${n}: the date must be YYYY-MM-DD`);
    else if (!isNum(quantity)) errors.push(`Line ${n}: "${c[qi] ?? ''}" is not a quantity`);
    else rows.push({ meter, date, quantity: new D(quantity).toFixed(), reference: ri >= 0 && c[ri] ? c[ri]!.slice(0, 100) : null });
  });
  if (rows.length > 5000) errors.push('Import at most 5,000 rows at a time');
  return { rows, errors };
}
