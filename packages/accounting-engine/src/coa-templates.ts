import { AccountType } from './accounts';

export interface CoaTemplateAccount {
  code: string;
  name: string;
  type: AccountType;
  subtype?: string;
  parentCode?: string;
  isPostable: boolean;
}

/**
 * A generic small-business chart of accounts. It is a starting point, not a
 * jurisdiction-specific statutory chart; tenants can extend or edit it.
 */
export const GENERIC_SMB_COA: readonly CoaTemplateAccount[] = Object.freeze([
  { code: '1000', name: 'Assets', type: 'ASSET', isPostable: false },
  { code: '1100', name: 'Current Assets', type: 'ASSET', parentCode: '1000', isPostable: false },
  { code: '1110', name: 'Cash on Hand', type: 'ASSET', subtype: 'CASH', parentCode: '1100', isPostable: true },
  { code: '1120', name: 'Operating Bank Account', type: 'ASSET', subtype: 'BANK', parentCode: '1100', isPostable: true },
  { code: '1200', name: 'Accounts Receivable', type: 'ASSET', subtype: 'ACCOUNTS_RECEIVABLE', parentCode: '1100', isPostable: true },
  { code: '1300', name: 'Inventory', type: 'ASSET', subtype: 'INVENTORY', parentCode: '1100', isPostable: true },
  { code: '1400', name: 'Prepaid Expenses', type: 'ASSET', subtype: 'PREPAID', parentCode: '1100', isPostable: true },
  { code: '1450', name: 'Input Tax Receivable', type: 'ASSET', subtype: 'TAX_RECEIVABLE', parentCode: '1100', isPostable: true },
  { code: '1500', name: 'Non-Current Assets', type: 'ASSET', parentCode: '1000', isPostable: false },
  { code: '1510', name: 'Property, Plant and Equipment', type: 'ASSET', subtype: 'FIXED_ASSET', parentCode: '1500', isPostable: true },
  { code: '1520', name: 'Accumulated Depreciation', type: 'ASSET', subtype: 'ACCUMULATED_DEPRECIATION', parentCode: '1500', isPostable: true },
  { code: '2000', name: 'Liabilities', type: 'LIABILITY', isPostable: false },
  { code: '2100', name: 'Accounts Payable', type: 'LIABILITY', subtype: 'ACCOUNTS_PAYABLE', parentCode: '2000', isPostable: true },
  { code: '2250', name: 'Employee Reimbursements Payable', type: 'LIABILITY', subtype: 'EMPLOYEE_REIMBURSEMENTS', parentCode: '2000', isPostable: true },
  { code: '2150', name: 'Credit Card Payable', type: 'LIABILITY', subtype: 'CREDIT_CARD', parentCode: '2000', isPostable: true },
  { code: '2200', name: 'Accrued Liabilities', type: 'LIABILITY', subtype: 'ACCRUED_LIABILITY', parentCode: '2000', isPostable: true },
  { code: '2300', name: 'Output Tax Payable', type: 'LIABILITY', subtype: 'TAX_PAYABLE', parentCode: '2000', isPostable: true },
  { code: '2350', name: 'Deferred Revenue', type: 'LIABILITY', subtype: 'OTHER_CURRENT_LIABILITY', parentCode: '2000', isPostable: true },
  { code: '2400', name: 'Payroll Liabilities', type: 'LIABILITY', subtype: 'PAYROLL_LIABILITY', parentCode: '2000', isPostable: true },
  { code: '2700', name: 'Long-Term Loans', type: 'LIABILITY', subtype: 'LONG_TERM_DEBT', parentCode: '2000', isPostable: true },
  { code: '3000', name: 'Equity', type: 'EQUITY', isPostable: false },
  { code: '3100', name: 'Share Capital', type: 'EQUITY', subtype: 'SHARE_CAPITAL', parentCode: '3000', isPostable: true },
  { code: '3200', name: 'Retained Earnings', type: 'EQUITY', subtype: 'RETAINED_EARNINGS', parentCode: '3000', isPostable: true },
  { code: '3300', name: 'Owner Drawings', type: 'EQUITY', subtype: 'OWNER_DRAWINGS', parentCode: '3000', isPostable: true },
  { code: '4000', name: 'Revenue', type: 'REVENUE', isPostable: false },
  { code: '4100', name: 'Sales Revenue', type: 'REVENUE', subtype: 'OPERATING_REVENUE', parentCode: '4000', isPostable: true },
  { code: '4200', name: 'Service Revenue', type: 'REVENUE', subtype: 'OPERATING_REVENUE', parentCode: '4000', isPostable: true },
  { code: '4900', name: 'Other Income', type: 'REVENUE', subtype: 'OTHER_INCOME', parentCode: '4000', isPostable: true },
  { code: '5000', name: 'Cost of Sales', type: 'EXPENSE', subtype: 'COST_OF_SALES', isPostable: true },
  { code: '6000', name: 'Operating Expenses', type: 'EXPENSE', isPostable: false },
  { code: '6100', name: 'Salaries and Wages', type: 'EXPENSE', subtype: 'PAYROLL_EXPENSE', parentCode: '6000', isPostable: true },
  { code: '6200', name: 'Rent', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE', parentCode: '6000', isPostable: true },
  { code: '6300', name: 'Utilities', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE', parentCode: '6000', isPostable: true },
  { code: '6400', name: 'Software and Subscriptions', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE', parentCode: '6000', isPostable: true },
  { code: '6500', name: 'Marketing', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE', parentCode: '6000', isPostable: true },
  { code: '6600', name: 'Professional Fees', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE', parentCode: '6000', isPostable: true },
  { code: '6700', name: 'Travel', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE', parentCode: '6000', isPostable: true },
  { code: '6800', name: 'Depreciation Expense', type: 'EXPENSE', subtype: 'DEPRECIATION', parentCode: '6000', isPostable: true },
  { code: '6900', name: 'Bank Charges', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE', parentCode: '6000', isPostable: true },
  { code: '7100', name: 'Interest Expense', type: 'EXPENSE', subtype: 'INTEREST_EXPENSE', isPostable: true },
  { code: '7200', name: 'Foreign Exchange Gain/Loss', type: 'EXPENSE', subtype: 'FX_GAIN_LOSS', isPostable: true },
  { code: '7300', name: 'Rounding Differences', type: 'EXPENSE', subtype: 'OTHER_EXPENSE', isPostable: true },
  { code: '8100', name: 'Income Tax Expense', type: 'EXPENSE', subtype: 'TAX_EXPENSE', isPostable: true },
]);
