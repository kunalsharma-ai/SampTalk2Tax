import { D, type Dec } from './money';

/**
 * Financial visuals (DASH-028 waterfall, DASH-029 Sankey, DASH-030 heatmap, DASH-031 treemap,
 * DASH-034 drill-down): the profit and loss of a period drawn four ways, built only from posted
 * amounts per account and month. Every figure names the accounts behind it, so a chart can open
 * their ledger. No framework or database code.
 */

export interface VisualAccount {
  id: string;
  code: string;
  name: string;
  type: 'REVENUE' | 'EXPENSE';
  subtype: string | null;
}
/** The natural amount (revenue: credit less debit; expense: debit less credit) of one account in one month. */
export interface VisualAmount {
  accountId: string;
  month: string;
  amount: string;
}

export const EXPENSE_GROUPS = [
  { key: 'COST_OF_SALES', label: 'Cost of sales', subtypes: ['COST_OF_SALES'] },
  { key: 'PAYROLL', label: 'People', subtypes: ['PAYROLL_EXPENSE'] },
  { key: 'OPERATING', label: 'Operating costs', subtypes: ['OPERATING_EXPENSE', null] },
  { key: 'DEPRECIATION', label: 'Depreciation', subtypes: ['DEPRECIATION', 'AMORTISATION'] },
  { key: 'FINANCE', label: 'Interest and exchange', subtypes: ['INTEREST_EXPENSE', 'FX_GAIN_LOSS'] },
  { key: 'OTHER', label: 'Other expenses', subtypes: ['OTHER_EXPENSE'] },
  { key: 'TAX', label: 'Income tax', subtypes: ['TAX_EXPENSE'] },
] as const;
export type ExpenseGroupKey = (typeof EXPENSE_GROUPS)[number]['key'];

/** The expense group an account belongs to; subtypes not listed count as operating costs. */
export function expenseGroup(subtype: string | null): ExpenseGroupKey {
  for (const g of EXPENSE_GROUPS) if ((g.subtypes as readonly (string | null)[]).includes(subtype)) return g.key;
  return 'OPERATING';
}
const groupLabel = (k: ExpenseGroupKey) => EXPENSE_GROUPS.find((g) => g.key === k)!.label;

interface Totals {
  accounts: Map<string, VisualAccount>;
  byAccount: Map<string, Dec>;
}
function totals(accounts: readonly VisualAccount[], amounts: readonly VisualAmount[]): Totals {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const byAccount = new Map<string, Dec>();
  for (const r of amounts) if (byId.has(r.accountId)) byAccount.set(r.accountId, (byAccount.get(r.accountId) ?? new D(0)).plus(r.amount));
  return { accounts: byId, byAccount };
}
const sum = (xs: Iterable<Dec>) => [...xs].reduce((a, b) => a.plus(b), new D(0));
const money = (d: Dec) => d.toFixed(2);

// ------------------------------------------------------------------ waterfall

export interface WaterfallStep {
  key: string;
  label: string;
  kind: 'START' | 'UP' | 'DOWN' | 'SUBTOTAL';
  /** The step's own amount: positive for income, negative for a cost; a subtotal's running total. */
  amount: string;
  /** The running total before and after the step, for drawing the floating bar. */
  from: string;
  to: string;
  accountIds: string[];
}

/**
 * Revenue down to net profit: revenue, cost of sales, gross profit, people, operating costs,
 * depreciation, operating profit, other income, interest and exchange, other expenses, profit
 * before tax, income tax, net profit. Empty steps are left out; subtotals always show.
 */
export function plWaterfall(accounts: readonly VisualAccount[], amounts: readonly VisualAmount[]): WaterfallStep[] {
  const t = totals(accounts, amounts);
  const ids = (pred: (a: VisualAccount) => boolean) => [...t.byAccount.keys()].filter((id) => pred(t.accounts.get(id)!) && !t.byAccount.get(id)!.isZero());
  const total = (list: string[]) => sum(list.map((id) => t.byAccount.get(id)!));
  const operatingRevenue = ids((a) => a.type === 'REVENUE' && a.subtype !== 'OTHER_INCOME');
  const otherIncome = ids((a) => a.type === 'REVENUE' && a.subtype === 'OTHER_INCOME');
  const group = (k: ExpenseGroupKey) => ids((a) => a.type === 'EXPENSE' && expenseGroup(a.subtype) === k);
  const steps: WaterfallStep[] = [];
  let running = new D(0);
  const start = (key: string, label: string, list: string[]) => {
    running = total(list);
    steps.push({ key, label, kind: 'START', amount: money(running), from: '0.00', to: money(running), accountIds: list });
  };
  const move = (key: string, label: string, list: string[], sign: 1 | -1) => {
    if (!list.length) return;
    const amount = total(list).times(sign);
    if (amount.isZero()) return;
    const from = running;
    running = running.plus(amount);
    steps.push({ key, label, kind: amount.isNeg() ? 'DOWN' : 'UP', amount: money(amount), from: money(from), to: money(running), accountIds: list });
  };
  const subtotal = (key: string, label: string) => steps.push({ key, label, kind: 'SUBTOTAL', amount: money(running), from: '0.00', to: money(running), accountIds: [] });
  start('REVENUE', 'Revenue', operatingRevenue);
  move('COST_OF_SALES', 'Cost of sales', group('COST_OF_SALES'), -1);
  subtotal('GROSS_PROFIT', 'Gross profit');
  move('PAYROLL', 'People', group('PAYROLL'), -1);
  move('OPERATING', 'Operating costs', group('OPERATING'), -1);
  move('DEPRECIATION', 'Depreciation', group('DEPRECIATION'), -1);
  subtotal('OPERATING_PROFIT', 'Operating profit');
  move('OTHER_INCOME', 'Other income', otherIncome, 1);
  move('FINANCE', 'Interest and exchange', group('FINANCE'), -1);
  move('OTHER', 'Other expenses', group('OTHER'), -1);
  subtotal('PROFIT_BEFORE_TAX', 'Profit before tax');
  move('TAX', 'Income tax', group('TAX'), -1);
  subtotal('NET_PROFIT', 'Net profit');
  return steps;
}

// ------------------------------------------------------------------ Sankey

export interface SankeyNode {
  key: string;
  label: string;
  kind: 'REVENUE' | 'INCOME' | 'GROUP' | 'EXPENSE' | 'PROFIT' | 'LOSS';
  /** The account to open, for an account node. */
  accountId: string | null;
}
export interface SankeyLink {
  source: number;
  target: number;
  amount: string;
}
export interface IncomeSankey {
  nodes: SankeyNode[];
  links: SankeyLink[];
  income: string;
  profit: string;
  /** Accounts whose net amount ran against their nature (a revenue account in debit, say), left out of the flow. */
  leftOut: { accountId: string; amount: string }[];
}

/**
 * Where the money came from and where it went: each revenue account flows into the period's
 * income, which flows to each expense group (and on to its largest accounts) and to profit. A
 * loss flows in as a source, so what comes in always equals what goes out. Accounts beyond
 * `perGroup` in a group are joined as "Other …".
 */
export function incomeSankey(accounts: readonly VisualAccount[], amounts: readonly VisualAmount[], opts: { perGroup?: number; revenueAccounts?: number } = {}): IncomeSankey {
  const t = totals(accounts, amounts);
  const perGroup = opts.perGroup ?? 5;
  const maxRevenue = opts.revenueAccounts ?? 6;
  const leftOut: IncomeSankey['leftOut'] = [];
  const positive = (type: 'REVENUE' | 'EXPENSE') => {
    const out: { a: VisualAccount; v: Dec }[] = [];
    for (const [id, v] of t.byAccount) {
      const a = t.accounts.get(id)!;
      if (a.type !== type || v.isZero()) continue;
      if (v.isNeg()) leftOut.push({ accountId: id, amount: money(v) });
      else out.push({ a, v });
    }
    return out.sort((x, y) => y.v.comparedTo(x.v) || x.a.code.localeCompare(y.a.code));
  };
  const revenue = positive('REVENUE');
  const expense = positive('EXPENSE');
  const nodes: SankeyNode[] = [];
  const links: SankeyLink[] = [];
  const node = (n: SankeyNode) => nodes.push(n) - 1;
  const link = (source: number, target: number, v: Dec) => {
    if (v.greaterThan(0)) links.push({ source, target, amount: money(v) });
  };
  const income = sum(revenue.map((r) => r.v));
  const spent = sum(expense.map((e) => e.v));
  const profit = income.minus(spent);
  const hub = node({ key: 'INCOME', label: 'Income', kind: 'INCOME', accountId: null });
  revenue.slice(0, maxRevenue).forEach((r) => link(node({ key: `A:${r.a.id}`, label: r.a.name, kind: 'REVENUE', accountId: r.a.id }), hub, r.v));
  const restRevenue = sum(revenue.slice(maxRevenue).map((r) => r.v));
  if (restRevenue.greaterThan(0)) link(node({ key: 'REVENUE_OTHER', label: 'Other revenue', kind: 'REVENUE', accountId: null }), hub, restRevenue);
  if (profit.isNeg()) link(node({ key: 'LOSS', label: 'Loss for the period', kind: 'LOSS', accountId: null }), hub, profit.negated());
  for (const g of EXPENSE_GROUPS) {
    const members = expense.filter((e) => expenseGroup(e.a.subtype) === g.key);
    if (!members.length) continue;
    const gNode = node({ key: `G:${g.key}`, label: g.label, kind: 'GROUP', accountId: null });
    link(hub, gNode, sum(members.map((m) => m.v)));
    members.slice(0, perGroup).forEach((m) => link(gNode, node({ key: `A:${m.a.id}`, label: m.a.name, kind: 'EXPENSE', accountId: m.a.id }), m.v));
    const rest = sum(members.slice(perGroup).map((m) => m.v));
    if (rest.greaterThan(0)) link(gNode, node({ key: `G:${g.key}:OTHER`, label: `Other ${groupLabel(g.key).toLowerCase()}`, kind: 'EXPENSE', accountId: null }), rest);
  }
  if (profit.greaterThan(0)) link(hub, node({ key: 'PROFIT', label: 'Profit', kind: 'PROFIT', accountId: null }), profit);
  return { nodes, links, income: money(income), profit: money(profit), leftOut };
}

// ------------------------------------------------------------------ heatmap

export interface HeatmapRow {
  accountId: string;
  code: string;
  name: string;
  total: string;
  cells: { month: string; amount: string; /** 0 to 1 against the largest cell. */ intensity: number }[];
}

/**
 * Spending by account and month: the `top` expense accounts by total over the months, each month's
 * amount and how strong it is against the largest cell in the grid (refunds count as nothing).
 */
export function expenseHeatmap(accounts: readonly VisualAccount[], amounts: readonly VisualAmount[], months: readonly string[], top = 12): { months: string[]; rows: HeatmapRow[]; max: string } {
  const t = totals(accounts, amounts);
  const cell = new Map<string, Dec>();
  for (const r of amounts) if (t.accounts.get(r.accountId)?.type === 'EXPENSE') cell.set(`${r.accountId}|${r.month}`, (cell.get(`${r.accountId}|${r.month}`) ?? new D(0)).plus(r.amount));
  const ranked = [...t.byAccount.entries()]
    .filter(([id, v]) => t.accounts.get(id)!.type === 'EXPENSE' && v.greaterThan(0))
    .sort((a, b) => b[1].comparedTo(a[1]) || t.accounts.get(a[0])!.code.localeCompare(t.accounts.get(b[0])!.code))
    .slice(0, top);
  let max = new D(0);
  for (const [id] of ranked) for (const m of months) max = D.max(max, cell.get(`${id}|${m}`) ?? 0);
  const rows = ranked.map(([id, v]) => {
    const a = t.accounts.get(id)!;
    return {
      accountId: id,
      code: a.code,
      name: a.name,
      total: money(v),
      cells: months.map((m) => {
        const amount = cell.get(`${id}|${m}`) ?? new D(0);
        const intensity = max.isZero() || !amount.greaterThan(0) ? 0 : amount.dividedBy(max).toDecimalPlaces(3).toNumber();
        return { month: m, amount: money(amount), intensity };
      }),
    };
  });
  return { months: [...months], rows, max: money(max) };
}

// ------------------------------------------------------------------ treemap

export interface TreemapGroup {
  key: ExpenseGroupKey;
  label: string;
  amount: string;
  /** Share of all spending, percent with one decimal. */
  share: number;
  accounts: { accountId: string; code: string; name: string; amount: string; share: number }[];
}

/** Spending in the period by group and account, largest first, with each one's share of the whole. */
export function expenseTreemap(accounts: readonly VisualAccount[], amounts: readonly VisualAmount[]): { total: string; groups: TreemapGroup[] } {
  const t = totals(accounts, amounts);
  const items = [...t.byAccount.entries()].filter(([id, v]) => t.accounts.get(id)!.type === 'EXPENSE' && v.greaterThan(0)).map(([id, v]) => ({ a: t.accounts.get(id)!, v }));
  const total = sum(items.map((i) => i.v));
  const share = (v: Dec) => (total.isZero() ? 0 : v.dividedBy(total).times(100).toDecimalPlaces(1).toNumber());
  const groups = EXPENSE_GROUPS.map((g) => {
    const members = items.filter((i) => expenseGroup(i.a.subtype) === g.key).sort((x, y) => y.v.comparedTo(x.v) || x.a.code.localeCompare(y.a.code));
    const amount = sum(members.map((m) => m.v));
    return { key: g.key, label: g.label, amount: money(amount), share: share(amount), accounts: members.map((m) => ({ accountId: m.a.id, code: m.a.code, name: m.a.name, amount: money(m.v), share: share(m.v) })) };
  })
    .filter((g) => g.accounts.length)
    .sort((a, b) => new D(b.amount).comparedTo(a.amount));
  return { total: money(total), groups };
}
