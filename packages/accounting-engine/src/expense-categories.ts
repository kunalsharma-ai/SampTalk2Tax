import { type Dec, dec } from './money';

/**
 * Expense categories (EXP-005). Finance names the categories employees claim under, such as
 * "Travel" or "Client meals", each posting to one expense account, with guidance on what belongs
 * there, an optional default tax rate and whether a receipt is always required. Employees pick a
 * category on a claim line instead of an account from the chart.
 *
 * Limits per category stay in the expense policy (rules narrowed to the category's account); a
 * category lists the rules that apply to it.
 */
export const EXPENSE_CATEGORY_RECEIPT = ['POLICY', 'ALWAYS'] as const;
export type ExpenseCategoryReceipt = (typeof EXPENSE_CATEGORY_RECEIPT)[number];

export interface ExpenseCategoryInput {
  name: string;
  description: string | null;
  accountId: string;
  taxRateId: string | null;
  receipt: ExpenseCategoryReceipt;
}

/** The key two categories may not share while both are active: the name, case and spaces ignored. */
export const expenseCategoryKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** Problems with a category as finance sets it, or an empty list. `taken` holds the keys of the other active categories. */
export function expenseCategoryIssues(c: ExpenseCategoryInput, taken: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  const name = c.name.trim().replace(/\s+/g, ' ');
  if (!name) issues.push('Give the category a name');
  else if (name.length > 60) issues.push('Keep the name to 60 characters');
  else if (taken.has(expenseCategoryKey(name))) issues.push(`There is already an active category called ${name}`);
  if (c.description && c.description.trim().length > 500) issues.push('Keep the guidance to 500 characters');
  if (!c.accountId) issues.push('Choose the expense account the category posts to');
  if (!EXPENSE_CATEGORY_RECEIPT.includes(c.receipt)) issues.push('Choose whether a receipt is always required');
  return issues;
}

export interface CategoryClaimLine {
  lineNo: number;
  categoryId: string | null;
  accountId: string;
  /** Mileage and per diem lines have no receipt to attach. */
  isAllowance?: boolean;
}

export interface CategoryFact {
  id: string;
  name: string;
  accountId: string;
  receipt: ExpenseCategoryReceipt;
  isActive: boolean;
}

export interface CategoryViolation {
  ruleId: string;
  kind: 'CATEGORY_RECEIPT' | 'CATEGORY_ACCOUNT';
  severity: 'BLOCK';
  lineNo: number | null;
  message: string;
}

/**
 * What a claim's categories hold it to: receipt lines in a category that always needs a receipt
 * when the claim has none, and a line whose account is no longer the category's (the category
 * was moved to another account after the line was saved; saving the claim again fixes it).
 * Both block submission.
 */
export function checkClaimCategories(lines: readonly CategoryClaimLine[], categories: readonly CategoryFact[], receiptCount: number): CategoryViolation[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const out: CategoryViolation[] = [];
  const needReceipt = new Map<string, number[]>();
  for (const l of lines) {
    const c = l.categoryId ? byId.get(l.categoryId) : undefined;
    if (!c) continue;
    if (c.accountId !== l.accountId) out.push({ ruleId: `category:${c.id}`, kind: 'CATEGORY_ACCOUNT', severity: 'BLOCK', lineNo: l.lineNo, message: `Line ${l.lineNo}: ${c.name} now posts to another account; save the claim again` });
    if (c.receipt === 'ALWAYS' && !l.isAllowance && receiptCount === 0) needReceipt.set(c.id, [...(needReceipt.get(c.id) ?? []), l.lineNo]);
  }
  for (const [id, nos] of needReceipt) {
    const c = byId.get(id)!;
    out.push({ ruleId: `category:${id}`, kind: 'CATEGORY_RECEIPT', severity: 'BLOCK', lineNo: null, message: `Attach the receipts: ${c.name} always needs one (${nos.length === 1 ? 'line' : 'lines'} ${nos.join(', ')}) and the claim has none` });
  }
  return out;
}

export interface CategoryUsageLine {
  categoryId: string | null;
  amount: string;
}

/** Claimed per category (lines on submitted, approved and reimbursed claims), as decimal strings. */
export function categoryUsage(lines: readonly CategoryUsageLine[], scale: number): Map<string, { lines: number; total: string }> {
  const acc = new Map<string, { lines: number; total: Dec }>();
  for (const l of lines) {
    if (!l.categoryId) continue;
    const u = acc.get(l.categoryId) ?? { lines: 0, total: dec('0') };
    acc.set(l.categoryId, { lines: u.lines + 1, total: u.total.plus(l.amount) }); // not money: line count
  }
  return new Map([...acc].map(([k, v]) => [k, { lines: v.lines, total: v.total.toFixed(scale) }]));
}
