export const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export type NormalBalance = 'DEBIT' | 'CREDIT';

export function normalBalance(type: AccountType): NormalBalance {
  return type === 'ASSET' || type === 'EXPENSE' ? 'DEBIT' : 'CREDIT';
}

/** Accounts that appear on the balance sheet (vs. the income statement). */
export function isBalanceSheetType(type: AccountType): boolean {
  return type === 'ASSET' || type === 'LIABILITY' || type === 'EQUITY';
}

export const ACCOUNT_SUBTYPES: Readonly<Record<AccountType, readonly string[]>> = Object.freeze({
  ASSET: ['CASH', 'BANK', 'ACCOUNTS_RECEIVABLE', 'INVENTORY', 'PREPAID', 'OTHER_CURRENT_ASSET', 'FIXED_ASSET', 'ACCUMULATED_DEPRECIATION', 'OTHER_NON_CURRENT_ASSET', 'TAX_RECEIVABLE'],
  LIABILITY: ['ACCOUNTS_PAYABLE', 'EMPLOYEE_REIMBURSEMENTS', 'CREDIT_CARD', 'ACCRUED_LIABILITY', 'TAX_PAYABLE', 'PAYROLL_LIABILITY', 'OTHER_CURRENT_LIABILITY', 'LONG_TERM_DEBT', 'OTHER_NON_CURRENT_LIABILITY'],
  EQUITY: ['SHARE_CAPITAL', 'RETAINED_EARNINGS', 'OWNER_DRAWINGS', 'OTHER_EQUITY'],
  REVENUE: ['OPERATING_REVENUE', 'OTHER_INCOME'],
  EXPENSE: ['COST_OF_SALES', 'OPERATING_EXPENSE', 'PAYROLL_EXPENSE', 'DEPRECIATION', 'INTEREST_EXPENSE', 'TAX_EXPENSE', 'OTHER_EXPENSE', 'FX_GAIN_LOSS'],
});

export function isValidSubtype(type: AccountType, subtype: string): boolean {
  return ACCOUNT_SUBTYPES[type].includes(subtype);
}

export interface AccountNode {
  id: string;
  parentId: string | null;
  type: AccountType;
}

/**
 * Validate a proposed parent for an account: same type, exists, and no cycle.
 * Returns an error message or null.
 */
export function validateAccountParent(
  accountId: string | null,
  type: AccountType,
  parentId: string | null,
  accounts: ReadonlyMap<string, AccountNode>,
): string | null {
  if (!parentId) return null;
  const parent = accounts.get(parentId);
  if (!parent) return 'Parent account not found';
  if (parent.type !== type) return `Parent account type ${parent.type} does not match ${type}`;
  let cursor: AccountNode | undefined = parent;
  const seen = new Set<string>();
  while (cursor) {
    if (accountId && cursor.id === accountId) return 'Account hierarchy would contain a cycle';
    if (seen.has(cursor.id)) return 'Existing account hierarchy contains a cycle';
    seen.add(cursor.id);
    cursor = cursor.parentId ? accounts.get(cursor.parentId) : undefined;
  }
  return null;
}
