import { D } from '@talk2tax/accounting-engine';

/**
 * US sales tax (TAX-028): which states a business must collect in (nexus), and what it charged in
 * each. Rates are set by states, counties, cities and special districts, so Talk2Tax suggests none:
 * the business records each state it is registered in with the combined rate it charges (an
 * ordinary tax rate). Economic nexus thresholds (after South Dakota v. Wayfair, 2018) are kept per
 * state so sales into each state can be watched against them. Thresholds are from published state
 * guidance as known when checked and need review by a US sales tax adviser before relying on them.
 */

export const US_SALES_TAX_CHECKED_ON = '2026-11-24';

export interface UsStateRule {
  code: string;
  name: string;
  /** False for the states with no statewide sales tax (Alaska, Delaware, Montana, New Hampshire, Oregon). */
  salesTax: boolean;
  /** Economic nexus: sales in the measurement period above which a remote seller must register. */
  salesThreshold: string | null;
  /** Number of separate sales that also creates nexus, when the state still counts them. */
  transactions: number | null;
  /** Whether both tests must be met (AND) or either (OR). */
  combine: 'OR' | 'AND';
  note?: string;
}

const s = (code: string, name: string, salesThreshold: string | null, transactions: number | null = null, combine: 'OR' | 'AND' = 'OR', note?: string): UsStateRule => ({
  code,
  name,
  salesTax: salesThreshold !== null,
  salesThreshold,
  transactions,
  combine,
  ...(note ? { note } : {}),
});

export const US_STATES: readonly UsStateRule[] = [
  s('AL', 'Alabama', '250000'),
  s('AK', 'Alaska', null, null, 'OR', 'No statewide sales tax; many boroughs and cities levy local sales tax through the Alaska Remote Seller Sales Tax Commission.'),
  s('AZ', 'Arizona', '100000'),
  s('AR', 'Arkansas', '100000', 200),
  s('CA', 'California', '500000'),
  s('CO', 'Colorado', '100000'),
  s('CT', 'Connecticut', '100000', 200, 'AND'),
  s('DE', 'Delaware', null),
  s('DC', 'District of Columbia', '100000', 200),
  s('FL', 'Florida', '100000'),
  s('GA', 'Georgia', '100000', 200),
  s('HI', 'Hawaii', '100000', 200),
  s('ID', 'Idaho', '100000'),
  s('IL', 'Illinois', '100000'),
  s('IN', 'Indiana', '100000'),
  s('IA', 'Iowa', '100000'),
  s('KS', 'Kansas', '100000'),
  s('KY', 'Kentucky', '100000', 200),
  s('LA', 'Louisiana', '100000'),
  s('ME', 'Maine', '100000'),
  s('MD', 'Maryland', '100000', 200),
  s('MA', 'Massachusetts', '100000'),
  s('MI', 'Michigan', '100000', 200),
  s('MN', 'Minnesota', '100000', 200),
  s('MS', 'Mississippi', '250000'),
  s('MO', 'Missouri', '100000'),
  s('MT', 'Montana', null),
  s('NE', 'Nebraska', '100000', 200),
  s('NV', 'Nevada', '100000', 200),
  s('NH', 'New Hampshire', null),
  s('NJ', 'New Jersey', '100000', 200),
  s('NM', 'New Mexico', '100000'),
  s('NY', 'New York', '500000', 100, 'AND'),
  s('NC', 'North Carolina', '100000'),
  s('ND', 'North Dakota', '100000'),
  s('OH', 'Ohio', '100000', 200),
  s('OK', 'Oklahoma', '100000'),
  s('OR', 'Oregon', null),
  s('PA', 'Pennsylvania', '100000'),
  s('RI', 'Rhode Island', '100000', 200),
  s('SC', 'South Carolina', '100000'),
  s('SD', 'South Dakota', '100000'),
  s('TN', 'Tennessee', '100000'),
  s('TX', 'Texas', '500000'),
  s('UT', 'Utah', '100000'),
  s('VT', 'Vermont', '100000', 200),
  s('VA', 'Virginia', '100000', 200),
  s('WA', 'Washington', '100000'),
  s('WV', 'West Virginia', '100000', 200),
  s('WI', 'Wisconsin', '100000'),
  s('WY', 'Wyoming', '100000'),
];

export function usState(code: string): UsStateRule | null {
  return US_STATES.find((x) => x.code === code.toUpperCase()) ?? null;
}

/** Share of the threshold at which a state is flagged as approaching. */
export const NEXUS_WARNING_SHARE = '0.8';

export type NexusStatus = 'REGISTERED' | 'MUST_REGISTER' | 'APPROACHING' | 'BELOW' | 'NO_SALES_TAX';

export const NEXUS_STATUS_LABEL: Readonly<Record<NexusStatus, string>> = {
  REGISTERED: 'Registered',
  MUST_REGISTER: 'Over the threshold',
  APPROACHING: 'Approaching',
  BELOW: 'Below the threshold',
  NO_SALES_TAX: 'No state sales tax',
};

export interface StateSales {
  state: string;
  /** Sales into the state in the measurement year, net of credit notes, before tax. */
  sales: string;
  transactions: number;
}

/**
 * Economic nexus by state. Each state is measured on the busier of the current and the previous
 * calendar year (most states use one or the other); states the business is registered in are shown as such.
 */
export function nexusExposure(input: { currentYear: StateSales[]; previousYear: StateSales[]; registered: string[] }) {
  const reg = new Set(input.registered.map((x) => x.toUpperCase()));
  const states = new Set([...input.currentYear, ...input.previousYear].map((x) => x.state.toUpperCase()).concat([...reg]));
  const find = (list: StateSales[], st: string) => list.find((x) => x.state.toUpperCase() === st) ?? { state: st, sales: '0', transactions: 0 };
  const rows = [...states].flatMap((st) => {
    const rule = usState(st);
    if (!rule) return [];
    const cur = find(input.currentYear, st);
    const prev = find(input.previousYear, st);
    const measured = new D(cur.sales).gte(prev.sales) ? { ...cur, year: 'CURRENT' as const } : { ...prev, year: 'PREVIOUS' as const };
    const transactions = Math.max(cur.transactions, prev.transactions);
    let status: NexusStatus;
    let share: string | null = null;
    if (!rule.salesTax) status = 'NO_SALES_TAX';
    else {
      const sales = new D(measured.sales);
      const bySales = sales.gt(rule.salesThreshold!);
      const byCount = rule.transactions !== null && transactions >= rule.transactions;
      const over = rule.combine === 'AND' ? bySales && byCount : bySales || byCount;
      share = sales.div(rule.salesThreshold!).times(100).toDecimalPlaces(0).toFixed(0);
      const near = sales.gte(new D(rule.salesThreshold!).times(NEXUS_WARNING_SHARE)) || (rule.transactions !== null && transactions >= Math.ceil(rule.transactions * 0.8));
      status = reg.has(st) ? 'REGISTERED' : over ? 'MUST_REGISTER' : near ? 'APPROACHING' : 'BELOW';
    }
    return [
      {
        state: st,
        name: rule.name,
        status,
        salesThreshold: rule.salesThreshold,
        transactionsThreshold: rule.transactions,
        combine: rule.combine,
        currentYearSales: new D(cur.sales).toFixed(2),
        previousYearSales: new D(prev.sales).toFixed(2),
        transactions,
        measuredOn: measured.year,
        shareOfThreshold: share,
        note: rule.note ?? null,
      },
    ];
  });
  const order: Record<NexusStatus, number> = { MUST_REGISTER: 0, APPROACHING: 1, REGISTERED: 2, BELOW: 3, NO_SALES_TAX: 4 };
  return rows.sort(
    (a, b) => order[a.status] - order[b.status] || new D(b.currentYearSales).plus(b.previousYearSales).cmp(new D(a.currentYearSales).plus(a.previousYearSales)) || a.state.localeCompare(b.state),
  );
}

export interface UsSalesTaxDocument {
  id: string;
  kind: 'INVOICE' | 'CREDIT_NOTE';
  number: string | null;
  issueDate: string;
  contactId: string;
  contactName: string;
  /** The customer's state (ship-to), or null when not recorded. */
  state: string | null;
  net: string;
  tax: string;
  exempt?: boolean;
}

export type UsSalesTaxIssueKind = 'NO_TAX_IN_REGISTERED_STATE' | 'TAX_IN_UNREGISTERED_STATE' | 'STATE_MISSING' | 'RATE_DIFFERS';

export const US_SALES_TAX_ISSUE_LABEL: Readonly<Record<UsSalesTaxIssueKind, string>> = {
  NO_TAX_IN_REGISTERED_STATE: 'No tax on a sale into a registered state',
  TAX_IN_UNREGISTERED_STATE: 'Tax charged in a state you are not registered in',
  STATE_MISSING: 'Customer has no state',
  RATE_DIFFERS: "Rate differs from the state's recorded rate",
};

/** Sales tax charged by state for a filing period, with what looks wrong. Registrations carry the combined rate charged. */
export function salesTaxByState(input: { documents: UsSalesTaxDocument[]; registrations: { state: string; rate: string | null }[] }) {
  const reg = new Map(input.registrations.map((r) => [r.state.toUpperCase(), r]));
  const by = new Map<string, { gross: InstanceType<typeof D>; taxable: InstanceType<typeof D>; nonTaxable: InstanceType<typeof D>; tax: InstanceType<typeof D>; documents: number }>();
  const issues: {
    kind: UsSalesTaxIssueKind;
    label: string;
    documentId: string;
    number: string | null;
    issueDate: string;
    contactId: string;
    contactName: string;
    state: string | null;
    message: string;
  }[] = [];
  const issue = (kind: UsSalesTaxIssueKind, d: UsSalesTaxDocument, message: string) =>
    issues.push({
      kind,
      label: US_SALES_TAX_ISSUE_LABEL[kind],
      documentId: d.id,
      number: d.number,
      issueDate: d.issueDate,
      contactId: d.contactId,
      contactName: d.contactName,
      state: d.state,
      message,
    });
  for (const d of input.documents) {
    const sign = d.kind === 'CREDIT_NOTE' ? -1 : 1;
    const st = d.state?.toUpperCase() ?? null;
    const net = new D(d.net).times(sign);
    const tax = new D(d.tax).times(sign);
    const key = st && usState(st) ? st : 'UNKNOWN';
    const row = by.get(key) ?? { gross: new D(0), taxable: new D(0), nonTaxable: new D(0), tax: new D(0), documents: 0 };
    by.set(key, row);
    row.gross = row.gross.plus(net);
    if (tax.isZero()) row.nonTaxable = row.nonTaxable.plus(net);
    else row.taxable = row.taxable.plus(net);
    row.tax = row.tax.plus(tax);
    row.documents++;
    if (sign < 0) continue;
    if (key === 'UNKNOWN') {
      issue('STATE_MISSING', d, "The customer's state is not recorded, so the sale cannot be put in a state's return. Add it on the customer.");
      continue;
    }
    const r = reg.get(key);
    const taxed = !new D(d.tax).isZero();
    if (r && !taxed && !d.exempt)
      issue(
        'NO_TAX_IN_REGISTERED_STATE',
        d,
        `You are registered in ${usState(key)!.name} but no tax was charged. Unless the sale is exempt (a resale or exemption certificate, or an exempt product), tax is due.`,
      );
    if (!r && taxed)
      issue(
        'TAX_IN_UNREGISTERED_STATE',
        d,
        `Tax was charged on a sale into ${usState(key)!.name}, where you are not registered. A business should not collect a state's tax without a permit; register or refund it.`,
      );
    if (r?.rate && taxed && !new D(d.net).isZero()) {
      const charged = new D(d.tax).div(d.net).times(100);
      if (charged.minus(r.rate).abs().gt('0.01'))
        issue(
          'RATE_DIFFERS',
          d,
          `Tax was charged at ${charged.toDecimalPlaces(3).toFixed()}% but the rate recorded for ${usState(key)!.name} is ${new D(r.rate).toFixed()}%. Local rates differ inside a state; check the rate for the delivery address.`,
        );
    }
  }
  const money = (v: InstanceType<typeof D>) => v.toDecimalPlaces(2).toFixed(2);
  const states = [...by.entries()]
    .map(([state, r]) => ({
      state,
      name: state === 'UNKNOWN' ? 'State not recorded' : usState(state)!.name,
      registered: reg.has(state),
      gross: money(r.gross),
      taxable: money(r.taxable),
      nonTaxable: money(r.nonTaxable),
      tax: money(r.tax),
      documents: r.documents,
    }))
    .sort((a, b) => (a.state === 'UNKNOWN' ? 1 : b.state === 'UNKNOWN' ? -1 : a.state.localeCompare(b.state)));
  const total = states.reduce((t, x) => t.plus(x.tax), new D(0));
  return { states, totalTax: money(total), issues };
}
