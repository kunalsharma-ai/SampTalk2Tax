/**
 * Vendor spending (RPT-016): what the organisation bought, from whom and on what, in a period,
 * against the same length of time just before. Posted bills count before tax at their own
 * exchange rate, less posted vendor credits; each line is converted and rounded to the
 * functional currency on its own, so the totals add up line by line.
 */
import { addDays } from './documents';
import { D, Dec, dec, roundToCurrency, sum } from './money';

export interface SpendDocument {
  vendorId: string;
  vendorName: string;
  kind: 'BILL' | 'VENDOR_CREDIT';
  issueDate: string;
  exchangeRate: string;
  lines: { accountId: string; accountCode: string; accountName: string; netAmount: string }[];
}

export interface SpendRow {
  id: string;
  name: string;
  amount: Dec;
  /** Share of the period's total spend, 0 to 1 (null when there was no spend). */
  share: Dec | null;
}

export interface VendorSpendRow extends SpendRow {
  bills: number;
  previous: Dec;
  change: Dec;
}

export interface VendorSpend {
  total: Dec;
  previousTotal: Dec;
  change: Dec;
  vendors: VendorSpendRow[];
  accounts: (SpendRow & { code: string })[];
  months: { month: string; amount: Dec }[];
  /** Vendors that make up 80% of the spend, counted from the largest. */
  vendorsFor80Percent: number;
}

/** The same number of days just before `from` to `to`. */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  const end = addDays(from, -1);
  return { from: addDays(end, -days), to: end };
}

function lineAmount(d: SpendDocument, net: string, currency: string): Dec {
  const v = roundToCurrency(dec(net).times(dec(d.exchangeRate)), currency);
  return d.kind === 'VENDOR_CREDIT' ? v.negated() : v;
}

export function buildVendorSpend(current: readonly SpendDocument[], previous: readonly SpendDocument[], currency: string): VendorSpend {
  const vendors = new Map<string, { name: string; amount: Dec; bills: number; previous: Dec }>();
  const accounts = new Map<string, { code: string; name: string; amount: Dec }>();
  const months = new Map<string, Dec>();
  const vendor = (d: SpendDocument) => {
    let v = vendors.get(d.vendorId);
    if (!v) vendors.set(d.vendorId, (v = { name: d.vendorName, amount: new D(0), bills: 0, previous: new D(0) }));
    return v;
  };
  for (const d of current) {
    const v = vendor(d);
    if (d.kind === 'BILL') v.bills++;
    for (const l of d.lines) {
      const a = lineAmount(d, l.netAmount, currency);
      v.amount = v.amount.plus(a);
      const acc = accounts.get(l.accountId) ?? { code: l.accountCode, name: l.accountName, amount: new D(0) };
      acc.amount = acc.amount.plus(a);
      accounts.set(l.accountId, acc);
      const m = d.issueDate.slice(0, 7);
      months.set(m, (months.get(m) ?? new D(0)).plus(a));
    }
  }
  for (const d of previous) {
    const v = vendor(d);
    v.previous = v.previous.plus(sum(d.lines.map((l) => lineAmount(d, l.netAmount, currency))));
  }
  const total = sum([...vendors.values()].map((v) => v.amount));
  const previousTotal = sum([...vendors.values()].map((v) => v.previous));
  const share = (a: Dec) => (total.isZero() ? null : a.div(total).toDecimalPlaces(4));
  const vendorRows = [...vendors.entries()]
    .map(([id, v]) => ({ id, name: v.name, amount: v.amount, share: share(v.amount), bills: v.bills, previous: v.previous, change: v.amount.minus(v.previous) }))
    .sort((a, b) => b.amount.comparedTo(a.amount) || b.previous.comparedTo(a.previous) || a.name.localeCompare(b.name));
  let running = new D(0);
  let vendorsFor80Percent = 0;
  if (total.isPositive()) {
    for (const v of vendorRows) {
      if (running.gte(total.times('0.8'))) break;
      running = running.plus(v.amount);
      vendorsFor80Percent++;
    }
  }
  return {
    total,
    previousTotal,
    change: total.minus(previousTotal),
    vendors: vendorRows,
    accounts: [...accounts.entries()].map(([id, a]) => ({ id, code: a.code, name: a.name, amount: a.amount, share: share(a.amount) })).sort((a, b) => b.amount.comparedTo(a.amount) || a.code.localeCompare(b.code)),
    months: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, amount]) => ({ month, amount })),
    vendorsFor80Percent,
  };
}
