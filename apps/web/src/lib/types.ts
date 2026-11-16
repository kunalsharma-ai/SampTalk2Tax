export type Role = 'OWNER' | 'ADMIN' | 'ACCOUNTANT' | 'APPROVER' | 'VIEWER';
export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

export interface Org {
  id: string;
  name: string;
  legalName: string | null;
  countryCode: string;
  functionalCurrency: string;
  fiscalYearStartMonth: number;
  isDemo: boolean;
  role: Role;
}

export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  description: string | null;
  parentId: string | null;
  isPostable: boolean;
  isActive: boolean;
}

export interface Period {
  id: string;
  fiscalYear: number;
  periodNo: number;
  name: string;
  startDate: string;
  endDate: string;
  status: 'OPEN' | 'LOCKED' | 'CLOSED';
  lockedAt: string | null;
}

export interface JournalLine {
  lineNo: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  currency: string;
  exchangeRate: string;
  debit: string;
  credit: string;
  functionalDebit: string;
  functionalCredit: string;
  description: string | null;
}

export interface Journal {
  id: string;
  entryNumber: number | null;
  displayNumber: string | null;
  date: string;
  type: string;
  status: 'DRAFT' | 'POSTED';
  memo: string | null;
  reference: string | null;
  functionalCurrency: string;
  totalDebit: string;
  totalCredit: string;
  reversesEntryId: string | null;
  reversedBy: { id: string; entryNumber: number } | null;
  postedAt: string | null;
  createdAt: string;
  lines: JournalLine[];
}

export const PERMS: Record<Role, Set<string>> = {
  OWNER: new Set(['*']),
  ADMIN: new Set(['*']),
  ACCOUNTANT: new Set(['accounts.manage', 'periods.manage', 'journals.create', 'journals.post', 'journals.reverse', 'audit.read']),
  APPROVER: new Set(['journals.post', 'audit.read']),
  VIEWER: new Set([]),
};

/** UI hint only: hides actions the role cannot perform. The API enforces the real check. */
export function can(role: Role | undefined, permission: string): boolean {
  if (!role) return false;
  const p = PERMS[role];
  return p.has('*') || p.has(permission);
}
