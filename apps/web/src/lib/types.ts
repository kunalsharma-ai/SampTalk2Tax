export type Role = 'OWNER' | 'ADMIN' | 'ACCOUNTANT' | 'APPROVER' | 'VIEWER' | 'EMPLOYEE';
export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

export interface Org {
  id: string;
  name: string;
  legalName: string | null;
  countryCode: string;
  functionalCurrency: string;
  fiscalYearStartMonth: number;
  isDemo: boolean;
  arAccountId: string | null;
  apAccountId: string | null;
  claimsAccountId: string | null;
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
  source: 'MANUAL' | 'DOCUMENT' | 'PAYMENT' | 'BANK' | 'EXPENSE';
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
  ACCOUNTANT: new Set(['accounts.manage', 'periods.manage', 'journals.create', 'journals.post', 'journals.reverse', 'audit.read', 'contacts.manage', 'sales.manage', 'purchases.manage', 'banking.manage', 'banking.reconcile', 'expenses.submit', 'expenses.reimburse']),
  APPROVER: new Set(['journals.post', 'audit.read', 'approvals.decide', 'expenses.submit']),
  VIEWER: new Set([]),
  EMPLOYEE: new Set(['expenses.submit']),
};

/** UI hint only: hides actions the role cannot perform. The API enforces the real check. */
export function can(role: Role | undefined, permission: string): boolean {
  if (!role) return false;
  const p = PERMS[role];
  return p.has('*') || p.has(permission);
}

export type DocumentKind = 'INVOICE' | 'CREDIT_NOTE' | 'BILL' | 'VENDOR_CREDIT';
export type PaymentKind = 'RECEIPT' | 'PAYMENT';

export interface Balance {
  outstanding: string;
  overdue: string;
  unapplied: string;
  balance: string;
}

export interface Contact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  taxId: string | null;
  address: string | null;
  isCustomer: boolean;
  isVendor: boolean;
  paymentTermsDays: number;
  creditLimit: string | null;
  isActive: boolean;
  receivable: Balance;
  payable: Balance;
}

export interface TaxRate {
  id: string;
  name: string;
  rate: string;
  salesAccountId: string | null;
  purchaseAccountId: string | null;
  isActive: boolean;
}

export interface DocumentSummary {
  id: string;
  kind: DocumentKind;
  status: 'DRAFT' | 'POSTED' | 'VOID';
  number: string | null;
  contact: { id: string; name: string };
  issueDate: string;
  dueDate: string;
  reference: string | null;
  currency: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  allocated: string;
  amountDue: string;
  paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID' | null;
  isOverdue: boolean;
}

export interface DocumentLine {
  lineNo: number;
  description: string | null;
  accountId: string;
  accountCode: string;
  accountName: string;
  quantity: string;
  unitPrice: string;
  taxRateId: string | null;
  taxName: string | null;
  taxRate: string;
  netAmount: string;
  taxAmount: string;
}

export interface FinancialDocument extends DocumentSummary {
  memo: string | null;
  journalEntryId: string | null;
  voidJournalEntryId: string | null;
  voidDate: string | null;
  voidReason: string | null;
  postedAt: string | null;
  lines: DocumentLine[];
  allocations: {
    id: string;
    amount: string;
    date: string;
    source?: { type: 'payment' | 'credit'; id: string; number: string; kind: string };
    target?: { id: string; number: string; kind: string };
  }[];
}

export interface Payment {
  id: string;
  kind: PaymentKind;
  status: 'POSTED' | 'VOID';
  number: string;
  contact: { id: string; name: string };
  date: string;
  bankAccount: { id: string; code: string; name: string };
  currency: string;
  amount: string;
  allocated: string;
  unallocated: string;
  reference: string | null;
  memo: string | null;
  journalEntryId: string;
  voidJournalEntryId: string | null;
  voidDate: string | null;
  allocations: { id: string; amount: string; date: string; target: { id: string; number: string; kind: string } }[];
}

export interface AgeingItem {
  id: string;
  type: 'charge' | 'credit' | 'payment';
  number: string;
  date: string;
  dueDate: string | null;
  daysOverdue: number | null;
  bucket: string | null;
  total: string;
  open: string;
}

export interface AgeingAmounts {
  current: string;
  days1to30: string;
  days31to60: string;
  days61to90: string;
  over90: string;
  unapplied: string;
  balance: string;
}

export interface Ageing {
  ledger: 'SALES' | 'PURCHASES';
  asOf: string;
  currency: string;
  rows: (AgeingAmounts & { contactId: string; contactName: string; items: AgeingItem[] })[];
  totals: AgeingAmounts;
  reconciliation: { controlAccountId: string | null; controlAccountBalance: string | null; subledgerBalance: string; difference: string | null };
}

export interface Statement {
  contact: { id: string; name: string };
  ledger: 'SALES' | 'PURCHASES';
  currency: string;
  from: string;
  to: string;
  openingBalance: string;
  closingBalance: string;
  lines: { date: string; kind: string; id: string; number: string; description: string; charge: string | null; credit: string | null; balance: string }[];
}

// ------------------------------------------------------------------ banking

export interface BankAccountSummary {
  id: string;
  code: string;
  name: string;
  subtype: 'BANK' | 'CASH';
  isActive: boolean;
  ledgerBalance: string;
  statementLines: number;
  unmatchedLines: number;
  lastStatementDate: string | null;
  lastReconciled: { date: string; statementBalance: string } | null;
}

export interface LedgerLink {
  journalLineId: string;
  entryId: string;
  entryNumber: string | null;
  date: string;
  memo: string | null;
  reference: string | null;
  source: 'MANUAL' | 'DOCUMENT' | 'PAYMENT' | 'BANK' | 'EXPENSE';
  amount: string;
  payment: { id: string; number: string; kind: 'RECEIPT' | 'PAYMENT'; contactName: string } | null;
}

export interface StatementLine {
  id: string;
  accountId: string;
  date: string;
  description: string;
  reference: string | null;
  amount: string;
  status: 'UNMATCHED' | 'MATCHED' | 'EXCLUDED';
  excludedReason: string | null;
  reconciled: boolean;
  matches: (LedgerLink & { id: string; origin: 'EXISTING' | 'CREATED_ENTRY' | 'CREATED_PAYMENT' })[];
  suggestion: (LedgerLink & { score: number; reasons: string[]; unique: boolean }) | null;
}

export interface LedgerCandidate {
  journalLineId: string;
  entryId: string;
  entryNumber: string | null;
  date: string;
  memo: string | null;
  reference: string | null;
  description: string | null;
  source: string;
  amount: string;
}

export interface ImportPreview {
  imported: boolean;
  lines: { row: number; date: string; description: string; reference: string | null; amount: string; duplicate: boolean }[];
  newCount: number;
  duplicateCount: number;
  moneyIn: string;
  moneyOut: string;
  reconciledUntil: string | null;
  blockedRows: number[];
}

export interface ReconciliationPreview {
  startDate: string;
  statementDate: string;
  openingBalance: string;
  statementBalance: string;
  computedStatementBalance: string;
  ledgerBalance: string;
  uncleared: string;
  difference: string;
  linesInRange: number;
  unmatchedLines: { id: string; date: string; description: string; amount: string }[];
  unclearedLines: LedgerCandidate[];
  firstReconciliation: boolean;
  issues: string[];
  canComplete: boolean;
}

export interface Reconciliation {
  id: string;
  accountId: string;
  startDate: string;
  statementDate: string;
  openingBalance: string;
  statementBalance: string;
  ledgerBalance: string;
  uncleared: string;
  status: 'COMPLETED' | 'UNDONE';
  completedAt: string;
  undoneAt: string | null;
  undoReason: string | null;
  lines: number;
}

export type AttachmentEntity = 'DOCUMENT' | 'PAYMENT' | 'JOURNAL_ENTRY' | 'BANK_STATEMENT_LINE' | 'EXPENSE_CLAIM';
export interface Attachment {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  uploadedBy: string | null;
  createdAt: string;
  removedAt: string | null;
  removedReason: string | null;
}

export type DocumentKindName = 'INVOICE' | 'CREDIT_NOTE' | 'BILL' | 'VENDOR_CREDIT';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export interface ApprovalPolicy {
  documentKind: DocumentKindName;
  configured: boolean;
  isActive: boolean;
  minAmount: string | null;
  requireDifferentApprover: boolean;
  updatedAt: string | null;
}
export interface ApprovalRequest {
  id: string;
  status: ApprovalStatus;
  documentId: string | null;
  documentKind: DocumentKindName;
  documentNumber: string | null;
  documentStatus: 'DRAFT' | 'POSTED' | 'VOID' | null;
  contactName: string;
  total: string;
  note: string | null;
  requestedBy: string | null;
  requestedById: string;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  canApprove: boolean;
  ownWork: boolean;
}
export interface ApprovalState {
  required: boolean;
  policy: { minAmount: string; requireDifferentApprover: boolean } | null;
  readyToPost: boolean;
  requests: ApprovalRequest[];
}
export interface ApproveResult {
  approval: ApprovalRequest;
  posted: boolean;
  postError: { error: string; message: string } | null;
}

export type ExpenseClaimStatus = 'DRAFT' | 'SUBMITTED' | 'REJECTED' | 'APPROVED' | 'REIMBURSED' | 'VOID';
export interface ExpenseOptions {
  currency: string;
  accounts: { id: string; code: string; name: string }[];
  taxRates: { id: string; name: string; rate: string }[];
}
export interface ExpenseClaimSummary {
  id: string;
  number: string;
  title: string;
  status: ExpenseClaimStatus;
  claimant: string | null;
  claimantId: string;
  total: string;
  lineCount: number;
  submittedAt: string | null;
  reimbursedOn: string | null;
  canApprove: boolean;
}
export interface ExpenseClaimLine {
  lineNo: number;
  date: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  merchant: string | null;
  description: string | null;
  amount: string;
  taxRateId: string | null;
  taxName: string | null;
  taxRate: string;
  netAmount: string;
  taxAmount: string;
  possibleDuplicateOf: string[];
}
export interface ExpenseClaim {
  id: string;
  number: string;
  title: string;
  status: ExpenseClaimStatus;
  currency: string;
  claimantId: string;
  claimant: string | null;
  netTotal: string;
  taxTotal: string;
  total: string;
  submittedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  journalEntryId: string | null;
  postingDate: string | null;
  reimbursementJournalEntryId: string | null;
  reimbursedOn: string | null;
  reimbursedBy: string | null;
  reimbursementReference: string | null;
  bankAccount: string | null;
  voidJournalEntryId: string | null;
  voidDate: string | null;
  voidReason: string | null;
  createdAt: string;
  receiptCount: number;
  lines: ExpenseClaimLine[];
  actions: { edit: boolean; submit: boolean; withdraw: boolean; delete: boolean; decide: boolean; reimburse: boolean; void: boolean; attach: boolean };
}

export interface AuthSessionInfo {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
}
