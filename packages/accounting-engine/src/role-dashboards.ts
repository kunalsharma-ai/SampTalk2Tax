import { D } from './money';

/**
 * Role dashboards (DASH-044, 045, 053, 063, 064, 066): the question each role brings to the
 * books, and the small pure helpers their dashboards share. Each role has its own layout; these
 * helpers only rank what needs attention, roll months into quarters and band a share so a board
 * can see concentration without names. Pure.
 */
export const DASHBOARD_ROLES = ['CEO', 'CFO', 'TREASURY', 'RISK', 'COMPLIANCE', 'BOARD', 'AR_MANAGER', 'AP_MANAGER', 'TAX_MANAGER', 'EXPENSE_MANAGER', 'ACCOUNTANT', 'CONTROLLER', 'INTERNAL_AUDITOR', 'PROCUREMENT'] as const;
export type DashboardRole = (typeof DASHBOARD_ROLES)[number];

export const ROLE_DASHBOARDS: Record<DashboardRole, { name: string; question: string }> = {
  CEO: { name: 'Chief executive', question: 'Are we growing, are we making money, and how long does the cash last?' },
  CFO: { name: 'Chief financial officer', question: 'How healthy are margins, liquidity and working capital, and what is owed both ways?' },
  TREASURY: { name: 'Treasury manager', question: 'Where is the cash, where is it going over the next 90 days, and what should be paid or chased?' },
  RISK: { name: 'Financial risk officer', question: 'Where is risk building up, and how dependent are we on a few customers, vendors or banks?' },
  COMPLIANCE: { name: 'Compliance officer', question: 'Which filings and payments are due, which are at risk of being late, and how much tax will go out?' },
  BOARD: { name: 'Investor or board viewer', question: 'How is the business performing quarter by quarter, and how strong is its position, without operational detail?' },
  AR_MANAGER: { name: 'Accounts receivable manager', question: 'How old is what customers owe, whom to chase first, and how much will come in over the next weeks?' },
  AP_MANAGER: { name: 'Accounts payable manager', question: 'How old is what we owe, what to pay first, which bills are held, and which payments look wrong?' },
  TAX_MANAGER: { name: 'Tax manager', question: 'What tax is due and when, do the GST accounts agree with the documents, and which returns may be late?' },
  ACCOUNTANT: { name: 'Accountant', question: 'What is waiting to be posted, approved or reconciled, and how far is this month\'s close?' },
  CONTROLLER: { name: 'Financial controller', question: 'Are the months closing on time, and are the controls, approvals and separation of duties holding?' },
  INTERNAL_AUDITOR: { name: 'Internal auditor', question: 'How far are the audits, which findings are open or late, what evidence is outstanding, and which controls failed?' },
  PROCUREMENT: { name: 'Procurement manager', question: 'Which orders are open or late, which contracts are breached or ending, and which vendors carry risk?' },
  EXPENSE_MANAGER: { name: 'Expense manager', question: 'Which claims wait for a decision, which look risky, which lack receipts, and how departments stand against their budgets?' },
};

export type AttentionLevel = 'HIGH' | 'MEDIUM' | 'LOW';
export interface AttentionItemInput {
  area: string;
  title: string;
  detail: string;
  level: AttentionLevel;
  href: string;
  /** Money at stake, when there is one; larger amounts come first within a level. */
  amount?: string | null;
}

const LEVEL_ORDER: Record<AttentionLevel, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 }; // not money

/** What needs attention first: high before medium before low, then the larger amount, then by title. */
export function rankAttentionItems(items: readonly AttentionItemInput[], max = 8): AttentionItemInput[] {
  const amt = (i: AttentionItemInput) => new D(i.amount ?? 0);
  return [...items]
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || amt(b).comparedTo(amt(a)) || a.title.localeCompare(b.title))
    .slice(0, max);
}

export interface QuarterFigure {
  /** Calendar quarter, for example 2026-Q3. */
  quarter: string;
  /** Sum of the months that have a value; null when none has. */
  value: string | null;
  /** Months with a value (a quarter with fewer than 3 is still in progress or started before the books). */
  months: number;
}

/** Monthly amounts rolled up into calendar quarters, oldest first. */
export function quarterlyTotals(series: readonly { month: string; value: string | null }[], scale = 2): QuarterFigure[] {
  const out = new Map<string, { total: InstanceType<typeof D>; months: number }>();
  for (const s of series) {
    const [y, m] = s.month.split('-').map(Number) as [number, number];
    const q = `${y}-Q${Math.floor((m - 1) / 3) + 1}`; // not money
    const row = out.get(q) ?? { total: new D(0), months: 0 };
    if (s.value !== null) {
      row.total = row.total.plus(s.value);
      row.months += 1; // not money
    }
    out.set(q, row);
  }
  return [...out]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([quarter, r]) => ({ quarter, value: r.months ? r.total.toFixed(scale) : null, months: r.months }));
}

/** Change from one quarter to the next as a percentage to 1 place; null without a base. */
export function quarterChange(previous: string | null, current: string | null): string | null {
  if (previous === null || current === null) return null;
  const p = new D(previous);
  if (p.isZero()) return null;
  return new D(current).minus(p).dividedBy(p.abs()).times(100).toDecimalPlaces(1, D.ROUND_HALF_EVEN).toFixed(1);
}

export type ConcentrationBand = 'NONE' | 'LOW' | 'MODERATE' | 'HIGH';

/** How concentrated revenue is, from the largest customer's share (percent): under 15 low, 15 to 25 moderate, 25 and more high. */
export function concentrationBand(largestShare: string | number | null): ConcentrationBand {
  if (largestShare === null) return 'NONE';
  const s = new D(largestShare);
  return s.greaterThanOrEqualTo(25) ? 'HIGH' : s.greaterThanOrEqualTo(15) ? 'MODERATE' : 'LOW';
}

/**
 * Cash headroom over a forecast: the lowest expected balance less the minimum the business keeps,
 * and the days until that lowest point. Negative headroom means the buffer will be broken.
 */
export function cashHeadroom(input: { asOf: string; lowest: { date: string; amount: string }; buffer: string; scale?: number }) {
  const scale = input.scale ?? 2;
  const headroom = new D(input.lowest.amount).minus(input.buffer);
  const days = Math.round((Date.parse(`${input.lowest.date}T00:00:00Z`) - Date.parse(`${input.asOf}T00:00:00Z`)) / 86_400_000); // not money
  return { headroom: headroom.toFixed(scale), breaks: headroom.isNegative(), lowestOn: input.lowest.date, daysToLowest: days };
}

export const AGING_BUCKETS = ['CURRENT', 'DAYS_1_30', 'DAYS_31_60', 'DAYS_61_90', 'OVER_90'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** Open amounts by how far past their due date they are on a day: not yet due, 1-30, 31-60, 61-90 and over 90 days. */
export function agingByDueDate(items: readonly { open: string; dueDate: string }[], asOf: string, scale = 2) {
  const acc = AGING_BUCKETS.map((bucket) => ({ bucket, amount: new D(0), count: 0 }));
  const at = Date.parse(`${asOf}T00:00:00Z`);
  for (const i of items) {
    const late = Math.round((at - Date.parse(`${i.dueDate}T00:00:00Z`)) / 86_400_000); // not money: days
    const k = late <= 0 ? 0 : late <= 30 ? 1 : late <= 60 ? 2 : late <= 90 ? 3 : 4; // not money
    const row = acc[k]!;
    row.amount = row.amount.plus(i.open);
    row.count += 1; // not money
  }
  const total = acc.reduce((t, r) => t.plus(r.amount), new D(0));
  return {
    total: total.toFixed(scale),
    overdue: total.minus(acc[0]!.amount).toFixed(scale),
    buckets: acc.map((r) => ({ bucket: r.bucket, amount: r.amount.toFixed(scale), count: r.count, share: total.isZero() ? null : r.amount.dividedBy(total).times(100).toDecimalPlaces(1, D.ROUND_HALF_EVEN).toFixed(1) })),
  };
}
