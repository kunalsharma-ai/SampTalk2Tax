import { AccountType, ACCOUNT_SUBTYPES } from './accounts';
import { D, Dec, dec, sum } from './money';
import type { AccountMovement } from './reports';

/**
 * Local financial statements: the balance sheet and profit and loss laid out as a country's law
 * or standard sets them, built from posted balances by each account's type and subtype.
 *
 * These are presentation layouts of the books, for review and as a starting point for the
 * accountant who prepares the statutory accounts. They are not filings: there are no notes,
 * no cash flow statement, no directors' report, no audit and no XBRL or iXBRL. Every account
 * lands on exactly one line, so the statements always agree with the trial balance; accounts
 * without a subtype go to the type's fallback line and are listed so they can be classified.
 */

export const STATUTORY_FORMAT_IDS = ['IN_SCHEDULE_III', 'GB_COMPANIES_ACT', 'IFRS_IAS1'] as const;
export type StatutoryFormatId = (typeof STATUTORY_FORMAT_IDS)[number];

/**
 * DEBIT lines show debit balances as positive (assets, expenses); CREDIT lines show credit
 * balances as positive (liabilities, equity, income). A credit balance on a DEBIT line (for
 * example accumulated depreciation) reduces it.
 */
type Side = 'DEBIT' | 'CREDIT';

export interface StatutoryRowSpec {
  key: string;
  label: string;
  kind: 'HEADING' | 'LINE' | 'TOTAL';
  /** Indent level for display: 0 main heading, 1 sub-heading or total, 2 line. */
  level: 0 | 1 | 2;
  side?: Side;
  /** Subtypes whose accounts sum into this line. */
  subtypes?: readonly string[];
  /** The profit or loss not yet closed to retained earnings lands here (one equity line). */
  takesUnclosedProfit?: boolean;
  /** A total: the sum of other rows with signs. */
  sum?: readonly (readonly [string, 1 | -1])[];
  note?: string;
}

export interface StatutoryFormat {
  id: StatutoryFormatId;
  name: string;
  /** Countries it is the default for (others use IFRS_IAS1). */
  countries: readonly string[];
  basis: string;
  balanceSheetTitle: string;
  profitAndLossTitle: string;
  balanceSheet: readonly StatutoryRowSpec[];
  profitAndLoss: readonly StatutoryRowSpec[];
  /** Balance-sheet rows whose totals must agree. */
  balanceCheck: readonly [string, string];
  /** The profit row; must equal the books' net profit. */
  profitRow: string;
  /** Where an account of each type goes when its subtype is missing or not mapped. */
  fallback: Readonly<Record<AccountType, string>>;
  sources: readonly { title: string; url: string }[];
  notIncluded: readonly string[];
}

const L = (key: string, label: string, side: Side, subtypes: readonly string[], extra: Partial<StatutoryRowSpec> = {}): StatutoryRowSpec => ({ key, label, kind: 'LINE', level: 2, side, subtypes, ...extra });
const H = (key: string, label: string, level: 0 | 1 = 1): StatutoryRowSpec => ({ key, label, kind: 'HEADING', level });
const T = (key: string, label: string, parts: readonly (readonly [string, 1 | -1])[], level: 0 | 1 = 1): StatutoryRowSpec => ({ key, label, kind: 'TOTAL', level, sum: parts });
const plus = (...keys: string[]) => keys.map((k) => [k, 1] as const);

export const STATUTORY_FORMATS: readonly StatutoryFormat[] = Object.freeze([
  {
    id: 'IN_SCHEDULE_III',
    name: 'India: Schedule III (Division I)',
    countries: ['IN'],
    basis: 'Companies Act, 2013, Schedule III, Division I (companies following Accounting Standards, not Ind AS). Vertical balance sheet and statement of profit and loss.',
    balanceSheetTitle: 'Balance sheet',
    profitAndLossTitle: 'Statement of profit and loss',
    balanceSheet: [
      H('EL', 'I. Equity and liabilities', 0),
      H('SF', '(1) Shareholders’ funds'),
      L('SHARE_CAPITAL', '(a) Share capital', 'CREDIT', ['SHARE_CAPITAL']),
      L('RESERVES', '(b) Reserves and surplus', 'CREDIT', ['RETAINED_EARNINGS', 'OWNER_DRAWINGS', 'OTHER_EQUITY'], { takesUnclosedProfit: true, note: 'Includes the surplus in the statement of profit and loss not yet closed to retained earnings.' }),
      H('NCL', '(2) Non-current liabilities'),
      L('LT_BORROWINGS', '(a) Long-term borrowings', 'CREDIT', ['LONG_TERM_DEBT']),
      L('OTHER_LT_LIABILITIES', '(b) Other long-term liabilities', 'CREDIT', ['OTHER_NON_CURRENT_LIABILITY']),
      H('CL', '(3) Current liabilities'),
      L('ST_BORROWINGS', '(a) Short-term borrowings', 'CREDIT', ['CREDIT_CARD']),
      L('TRADE_PAYABLES', '(b) Trade payables', 'CREDIT', ['ACCOUNTS_PAYABLE'], { note: 'Schedule III splits this between micro and small enterprises and others; that split is not made.' }),
      L('OTHER_CL', '(c) Other current liabilities', 'CREDIT', ['ACCRUED_LIABILITY', 'TAX_PAYABLE', 'PAYROLL_LIABILITY', 'OTHER_CURRENT_LIABILITY', 'EMPLOYEE_REIMBURSEMENTS']),
      T('TOTAL_EL', 'Total equity and liabilities', plus('SHARE_CAPITAL', 'RESERVES', 'LT_BORROWINGS', 'OTHER_LT_LIABILITIES', 'ST_BORROWINGS', 'TRADE_PAYABLES', 'OTHER_CL'), 0),
      H('A', 'II. Assets', 0),
      H('NCA', '(1) Non-current assets'),
      L('PPE', '(a) Property, plant and equipment', 'DEBIT', ['FIXED_ASSET', 'ACCUMULATED_DEPRECIATION'], { note: 'Net of accumulated depreciation.' }),
      L('OTHER_NCA', '(b) Other non-current assets', 'DEBIT', ['OTHER_NON_CURRENT_ASSET']),
      H('CA', '(2) Current assets'),
      L('INVENTORIES', '(a) Inventories', 'DEBIT', ['INVENTORY']),
      L('TRADE_RECEIVABLES', '(b) Trade receivables', 'DEBIT', ['ACCOUNTS_RECEIVABLE']),
      L('CASH', '(c) Cash and cash equivalents', 'DEBIT', ['CASH', 'BANK']),
      L('ST_LOANS_ADVANCES', '(d) Short-term loans and advances', 'DEBIT', ['PREPAID', 'TAX_RECEIVABLE']),
      L('OTHER_CA', '(e) Other current assets', 'DEBIT', ['OTHER_CURRENT_ASSET']),
      T('TOTAL_A', 'Total assets', plus('PPE', 'OTHER_NCA', 'INVENTORIES', 'TRADE_RECEIVABLES', 'CASH', 'ST_LOANS_ADVANCES', 'OTHER_CA'), 0),
    ],
    profitAndLoss: [
      L('REVENUE', 'I. Revenue from operations', 'CREDIT', ['OPERATING_REVENUE']),
      L('OTHER_INCOME', 'II. Other income', 'CREDIT', ['OTHER_INCOME']),
      T('TOTAL_INCOME', 'III. Total income (I + II)', plus('REVENUE', 'OTHER_INCOME')),
      H('EXP', 'IV. Expenses'),
      L('COST_OF_MATERIALS', 'Cost of materials consumed and purchases of stock-in-trade', 'DEBIT', ['COST_OF_SALES'], { note: 'Changes in inventories are not shown separately.' }),
      L('EMPLOYEE_BENEFITS', 'Employee benefits expense', 'DEBIT', ['PAYROLL_EXPENSE']),
      L('FINANCE_COSTS', 'Finance costs', 'DEBIT', ['INTEREST_EXPENSE']),
      L('DEPRECIATION', 'Depreciation and amortisation expense', 'DEBIT', ['DEPRECIATION']),
      L('OTHER_EXPENSES', 'Other expenses', 'DEBIT', ['OPERATING_EXPENSE', 'OTHER_EXPENSE', 'FX_GAIN_LOSS']),
      T('TOTAL_EXPENSES', 'Total expenses (IV)', plus('COST_OF_MATERIALS', 'EMPLOYEE_BENEFITS', 'FINANCE_COSTS', 'DEPRECIATION', 'OTHER_EXPENSES')),
      T('PBT', 'V. Profit before tax (III − IV)', [['TOTAL_INCOME', 1], ['TOTAL_EXPENSES', -1]]),
      L('TAX', 'VI. Tax expense', 'DEBIT', ['TAX_EXPENSE']),
      T('PROFIT', 'VII. Profit (loss) for the period (V − VI)', [['PBT', 1], ['TAX', -1]], 0),
    ],
    balanceCheck: ['TOTAL_EL', 'TOTAL_A'],
    profitRow: 'PROFIT',
    fallback: { ASSET: 'OTHER_CA', LIABILITY: 'OTHER_CL', EQUITY: 'RESERVES', REVENUE: 'OTHER_INCOME', EXPENSE: 'OTHER_EXPENSES' },
    sources: [{ title: 'Ministry of Corporate Affairs: Companies Act, 2013, Schedule III', url: 'https://www.mca.gov.in' }],
    notIncluded: ['Notes to accounts, significant accounting policies and the cash flow statement', 'Current and non-current split of borrowings repayable within twelve months', 'Ageing schedules of trade payables and receivables, and the MSME split', 'Exceptional and extraordinary items, earnings per share', 'Rounding to lakhs, crores or thousands', 'Filing on the MCA portal (AOC-4, XBRL)'],
  },
  {
    id: 'GB_COMPANIES_ACT',
    name: 'United Kingdom: Companies Act formats (FRS 102)',
    countries: ['GB'],
    basis: 'Companies Act 2006 and the Large and Medium-sized Companies and Groups (Accounts and Reports) Regulations 2008, Schedule 1: balance sheet Format 1 and profit and loss account Format 1, as used with FRS 102.',
    balanceSheetTitle: 'Balance sheet',
    profitAndLossTitle: 'Profit and loss account',
    balanceSheet: [
      H('FA', 'Fixed assets', 0),
      L('TANGIBLE', 'Tangible assets', 'DEBIT', ['FIXED_ASSET', 'ACCUMULATED_DEPRECIATION'], { note: 'Net of accumulated depreciation.' }),
      L('OTHER_FA', 'Other fixed assets', 'DEBIT', ['OTHER_NON_CURRENT_ASSET'], { note: 'Intangible assets and investments are not told apart.' }),
      T('TOTAL_FA', 'Total fixed assets', plus('TANGIBLE', 'OTHER_FA')),
      H('CA', 'Current assets', 0),
      L('STOCKS', 'Stocks', 'DEBIT', ['INVENTORY']),
      L('DEBTORS', 'Debtors', 'DEBIT', ['ACCOUNTS_RECEIVABLE', 'PREPAID', 'TAX_RECEIVABLE', 'OTHER_CURRENT_ASSET']),
      L('CASH', 'Cash at bank and in hand', 'DEBIT', ['CASH', 'BANK']),
      T('TOTAL_CA', 'Total current assets', plus('STOCKS', 'DEBTORS', 'CASH')),
      L('CREDITORS_1Y', 'Creditors: amounts falling due within one year', 'CREDIT', ['ACCOUNTS_PAYABLE', 'CREDIT_CARD', 'ACCRUED_LIABILITY', 'TAX_PAYABLE', 'PAYROLL_LIABILITY', 'OTHER_CURRENT_LIABILITY', 'EMPLOYEE_REIMBURSEMENTS'], { level: 1 }),
      T('NET_CA', 'Net current assets (liabilities)', [['TOTAL_CA', 1], ['CREDITORS_1Y', -1]]),
      T('TALCL', 'Total assets less current liabilities', plus('TOTAL_FA', 'NET_CA')),
      L('CREDITORS_AFTER_1Y', 'Creditors: amounts falling due after more than one year', 'CREDIT', ['LONG_TERM_DEBT', 'OTHER_NON_CURRENT_LIABILITY'], { level: 1 }),
      T('NET_ASSETS', 'Net assets', [['TALCL', 1], ['CREDITORS_AFTER_1Y', -1]], 0),
      H('CR', 'Capital and reserves', 0),
      L('SHARE_CAPITAL', 'Called up share capital', 'CREDIT', ['SHARE_CAPITAL']),
      L('OTHER_RESERVES', 'Other reserves', 'CREDIT', ['OTHER_EQUITY']),
      L('PL_RESERVE', 'Profit and loss account', 'CREDIT', ['RETAINED_EARNINGS', 'OWNER_DRAWINGS'], { takesUnclosedProfit: true, note: 'Includes profit not yet closed to retained earnings.' }),
      T('SHAREHOLDERS_FUNDS', 'Shareholders’ funds', plus('SHARE_CAPITAL', 'OTHER_RESERVES', 'PL_RESERVE'), 0),
    ],
    profitAndLoss: [
      L('TURNOVER', 'Turnover', 'CREDIT', ['OPERATING_REVENUE']),
      L('COST_OF_SALES', 'Cost of sales', 'DEBIT', ['COST_OF_SALES']),
      T('GROSS_PROFIT', 'Gross profit (loss)', [['TURNOVER', 1], ['COST_OF_SALES', -1]]),
      L('ADMIN', 'Administrative expenses', 'DEBIT', ['OPERATING_EXPENSE', 'PAYROLL_EXPENSE', 'DEPRECIATION', 'OTHER_EXPENSE', 'FX_GAIN_LOSS'], { note: 'Distribution costs are not told apart from administrative expenses.' }),
      L('OTHER_OP_INCOME', 'Other operating income', 'CREDIT', ['OTHER_INCOME']),
      T('OPERATING_PROFIT', 'Operating profit (loss)', [['GROSS_PROFIT', 1], ['ADMIN', -1], ['OTHER_OP_INCOME', 1]]),
      L('INTEREST', 'Interest payable and similar expenses', 'DEBIT', ['INTEREST_EXPENSE']),
      T('PBT', 'Profit (loss) before taxation', [['OPERATING_PROFIT', 1], ['INTEREST', -1]]),
      L('TAX', 'Tax on profit', 'DEBIT', ['TAX_EXPENSE']),
      T('PROFIT', 'Profit (loss) for the financial year', [['PBT', 1], ['TAX', -1]], 0),
    ],
    balanceCheck: ['NET_ASSETS', 'SHAREHOLDERS_FUNDS'],
    profitRow: 'PROFIT',
    fallback: { ASSET: 'DEBTORS', LIABILITY: 'CREDITORS_1Y', EQUITY: 'OTHER_RESERVES', REVENUE: 'OTHER_OP_INCOME', EXPENSE: 'ADMIN' },
    sources: [{ title: 'legislation.gov.uk: SI 2008/410, Schedule 1 (formats)', url: 'https://www.legislation.gov.uk/uksi/2008/410/schedule/1' }, { title: 'FRC: FRS 102', url: 'https://www.frc.org.uk' }],
    notIncluded: ['Notes, accounting policies, directors’ report and the statement of changes in equity', 'Small-company abridged or filleted accounts', 'Intangible assets, investments and distribution costs as separate lines', 'Filing with Companies House or HMRC (iXBRL)'],
  },
  {
    id: 'IFRS_IAS1',
    name: 'IFRS: IAS 1 presentation',
    countries: [],
    basis: 'IAS 1 Presentation of Financial Statements: statement of financial position with current and non-current classification, and profit or loss with expenses by function. Used where Talk2Tax has no local format.',
    balanceSheetTitle: 'Statement of financial position',
    profitAndLossTitle: 'Statement of profit or loss',
    balanceSheet: [
      H('A', 'Assets', 0),
      H('NCA', 'Non-current assets'),
      L('PPE', 'Property, plant and equipment', 'DEBIT', ['FIXED_ASSET', 'ACCUMULATED_DEPRECIATION'], { note: 'Net of accumulated depreciation.' }),
      L('OTHER_NCA', 'Other non-current assets', 'DEBIT', ['OTHER_NON_CURRENT_ASSET']),
      H('CA', 'Current assets'),
      L('INVENTORIES', 'Inventories', 'DEBIT', ['INVENTORY']),
      L('RECEIVABLES', 'Trade and other receivables', 'DEBIT', ['ACCOUNTS_RECEIVABLE', 'PREPAID', 'TAX_RECEIVABLE', 'OTHER_CURRENT_ASSET']),
      L('CASH', 'Cash and cash equivalents', 'DEBIT', ['CASH', 'BANK']),
      T('TOTAL_A', 'Total assets', plus('PPE', 'OTHER_NCA', 'INVENTORIES', 'RECEIVABLES', 'CASH'), 0),
      H('EL', 'Equity and liabilities', 0),
      H('EQ', 'Equity'),
      L('SHARE_CAPITAL', 'Share capital', 'CREDIT', ['SHARE_CAPITAL']),
      L('RETAINED', 'Retained earnings', 'CREDIT', ['RETAINED_EARNINGS', 'OWNER_DRAWINGS'], { takesUnclosedProfit: true, note: 'Includes profit not yet closed to retained earnings.' }),
      L('OTHER_RESERVES', 'Other reserves', 'CREDIT', ['OTHER_EQUITY']),
      H('NCL', 'Non-current liabilities'),
      L('LT_BORROWINGS', 'Borrowings', 'CREDIT', ['LONG_TERM_DEBT']),
      L('OTHER_NCL', 'Other non-current liabilities', 'CREDIT', ['OTHER_NON_CURRENT_LIABILITY']),
      H('CL', 'Current liabilities'),
      L('PAYABLES', 'Trade and other payables', 'CREDIT', ['ACCOUNTS_PAYABLE', 'ACCRUED_LIABILITY', 'TAX_PAYABLE', 'PAYROLL_LIABILITY', 'OTHER_CURRENT_LIABILITY', 'EMPLOYEE_REIMBURSEMENTS']),
      L('ST_BORROWINGS', 'Short-term borrowings', 'CREDIT', ['CREDIT_CARD']),
      T('TOTAL_EL', 'Total equity and liabilities', plus('SHARE_CAPITAL', 'RETAINED', 'OTHER_RESERVES', 'LT_BORROWINGS', 'OTHER_NCL', 'PAYABLES', 'ST_BORROWINGS'), 0),
    ],
    profitAndLoss: [
      L('REVENUE', 'Revenue', 'CREDIT', ['OPERATING_REVENUE']),
      L('COST_OF_SALES', 'Cost of sales', 'DEBIT', ['COST_OF_SALES']),
      T('GROSS_PROFIT', 'Gross profit', [['REVENUE', 1], ['COST_OF_SALES', -1]]),
      L('OTHER_INCOME', 'Other income', 'CREDIT', ['OTHER_INCOME']),
      L('ADMIN', 'Administrative and other expenses', 'DEBIT', ['OPERATING_EXPENSE', 'PAYROLL_EXPENSE', 'DEPRECIATION', 'OTHER_EXPENSE', 'FX_GAIN_LOSS']),
      T('OPERATING_PROFIT', 'Operating profit', [['GROSS_PROFIT', 1], ['OTHER_INCOME', 1], ['ADMIN', -1]]),
      L('FINANCE_COSTS', 'Finance costs', 'DEBIT', ['INTEREST_EXPENSE']),
      T('PBT', 'Profit before tax', [['OPERATING_PROFIT', 1], ['FINANCE_COSTS', -1]]),
      L('TAX', 'Income tax expense', 'DEBIT', ['TAX_EXPENSE']),
      T('PROFIT', 'Profit (loss) for the period', [['PBT', 1], ['TAX', -1]], 0),
    ],
    balanceCheck: ['TOTAL_A', 'TOTAL_EL'],
    profitRow: 'PROFIT',
    fallback: { ASSET: 'RECEIVABLES', LIABILITY: 'PAYABLES', EQUITY: 'OTHER_RESERVES', REVENUE: 'OTHER_INCOME', EXPENSE: 'ADMIN' },
    sources: [{ title: 'IFRS Foundation: IAS 1 Presentation of Financial Statements', url: 'https://www.ifrs.org/issued-standards/list-of-standards/ias-1-presentation-of-financial-statements/' }],
    notIncluded: ['Notes, accounting policies, the statement of changes in equity and the statement of cash flows', 'Other comprehensive income', 'Provisions, current tax and deferred tax as separate lines', 'Any local filing'],
  },
] as StatutoryFormat[]);

export function statutoryFormat(id: string): StatutoryFormat {
  const f = STATUTORY_FORMATS.find((x) => x.id === id);
  if (!f) throw new Error(`Unknown statutory format ${id}`);
  return f;
}

/** The layout an organisation in this country uses unless it picks another. */
export function defaultStatutoryFormat(countryCode: string): StatutoryFormatId {
  return STATUTORY_FORMATS.find((f) => f.countries.includes(countryCode.toUpperCase()))?.id ?? 'IFRS_IAS1';
}

export interface StatutoryAccountLine { accountId: string; code: string; name: string; amount: Dec }
export interface StatutoryRow {
  key: string;
  label: string;
  kind: StatutoryRowSpec['kind'];
  level: number;
  note: string | null;
  amount: Dec | null;
  accounts: StatutoryAccountLine[];
}
export interface StatutoryStatement { rows: StatutoryRow[] }
export interface StatutoryStatements {
  format: StatutoryFormat;
  balanceSheet: StatutoryStatement;
  profitAndLoss: StatutoryStatement;
  /** Profit to the balance sheet date not yet closed to retained earnings. */
  unclosedProfit: Dec;
  balanced: boolean;
  /** The profit row equals the books' net profit for the period. */
  profitAgrees: boolean;
  netProfit: Dec;
  /** Accounts placed by their type only, because their subtype is missing or not mapped. */
  unclassified: { accountId: string; code: string; name: string; type: AccountType; subtype: string | null; placedOn: string }[];
}

const isPnl = (t: AccountType) => t === 'REVENUE' || t === 'EXPENSE';

function place(spec: readonly StatutoryRowSpec[], fallback: string, m: AccountMovement): { key: string; mapped: boolean } {
  const hit = m.subtype ? spec.find((r) => r.kind === 'LINE' && r.subtypes?.includes(m.subtype!)) : undefined;
  return hit ? { key: hit.key, mapped: true } : { key: fallback, mapped: false };
}

function build(spec: readonly StatutoryRowSpec[], movements: readonly AccountMovement[], fallback: Readonly<Record<AccountType, string>>, unclassified: StatutoryStatements['unclassified'], extra?: { key: string; amount: Dec }): StatutoryStatement {
  const lines = new Map<string, StatutoryAccountLine[]>();
  const sideOf = new Map(spec.filter((r) => r.kind === 'LINE').map((r) => [r.key, r.side!]));
  for (const m of movements) {
    const net = dec(String(m.debit)).minus(dec(String(m.credit)));
    if (net.isZero()) continue;
    const { key, mapped } = place(spec, fallback[m.type], m);
    if (!mapped) unclassified.push({ accountId: m.accountId, code: m.code, name: m.name, type: m.type, subtype: m.subtype ?? null, placedOn: key });
    const amount = sideOf.get(key) === 'DEBIT' ? net : net.negated();
    const list = lines.get(key) ?? [];
    list.push({ accountId: m.accountId, code: m.code, name: m.name, amount });
    lines.set(key, list);
  }
  const values = new Map<string, Dec>();
  const rows: StatutoryRow[] = [];
  for (const r of spec) {
    let amount: Dec | null = null;
    const accounts = (lines.get(r.key) ?? []).sort((a, b) => a.code.localeCompare(b.code));
    if (r.kind === 'LINE') {
      amount = sum(accounts.map((a) => a.amount));
      if (extra && r.key === extra.key) amount = amount.plus(extra.amount);
    } else if (r.kind === 'TOTAL') {
      amount = (r.sum ?? []).reduce((acc, [k, s]) => acc.plus((values.get(k) ?? new D(0)).times(s)), new D(0) as Dec);
    }
    if (amount) values.set(r.key, amount);
    rows.push({ key: r.key, label: r.label, kind: r.kind, level: r.level, note: r.note ?? null, amount, accounts });
  }
  return { rows };
}

/**
 * Builds both statements. `position` holds balances from the beginning to the balance sheet
 * date; `period` holds movements in the profit and loss period.
 */
export function buildStatutoryStatements(formatId: StatutoryFormatId, position: readonly AccountMovement[], period: readonly AccountMovement[]): StatutoryStatements {
  const format = statutoryFormat(formatId);
  const unclassified: StatutoryStatements['unclassified'] = [];
  const pnlTotal = (ms: readonly AccountMovement[]) => sum(ms.filter((m) => isPnl(m.type)).map((m) => dec(String(m.credit)).minus(dec(String(m.debit)))));
  const unclosedProfit = pnlTotal(position);
  const equityKey = format.balanceSheet.find((r) => r.takesUnclosedProfit)!.key;
  const balanceSheet = build(format.balanceSheet, position.filter((m) => !isPnl(m.type)), format.fallback, unclassified, { key: equityKey, amount: unclosedProfit });
  const profitAndLoss = build(format.profitAndLoss, period.filter((m) => isPnl(m.type)), format.fallback, unclassified);
  const val = (st: StatutoryStatement, k: string) => st.rows.find((r) => r.key === k)?.amount ?? new D(0);
  const netProfit = pnlTotal(period);
  const seen = new Set<string>();
  return {
    format,
    balanceSheet,
    profitAndLoss,
    unclosedProfit,
    balanced: val(balanceSheet, format.balanceCheck[0]).equals(val(balanceSheet, format.balanceCheck[1])),
    profitAgrees: val(profitAndLoss, format.profitRow).equals(netProfit),
    netProfit,
    unclassified: unclassified.filter((u) => (seen.has(u.accountId) ? false : (seen.add(u.accountId), true))),
  };
}

/** Every subtype in the chart is placed by every format (checked by tests). */
export function unmappedSubtypes(formatId: StatutoryFormatId): string[] {
  const f = statutoryFormat(formatId);
  const mapped = new Set([...f.balanceSheet, ...f.profitAndLoss].flatMap((r) => r.subtypes ?? []));
  return Object.values(ACCOUNT_SUBTYPES).flat().filter((s) => !mapped.has(s));
}
