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
  departmentId: string | null;
  projectId: string | null;
}

export interface Journal {
  id: string;
  entryNumber: number | null;
  displayNumber: string | null;
  date: string;
  type: string;
  source: 'MANUAL' | 'DOCUMENT' | 'PAYMENT' | 'BANK' | 'EXPENSE' | 'TAX' | 'PAYROLL' | 'CLOSE' | 'ASSET' | 'DEFERRAL' | 'ACCRUAL' | 'LOAN';
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
  ACCOUNTANT: new Set(['accounts.manage', 'periods.manage', 'journals.create', 'journals.post', 'journals.reverse', 'audit.read', 'contacts.manage', 'sales.manage', 'purchases.manage', 'banking.manage', 'banking.reconcile', 'expenses.submit', 'expenses.reimburse', 'payroll.read', 'payroll.manage', 'budgets.manage', 'alerts.manage', 'collections.manage', 'close.manage', 'assets.manage', 'deferrals.manage', 'loans.manage']),
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
  /** India GST registration number; null = unregistered. */
  gstin: string | null;
  /** India GST state code (from the GSTIN when registered). */
  stateCode: string | null;
  /** India PAN (from the GSTIN when registered); decides TDS/TCS rates. */
  pan: string | null;
  /** Default TDS (vendor) or TCS (customer) section. */
  withholdingSectionId: string | null;
  address: string | null;
  city: string | null;
  /** India PIN code (six digits). */
  pincode: string | null;
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
  kind: 'SIMPLE' | 'GST';
  gstCategory: GstCategory | null;
  salesAccountId: string | null;
  purchaseAccountId: string | null;
  isActive: boolean;
}

export type GstCategory = 'TAXABLE' | 'NIL_RATED' | 'EXEMPT' | 'NON_GST';

export interface GstState {
  code: string;
  name: string;
  levies: 'SGST' | 'UTGST' | null;
}

export interface GstAccountRef {
  id: string;
  code: string;
  name: string;
}

export type GstRegistration =
  | { registered: false }
  | {
      registered: true;
      gstin: string;
      legalName: string | null;
      stateCode: string;
      stateName: string;
      effectiveFrom: string;
      firstDocumentDate: string | null;
      accounts: Record<'outputCgst' | 'outputSgst' | 'outputIgst' | 'inputCgst' | 'inputSgst' | 'inputIgst', GstAccountRef>;
    };

export interface TaxHeads {
  taxable: string;
  igst: string;
  cgst: string;
  sgst: string;
}
export interface Heads {
  igst: string;
  cgst: string;
  sgst: string;
}

export interface Gstr1DocumentRow {
  id: string;
  number: string;
  date: string;
  name: string;
  gstin: string | null;
  placeOfSupply: string;
  value: string;
  rates: (TaxHeads & { rate: string })[];
}
export interface HsnRow extends TaxHeads {
  hsnCode: string;
  rate: string;
  quantity: string;
}

export interface Gstr1 {
  gstin: string;
  from: string;
  to: string;
  b2b: Gstr1DocumentRow[];
  b2cl: Gstr1DocumentRow[];
  exp: Gstr1DocumentRow[];
  b2cs: (TaxHeads & { placeOfSupply: string; nature: 'INTRA' | 'INTER'; rate: string })[];
  cdnr: Gstr1DocumentRow[];
  cdnur: Gstr1DocumentRow[];
  nil: { nature: 'INTRA' | 'INTER'; registered: boolean; nilRated: string; exempt: string; nonGst: string }[];
  hsn: { b2b: HsnRow[]; b2c: HsnRow[] };
  documents: { kind: 'INVOICE' | 'CREDIT_NOTE'; from: string; to: string; issued: number; cancelled: number }[];
  totals: TaxHeads;
}

export interface Gstr3b {
  gstin: string;
  from: string;
  to: string;
  outwardTaxable: TaxHeads;
  outwardZeroRated: { taxable: string; igst: string };
  outwardNilExempt: string;
  outwardNonGst: string;
  interStateUnregistered: { placeOfSupply: string; taxable: string; igst: string }[];
  inwardReverseCharge: TaxHeads;
  itcImportServices: Heads;
  itcReverseCharge: Heads;
  itc: Heads;
  itcTotal: Heads;
  reverseChargeCash: Heads;
  inwardExempt: { inter: string; intra: string };
  inwardNonGst: { inter: string; intra: string };
  setOff: { liability: Heads; credit: Heads; used: { igst: Heads; cgst: Heads; sgst: Heads }; cash: Heads; carryForward: Heads };
  warnings: string[];
  ledger: { output: Heads; input: Heads; agrees: boolean };
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
  taxKind: 'SIMPLE' | 'GST' | null;
  gstCategory: GstCategory | null;
  hsnCode: string | null;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  taxRate: string;
  netAmount: string;
  taxAmount: string;
  departmentId: string | null;
  projectId: string | null;
}

export interface FinancialDocument extends DocumentSummary {
  memo: string | null;
  reverseCharge: boolean;
  reverseChargeTax: string;
  withholding: {
    kind: WithholdingKind;
    section: { id: string; code: string; name: string };
    subject: string;
    base: string;
    rate: string;
    amount: string;
    pan: string | null;
    deposit: { id: string; number: string; date: string; challanReference: string } | null;
  } | null;
  gst: {
    placeOfSupply: string;
    supplierState: string;
    supplyNature: 'INTRA' | 'INTER';
    counterpartyGstin: string | null;
    cgst: string;
    sgst: string;
    igst: string;
  } | null;
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
  source: 'MANUAL' | 'DOCUMENT' | 'PAYMENT' | 'BANK' | 'EXPENSE' | 'TAX' | 'PAYROLL' | 'CLOSE' | 'ASSET' | 'DEFERRAL' | 'ACCRUAL' | 'LOAN';
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

export type InvitationStatus = 'PENDING' | 'EXPIRED' | 'ACCEPTED' | 'REVOKED';
export interface Invitation {
  id: string;
  email: string;
  role: Role;
  status: InvitationStatus;
  invitedBy: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}
export interface Member {
  userId: string;
  email: string;
  name: string;
  role: Role;
  since: string;
}
export interface InvitationPreview {
  organization: { id: string; name: string; isDemo: boolean };
  email: string;
  role: Role;
  invitedBy: string | null;
  status: InvitationStatus;
  expiresAt: string;
  forYou: boolean;
  alreadyMember: boolean;
}

// ---------------------------------------------------------------- India TDS / TCS

export type WithholdingKind = 'TDS' | 'TCS';

export type WithholdingSettings =
  | { configured: false }
  | { configured: true; tan: string; accounts: { tdsPayable: { id: string; code: string; name: string }; tcsPayable: { id: string; code: string; name: string } } };

export interface WithholdingSection {
  id: string;
  kind: WithholdingKind;
  code: string;
  name: string;
  rate: string;
  rateIndividualHuf: string | null;
  rateNoPan: string;
  singleThreshold: string | null;
  aggregateThreshold: string | null;
  thresholdWindow: 'TAX_YEAR' | 'MONTH';
  thresholdBasis: 'WHOLE' | 'EXCESS';
  validFrom: string;
  source: string | null;
  isActive: boolean;
}

export interface WithholdingTemplate extends Omit<WithholdingSection, 'id' | 'isActive' | 'thresholdWindow' | 'thresholdBasis'> {
  window: 'TAX_YEAR' | 'MONTH';
  basis: 'WHOLE' | 'EXCESS';
}

export interface WithholdingPreview {
  kind: WithholdingKind;
  section: { id: string; code: string; name: string };
  pan: string | null;
  subject: string;
  base: string;
  rate: string;
  amount: string;
  reason: string;
}

export interface WithholdingRegisterRow {
  documentId: string;
  kind: DocumentKind;
  number: string;
  status: 'POSTED' | 'VOID';
  date: string;
  contact: { id: string; name: string };
  pan: string | null;
  section: { id: string; code: string; name: string };
  subject: string;
  base: string;
  rate: string;
  amount: string;
  dueDate: string;
  deposit: { id: string; number: string; date: string; challanReference: string } | null;
  overdue: boolean;
}

export interface WithholdingRegister {
  kind: WithholdingKind;
  tan: string;
  from: string;
  to: string;
  rows: WithholdingRegisterRow[];
  sections: { section: { id: string; code: string; name: string }; count: number; base: string; amount: string; deposited: string; pending: string }[];
  totals: { withheld: string; deposited: string; pending: string; overdue: string };
  ledger: { asOf: string; account: { id: string; code: string; name: string }; balance: string; expected: string; agrees: boolean };
}

export interface WithholdingDeposit {
  id: string;
  kind: WithholdingKind;
  number: string;
  status: 'POSTED' | 'VOID';
  depositDate: string;
  challanReference: string;
  bankAccount: { id: string; code: string; name: string };
  taxAmount: string;
  interestAmount: string;
  memo: string | null;
  journalEntryId: string;
  voidJournalEntryId: string | null;
  voidDate: string | null;
  voidReason: string | null;
  items: { documentId: string; number: string; date: string; contactName: string; amount: string }[];
}

// ---------------------------------------------------------------- payroll

export type PayComponentKind = 'WAGES' | 'EXCLUDED';
export type PtCategory = 'GENERAL' | 'WOMAN' | 'EXEMPT';
export type PayrollLiability = 'NET_PAY' | 'PF' | 'ESI' | 'PT' | 'TDS';
export interface AccountRef {
  id: string;
  code: string;
  name: string;
}

export type PayrollSettings =
  | { configured: false }
  | {
      configured: true;
      pfEstablishmentCode: string | null;
      esiEmployerCode: string | null;
      ptRegistration: string | null;
      accounts: Record<'salaryExpense' | 'employerContribution' | 'netPay' | 'pfPayable' | 'esiPayable' | 'ptPayable' | 'tdsPayable', AccountRef>;
    };

export interface SalaryComponent {
  code: string;
  name: string;
  kind: PayComponentKind;
  monthlyAmount: string;
}

export interface SalaryStructure {
  id: string;
  effectiveFrom: string;
  monthlyGross: string;
  components: SalaryComponent[];
}

export interface EmployeeSummary {
  id: string;
  code: string;
  name: string;
  pan: string | null;
  uan: string | null;
  esiNumber: string | null;
  dateOfJoining: string;
  dateOfLeaving: string | null;
}

export interface Employee extends EmployeeSummary {
  email: string | null;
  workStateCode: string | null;
  ptCategory: PtCategory;
  pfMember: boolean;
  epsMember: boolean;
  pfOnFullWages: boolean;
  priorTaxYear: string | null;
  priorIncome: string;
  priorTds: string;
  status: 'ACTIVE' | 'JOINING' | 'LEFT';
  currentSalary: SalaryStructure | null;
  salaries: SalaryStructure[];
}

export interface PayslipData {
  id: string;
  daysInMonth: number;
  daysOutside: string;
  lopDays: string;
  paidDays: string;
  oneOffs: { name: string; kind: PayComponentKind; amount: string }[];
  earnings: { code: string; name: string; kind: PayComponentKind; amount: string }[];
  gross: string;
  wages: string;
  wagesAddedBack: string;
  pf: { wages: string; employee: string; eps: string; epfEmployer: string; edli: string; admin: string };
  esi: { covered: boolean; wages: string; employee: string; employer: string };
  pt: { amount: string; note: string };
  tds: { amount: string; projectedIncome: string; taxableIncome: string; annualTax: string; note: string; incomeBefore: string; tdsBefore: string; futureMonths: number };
  deductions: string;
  net: string;
  employerCost: string;
}

export interface PayrollRemittance {
  id: string;
  number: string;
  liability: PayrollLiability;
  date: string;
  reference: string;
  amount: string;
  status: 'POSTED' | 'VOID';
  bankAccount: AccountRef;
  journalEntryId: string;
  voidReason: string | null;
}

export interface PayRunSummary {
  id: string;
  number: string;
  period: string;
  status: 'DRAFT' | 'POSTED' | 'VOID';
  payDate: string;
  employees: number;
  gross: string;
  deductions: string;
  net: string;
  employerCost: string;
  paid: PayrollLiability[];
}

export interface PayRun {
  id: string;
  number: string;
  period: string;
  status: 'DRAFT' | 'POSTED' | 'VOID';
  payDate: string;
  journalEntryId: string | null;
  voidJournalEntryId: string | null;
  voidDate: string | null;
  voidReason: string | null;
  totals: Record<'gross' | 'deductions' | 'net' | 'employerCost' | 'pfEmployee' | 'pfEmployer' | 'eps' | 'edli' | 'pfAdmin' | 'esiEmployee' | 'esiEmployer' | 'pt' | 'tds', string>;
  liabilities: { liability: PayrollLiability; label: string; amount: string; dueDate: string; payment: PayrollRemittance | null }[];
  payslips: (PayslipData & { employee: EmployeeSummary })[];
  missing: { employeeId: string; name: string; code: string; reason: string }[];
  remittances: PayrollRemittance[];
}

export interface Payslip extends PayslipData {
  organisation: { name: string; pfEstablishmentCode: string | null; esiEmployerCode: string | null };
  payRun: { id: string; number: string; period: string; status: PayRun['status']; payDate: string };
  employee: EmployeeSummary;
  yearToDate: { taxYear: string; postedOnly: boolean; gross: string; tds: string; pfEmployee: string; pt: string };
}

// ---------------------------------------------------------------- compliance calendar

export type ObligationStatus = 'DONE' | 'NOTHING_DUE' | 'OVERDUE' | 'DUE_SOON' | 'UPCOMING';
export interface ComplianceItem {
  key: string;
  kind: string;
  name: string;
  area: 'GST' | 'TDS_TCS' | 'PAYROLL' | 'INCOME_TAX';
  nature: 'RETURN' | 'PAYMENT';
  period: string;
  periodLabel: string;
  periodFrom: string;
  periodTo: string;
  dueDate: string;
  note?: string;
  status: ObligationStatus;
  daysLeft: number;
  amount: string | null;
  paid: string | null;
  outstanding: string | null;
  detail: string;
  evidence: { type: 'WITHHOLDING_DEPOSIT' | 'PAY_RUN' | 'PAYROLL_PAYMENT'; id: string; label: string }[];
  filing: { id: string; filedOn: string; reference: string; note: string | null; createdAt: string } | null;
  source: string;
}
export interface ComplianceCalendar {
  today: string;
  from: string;
  to: string;
  configured: boolean;
  areas: { gst: boolean; withholding: boolean; payroll: boolean; advanceTax: boolean };
  gstReturnFrequency: 'MONTHLY' | 'QUARTERLY' | null;
  summary: { overdue: number; dueSoon: number; upcoming: number; done: number; nothingDue: number };
  overdueBefore: ComplianceItem[];
  items: ComplianceItem[];
}
export interface ComplianceSettings {
  gstReturnFrequency: 'MONTHLY' | 'QUARTERLY';
  advanceTaxFrom: string | null;
  areas: { gst: { stateCode: string; from: string } | null; withholding: { from: string } | null; payroll: { from: string; ptStates: string[] } | null };
}

// ---------------------------------------------------------------- e-invoicing (India)

export type EInvoiceSettings =
  | { configured: false; gstRegistered: boolean }
  | { configured: true; gstRegistered: boolean; applicableFrom: string; aatoTenCroreOrMore: boolean; tradeName: string | null; address1: string; address2: string | null; city: string; pincode: string; goodsUnit: string; irpPublicKeySet: boolean };

export type EInvoiceState = 'NOT_REQUIRED' | 'UNSUPPORTED' | 'NEEDS_DATA' | 'READY' | 'TOO_LATE' | 'GENERATED' | 'CANCELLED';

export interface EInvoiceRecord {
  id: string;
  irn: string;
  ackNo: string;
  ackDate: string;
  status: 'ACTIVE' | 'CANCELLED';
  signedQrCode: string;
  signatureVerified: boolean;
  qr: { sellerGstin: string; buyerGstin: string; docNo: string; docType: string; docDate: string; total: string; itemCount: number | null; mainHsn: string | null } | null;
  cancellableUntil: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  cancelRemark: string | null;
  createdAt: string;
}

export interface EInvoiceRow {
  documentId: string;
  kind: 'INVOICE' | 'CREDIT_NOTE';
  number: string | null;
  issueDate: string;
  documentStatus: string;
  contact: { id: string; name: string };
  buyerGstin: string | null;
  total: string;
  deadline: string | null;
  state: EInvoiceState;
  reason: string;
  issues: { field: string; message: string }[];
  eInvoice: EInvoiceRecord | null;
}

export interface EInvoiceRegister {
  from: string;
  to: string;
  today: string;
  aatoTenCroreOrMore: boolean;
  summary: { ready: number; needsData: number; tooLate: number; generated: number; cancelled: number; notRequired: number };
  rows: EInvoiceRow[];
}

export type EInvoiceDocument = { configured: false; documentId: string } | (EInvoiceRow & { configured: true; history: EInvoiceRecord[] });

// ---------------------------------------------------------------- e-way bills (India)

export type EWayBillSettings =
  | { configured: false; gstRegistered: boolean; stateCode: string | null; suggested: { address1: string; address2: string | null; city: string; pincode: string; goodsUnit: string } | null }
  | { configured: true; gstRegistered: boolean; stateCode: string | null; threshold: string; intraStateThreshold: string | null; address1: string; address2: string | null; city: string; pincode: string; goodsUnit: string };

export type EWayBillState = 'NEEDED' | 'OPTIONAL' | 'NEEDS_DATA' | 'TOO_OLD' | 'GENERATED' | 'CANCELLED' | 'NOT_APPLICABLE' | 'UNSUPPORTED';
export type TransportMode = 'ROAD' | 'RAIL' | 'AIR' | 'SHIP';

export interface EWayBillRecord {
  id: string;
  number: string;
  generatedAt: string;
  validUntil: string | null;
  expectedValidUntil: string | null;
  expired: boolean;
  distanceKm: number;
  vehicleType: 'R' | 'O';
  transporterId: string | null;
  transporterName: string | null;
  partB: { mode: TransportMode; vehicleNo: string | null; transDocNo: string | null; transDocDate: string | null } | null;
  status: 'ACTIVE' | 'CANCELLED';
  cancellableUntil: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  cancelRemark: string | null;
  updates: { id: string; updatedAt: string; mode: TransportMode; vehicleNo: string | null; transDocNo: string | null; fromPlace: string; fromStateCode: string; reason: string; remark: string }[];
  createdAt: string;
}

export interface EWayBillRow {
  documentId: string;
  number: string | null;
  issueDate: string;
  documentStatus: string;
  contact: { id: string; name: string };
  buyerGstin: string | null;
  placeOfSupply: string | null;
  total: string;
  consignmentValue: string;
  required: boolean;
  generateBy: string;
  state: EWayBillState;
  reason: string;
  issues: { field: string; message: string }[];
  eWayBill: EWayBillRecord | null;
}

export interface EWayBillRegister {
  from: string;
  to: string;
  today: string;
  threshold: string;
  summary: { needed: number; needsData: number; tooOld: number; generated: number; expiringSoon: number; partAOnly: number; optional: number; notApplicable: number };
  rows: EWayBillRow[];
}

export type EWayBillDocument = { configured: false; documentId: string } | (EWayBillRow & { configured: true; history: EWayBillRecord[] });
