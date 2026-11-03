import { AccountType, isBalanceSheetType } from './accounts';
import { D, Dec, dec, minorUnits, sum } from './money';

/**
 * Group consolidation: combines the trial balances of several organisations (entities) into one
 * set of statements in the group's presentation currency, with intercompany balances removed.
 *
 * Method (full consolidation):
 *  1. Each entity supplies its balances at the period end (balance sheet accounts) and its
 *     movements over the period (revenue and expense accounts), as signed net debits.
 *  2. Entities in another currency are translated (IAS 21 style): assets and liabilities at the
 *     closing rate, revenue and expenses at the period's average rate, equity and earnings brought
 *     forward at a historical rate. The difference that leaves goes to a translation reserve.
 *  3. Elimination rules pair one entity's account with another's (intercompany receivable with
 *     payable, sales with purchases, investment with share capital). Both translated balances are
 *     removed; if they do not cancel, the difference stays in an "intercompany differences" line
 *     so the consolidated trial balance still balances and the mismatch is visible.
 *  4. Accounts are combined by code. Every column of the worksheet sums to zero.
 *  5. Non-controlling interests: an entity owned less than 100% is still fully consolidated; the
 *     outside shareholders' share of its translated net assets (and of its profit for the period)
 *     is shown separately within equity. This is a presentation split: the worksheet is unchanged.
 *     The share is taken of the entity's own reported net assets; goodwill, fair value adjustments
 *     and the investment elimination for partly owned entities are not computed.
 */

export interface ConsolidationAccountBalance {
  code: string;
  name: string;
  type: AccountType;
  /** Signed net debit (debit positive, credit negative), in the entity's currency. */
  netDebit: string;
}

export interface TranslationRates {
  /** Presentation currency per 1 unit of the entity's currency, at the period end. */
  closing: string;
  /** Average for the period. */
  average: string;
  /** For equity and earnings brought forward. */
  historical: string;
}

export interface ConsolidationEntity {
  id: string;
  name: string;
  currency: string;
  /** Balance sheet accounts at the period end, and revenue/expense accounts cumulative to it. */
  closing: ConsolidationAccountBalance[];
  /** Revenue and expense movements within the period. */
  period: ConsolidationAccountBalance[];
  /** Needed when the entity's currency differs from the presentation currency. */
  rates?: TranslationRates | null;
  /** The group's share of the entity, as a percentage (up to 4 decimals). Defaults to 100. */
  ownershipPercent?: string | null;
}

export interface EliminationRule {
  id: string;
  name: string;
  left: { entityId: string; code: string };
  right: { entityId: string; code: string };
}

export type WorksheetRowKind = 'ACCOUNT' | 'EARNINGS_BROUGHT_FORWARD' | 'TRANSLATION_RESERVE' | 'INTERCOMPANY_DIFFERENCE';

export interface WorksheetRow {
  kind: WorksheetRowKind;
  code: string;
  name: string;
  type: AccountType;
  /** Signed net debit per entity, translated, in entity order. */
  amounts: string[];
  /** Signed net debit removed by eliminations (and the differences they leave). */
  elimination: string;
  consolidated: string;
}

export interface EliminationResult {
  ruleId: string;
  name: string;
  left: { entityId: string; code: string; name: string | null; amount: string };
  right: { entityId: string; code: string; name: string | null; amount: string };
  /** left + right as signed net debits: zero when the two sides agree. */
  difference: string;
  matched: boolean;
  /** Set when a side's account is missing in its entity. */
  problem: string | null;
}

export interface ConsolidatedLine {
  code: string;
  name: string;
  kind: WorksheetRowKind;
  amount: string;
}

export interface ConsolidationResult {
  currency: string;
  entities: {
    id: string;
    name: string;
    currency: string;
    rates: TranslationRates | null;
    translationReserve: string;
    netIncome: string;
    ownershipPercent: string;
    /** Translated assets less liabilities, before eliminations. */
    netAssets: string;
    /** Outside shareholders' share of netAssets and of netIncome. */
    nonControllingNetAssets: string;
    nonControllingProfit: string;
  }[];
  rows: WorksheetRow[];
  eliminations: EliminationResult[];
  /** Per entity, plus eliminations and consolidated: every column sums to zero. */
  balanced: boolean;
  incomeStatement: {
    revenue: ConsolidatedLine[];
    expenses: ConsolidatedLine[];
    totalRevenue: string;
    totalExpenses: string;
    netIncome: string;
    /** Net income split between the parent's owners and non-controlling interests. */
    attributableToOwners: string;
    attributableToNonControlling: string;
  };
  balanceSheet: {
    assets: ConsolidatedLine[];
    liabilities: ConsolidatedLine[];
    equity: ConsolidatedLine[];
    /** Consolidated net income for the period, shown in equity. */
    periodEarnings: string;
    totalAssets: string;
    totalLiabilities: string;
    totalEquity: string;
    /** Part of totalEquity held by outside shareholders of partly owned entities. */
    nonControllingInterests: string;
    /** totalEquity less nonControllingInterests. */
    equityAttributableToOwners: string;
    balanced: boolean;
  };
}

export class ConsolidationError extends Error {
  constructor(
    message: string,
    public readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'ConsolidationError';
  }
}

const RATE = /^\d{1,12}(\.\d{1,10})?$/;

export function checkTranslationRates(r: TranslationRates): string[] {
  const issues: string[] = [];
  for (const k of ['closing', 'average', 'historical'] as const) {
    if (!RATE.test(r[k]) || dec(r[k]).lte(0)) issues.push(`The ${k} rate must be a number above zero`);
  }
  return issues;
}

const PERCENT = /^\d{1,3}(\.\d{1,4})?$/;

/** Problems with an ownership percentage: above zero, at most 100, up to 4 decimals. */
export function checkOwnershipPercent(p: string): string[] {
  if (!PERCENT.test(p) || dec(p).lte(0) || dec(p).gt(100)) return ['Ownership must be a percentage above 0 and at most 100, with up to 4 decimals'];
  return [];
}

const SYNTHETIC: Record<Exclude<WorksheetRowKind, 'ACCOUNT'>, { code: string; name: string }> = {
  EARNINGS_BROUGHT_FORWARD: { code: '', name: 'Earnings brought forward (not yet closed)' },
  TRANSLATION_RESERVE: { code: '', name: 'Foreign currency translation reserve' },
  INTERCOMPANY_DIFFERENCE: { code: '', name: 'Intercompany differences to resolve' },
};

export function consolidate(input: { currency: string; entities: ConsolidationEntity[]; rules: EliminationRule[] }): ConsolidationResult {
  const { currency, entities, rules } = input;
  const scale = minorUnits(currency);
  const round = (d: Dec) => d.toDecimalPlaces(scale, D.ROUND_HALF_UP);
  const fmt = (d: Dec) => d.toFixed(scale);
  if (!entities.length) throw new ConsolidationError('A group needs at least one organisation');
  const ids = new Set<string>();
  const issues: string[] = [];
  for (const e of entities) {
    if (ids.has(e.id)) issues.push(`${e.name} is in the group twice`);
    ids.add(e.id);
    if (e.currency !== currency) {
      if (!e.rates) issues.push(`${e.name} keeps its books in ${e.currency}: enter its ${e.currency} to ${currency} rates for the period`);
      else issues.push(...checkTranslationRates(e.rates).map((m) => `${e.name}: ${m}`));
    }
    if (e.ownershipPercent != null) issues.push(...checkOwnershipPercent(e.ownershipPercent).map((m) => `${e.name}: ${m}`));
  }
  if (issues.length) throw new ConsolidationError('The group cannot be consolidated yet', issues);

  const n = entities.length;
  // key → row; key is the account code, or the synthetic kind.
  const rows = new Map<string, { kind: WorksheetRowKind; code: string; name: string; type: AccountType; amounts: Dec[]; elimination: Dec }>();
  const row = (key: string, init: () => { kind: WorksheetRowKind; code: string; name: string; type: AccountType }) => {
    let r = rows.get(key);
    if (!r) {
      r = { ...init(), amounts: Array.from({ length: n }, () => new D(0)), elimination: new D(0) };
      rows.set(key, r);
    }
    return r;
  };
  const synthetic = (kind: Exclude<WorksheetRowKind, 'ACCOUNT'>) => row(`~${kind}`, () => ({ kind, ...SYNTHETIC[kind], type: 'EQUITY' }));

  const outEntities: ConsolidationResult['entities'] = [];
  entities.forEach((e, i) => {
    const same = e.currency === currency;
    const rate = (k: keyof TranslationRates) => (same ? new D(1) : dec(e.rates![k]));
    const pnlClosing = new Map<string, Dec>();
    let columnTotal = new D(0);
    let netIncome = new D(0);
    let netAssets = new D(0);
    for (const a of e.closing) {
      if (isBalanceSheetType(a.type)) {
        const amount = round(dec(a.netDebit).times(a.type === 'EQUITY' ? rate('historical') : rate('closing')));
        if (a.type !== 'EQUITY') netAssets = netAssets.plus(amount);
        const r = row(a.code, () => ({ kind: 'ACCOUNT', code: a.code, name: a.name, type: a.type }));
        r.amounts[i] = r.amounts[i]!.plus(amount);
        columnTotal = columnTotal.plus(amount);
      } else {
        pnlClosing.set(a.code, dec(a.netDebit));
      }
    }
    const periodByCode = new Map<string, Dec>();
    for (const a of e.period) {
      if (isBalanceSheetType(a.type)) continue;
      periodByCode.set(a.code, dec(a.netDebit));
      const amount = round(dec(a.netDebit).times(rate('average')));
      const r = row(a.code, () => ({ kind: 'ACCOUNT', code: a.code, name: a.name, type: a.type }));
      r.amounts[i] = r.amounts[i]!.plus(amount);
      columnTotal = columnTotal.plus(amount);
      netIncome = netIncome.minus(amount);
    }
    // Revenue and expenses before the period, not yet closed to retained earnings.
    const before = sum([...pnlClosing.entries()].map(([code, v]) => v.minus(periodByCode.get(code) ?? new D(0))));
    if (!before.isZero()) {
      const amount = round(before.times(rate('historical')));
      const r = synthetic('EARNINGS_BROUGHT_FORWARD');
      r.amounts[i] = r.amounts[i]!.plus(amount);
      columnTotal = columnTotal.plus(amount);
    }
    // In the entity's own currency the column sums to zero; after translation the rest is the reserve.
    const reserve = columnTotal.negated();
    if (!reserve.isZero()) {
      const r = synthetic('TRANSLATION_RESERVE');
      r.amounts[i] = r.amounts[i]!.plus(reserve);
    }
    const owned = dec(e.ownershipPercent ?? '100');
    const outside = new D(100).minus(owned).div(100);
    outEntities.push({
      id: e.id,
      name: e.name,
      currency: e.currency,
      rates: same ? null : e.rates!,
      translationReserve: fmt(reserve),
      netIncome: fmt(netIncome),
      ownershipPercent: owned.toFixed(),
      netAssets: fmt(netAssets),
      nonControllingNetAssets: fmt(round(netAssets.times(outside))),
      nonControllingProfit: fmt(round(netIncome.times(outside))),
    });
  });

  // Eliminations.
  const index = new Map(entities.map((e, i) => [e.id, i]));
  const eliminations: EliminationResult[] = [];
  for (const rule of rules) {
    const side = (s: { entityId: string; code: string }) => {
      const i = index.get(s.entityId);
      const r = rows.get(s.code);
      const has = i !== undefined && (entities[i]!.closing.some((a) => a.code === s.code) || entities[i]!.period.some((a) => a.code === s.code));
      return { i, r: has ? r : undefined, amount: has && r && i !== undefined ? r.amounts[i]! : new D(0) };
    };
    const l = side(rule.left);
    const r = side(rule.right);
    const problems: string[] = [];
    if (l.i === undefined) problems.push('the first organisation is no longer in the group');
    else if (!l.r) problems.push(`${entities[l.i]!.name} has no balance on account ${rule.left.code}`);
    if (r.i === undefined) problems.push('the second organisation is no longer in the group');
    else if (!r.r) problems.push(`${entities[r.i]!.name} has no balance on account ${rule.right.code}`);
    if (l.r) l.r.elimination = l.r.elimination.minus(l.amount);
    if (r.r) r.r.elimination = r.r.elimination.minus(r.amount);
    const difference = l.amount.plus(r.amount);
    if (!difference.isZero()) {
      const d = synthetic('INTERCOMPANY_DIFFERENCE');
      d.elimination = d.elimination.plus(difference);
    }
    eliminations.push({
      ruleId: rule.id,
      name: rule.name,
      left: { ...rule.left, name: l.r?.name ?? null, amount: fmt(l.amount) },
      right: { ...rule.right, name: r.r?.name ?? null, amount: fmt(r.amount) },
      difference: fmt(difference),
      matched: difference.isZero() && !problems.length,
      problem: problems.length ? problems.join('; ') : null,
    });
  }

  const ORDER: Record<WorksheetRowKind, number> = { ACCOUNT: 0, EARNINGS_BROUGHT_FORWARD: 1, TRANSLATION_RESERVE: 2, INTERCOMPANY_DIFFERENCE: 3 };
  const typeOrder: Record<AccountType, number> = { ASSET: 0, LIABILITY: 1, EQUITY: 2, REVENUE: 3, EXPENSE: 4 };
  const sorted = [...rows.values()].sort((a, b) =>
    a.kind === 'ACCOUNT' && b.kind === 'ACCOUNT' ? a.code.localeCompare(b.code) : ORDER[a.kind] - ORDER[b.kind] || typeOrder[a.type] - typeOrder[b.type],
  );
  const outRows: WorksheetRow[] = sorted.map((r) => {
    const total = sum(r.amounts).plus(r.elimination);
    return { kind: r.kind, code: r.code, name: r.name, type: r.type, amounts: r.amounts.map(fmt), elimination: fmt(r.elimination), consolidated: fmt(total) };
  });
  const columnsZero =
    entities.every((_, i) => sum(sorted.map((r) => r.amounts[i]!)).isZero()) && sum(sorted.map((r) => r.elimination)).isZero();

  // Statements from the consolidated column.
  const line = (r: WorksheetRow, sign: 1 | -1): ConsolidatedLine => ({ code: r.code, name: r.name, kind: r.kind, amount: fmt(dec(r.consolidated).times(sign)) });
  // Statements show the consolidated column only; fully eliminated lines stay on the worksheet.
  const shown = outRows.filter((r) => !dec(r.consolidated).isZero());
  const revenue = shown.filter((r) => r.type === 'REVENUE').map((r) => line(r, -1));
  const expenses = shown.filter((r) => r.type === 'EXPENSE').map((r) => line(r, 1));
  const totalRevenue = sum(revenue.map((l) => dec(l.amount)));
  const totalExpenses = sum(expenses.map((l) => dec(l.amount)));
  const netIncome = totalRevenue.minus(totalExpenses);
  const assets = shown.filter((r) => r.type === 'ASSET').map((r) => line(r, 1));
  const liabilities = shown.filter((r) => r.type === 'LIABILITY').map((r) => line(r, -1));
  const equity = shown.filter((r) => r.type === 'EQUITY').map((r) => line(r, -1));
  const totalAssets = sum(assets.map((l) => dec(l.amount)));
  const totalLiabilities = sum(liabilities.map((l) => dec(l.amount)));
  const totalEquity = sum(equity.map((l) => dec(l.amount))).plus(netIncome);
  const nci = sum(outEntities.map((e) => dec(e.nonControllingNetAssets)));
  const nciProfit = sum(outEntities.map((e) => dec(e.nonControllingProfit)));

  return {
    currency,
    entities: outEntities,
    rows: outRows,
    eliminations,
    balanced: columnsZero,
    incomeStatement: {
      revenue,
      expenses,
      totalRevenue: fmt(totalRevenue),
      totalExpenses: fmt(totalExpenses),
      netIncome: fmt(netIncome),
      attributableToOwners: fmt(netIncome.minus(nciProfit)),
      attributableToNonControlling: fmt(nciProfit),
    },
    balanceSheet: {
      assets,
      liabilities,
      equity,
      periodEarnings: fmt(netIncome),
      totalAssets: fmt(totalAssets),
      totalLiabilities: fmt(totalLiabilities),
      totalEquity: fmt(totalEquity),
      nonControllingInterests: fmt(nci),
      equityAttributableToOwners: fmt(totalEquity.minus(nci)),
      balanced: totalAssets.equals(totalLiabilities.plus(totalEquity)),
    },
  };
}
