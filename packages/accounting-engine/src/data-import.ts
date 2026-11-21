import { ACCOUNT_SUBTYPES, ACCOUNT_TYPES, type AccountType } from './accounts';
import { parseCsv } from './bank';
import { D, type Dec } from './money';

/**
 * Data import (UX-009 to UX-012): a chart of accounts, customers, vendors and opening balances
 * from a spreadsheet saved as CSV. Planning is pure: it reads the file, matches the columns by
 * name, checks every row against the books as they are, and says what would be created, what is
 * skipped because it is already there, and what is wrong, row by row. Nothing is written until a
 * person has seen the plan and every problem is fixed.
 */

export const IMPORT_KINDS = ['accounts', 'customers', 'vendors', 'opening-balances'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export interface ImportColumn {
  key: string;
  label: string;
  required: boolean;
  /** Other headings that mean the same column (compared without case, spaces or punctuation). */
  aliases: string[];
  hint: string;
}

const col = (key: string, label: string, required: boolean, aliases: string[], hint: string): ImportColumn => ({ key, label, required, aliases, hint });

const CONTACT_COLUMNS: ImportColumn[] = [
  col('name', 'Name', true, ['company', 'company name', 'customer name', 'vendor name', 'supplier name', 'display name', 'party name'], 'As it should appear on documents.'),
  col('email', 'Email', false, ['email address', 'e-mail'], 'Where documents and reminders go.'),
  col('phone', 'Phone', false, ['mobile', 'phone number', 'telephone'], ''),
  col('gstin', 'GSTIN', false, ['gst number', 'gst no', 'gst registration'], 'India: 15 characters; the state is taken from it.'),
  col('pan', 'PAN', false, ['pan number', 'pan no'], 'India: taken from the GSTIN when there is one.'),
  col('stateCode', 'State code', false, ['state', 'gst state code', 'place of supply'], 'India: two digits, for a contact without a GSTIN.'),
  col('taxId', 'Tax ID', false, ['tax number', 'vat number', 'trn'], 'Outside India.'),
  col('address', 'Address', false, ['billing address', 'street'], ''),
  col('city', 'City', false, ['town', 'locality'], ''),
  col('pincode', 'PIN code', false, ['pin', 'postcode', 'postal code', 'zip'], 'India: six digits.'),
  col('paymentTermsDays', 'Payment terms (days)', false, ['payment terms', 'terms', 'credit days', 'due days'], 'Whole days; 30 when left empty.'),
  col('creditLimit', 'Credit limit', false, ['credit'], 'An amount in your currency.'),
];

export const IMPORT_COLUMNS: Readonly<Record<ImportKind, ImportColumn[]>> = Object.freeze({
  accounts: [
    col('code', 'Code', true, ['account code', 'account number', 'number', 'gl code', 'ledger code'], 'Letters, digits, dot or dash, up to 32.'),
    col('name', 'Name', true, ['account name', 'ledger name', 'account'], ''),
    col('type', 'Type', true, ['account type', 'class', 'category'], 'Asset, Liability, Equity, Revenue (or Income) or Expense.'),
    col('subtype', 'Subtype', false, ['detail type', 'sub type', 'group'], 'Such as Bank, Fixed asset or Operating expense.'),
    col('parentCode', 'Parent code', false, ['parent', 'parent account', 'under'], 'A header account in this file or already in your chart.'),
    col('header', 'Header', false, ['is header', 'summary', 'group account'], 'Yes for a heading that holds other accounts and takes no entries.'),
    col('description', 'Description', false, ['notes'], ''),
  ],
  customers: CONTACT_COLUMNS,
  vendors: CONTACT_COLUMNS,
  'opening-balances': [
    col('code', 'Account code', true, ['code', 'account number', 'gl code', 'ledger code'], 'An account in your chart.'),
    col('name', 'Account name', false, ['account', 'name', 'ledger'], 'Only to help you read the file; the code decides the account.'),
    col('debit', 'Debit', false, ['dr', 'debit balance'], 'Debit or credit on each line, not both.'),
    col('credit', 'Credit', false, ['cr', 'credit balance'], ''),
  ],
});

const EXAMPLES: Readonly<Record<ImportKind, string[][]>> = Object.freeze({
  accounts: [
    ['1500', 'Office equipment', 'Asset', 'Fixed asset', '', 'No', 'Computers and furniture'],
    ['6100', 'Software subscriptions', 'Expense', 'Operating expense', '', 'No', ''],
  ],
  customers: [['Asha Traders', 'accounts@asha.example', '+91 98200 00000', '27AAPFU0939F1ZV', '', '', '', '12 MG Road', 'Pune', '411001', '30', '500000']],
  vendors: [['Bharat Supplies', 'billing@bharat.example', '', '', 'AAPFB1234C', '29', '', '4 Residency Road', 'Bengaluru', '560025', '45', '']],
  'opening-balances': [
    ['1100', 'Bank', '250000.00', ''],
    ['2100', 'Loan from director', '', '100000.00'],
  ],
});

/** A CSV with the headings, and example rows to replace. */
export function importTemplate(kind: ImportKind): string {
  const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [IMPORT_COLUMNS[kind].map((c) => c.label), ...EXAMPLES[kind]].map((r) => r.map(quote).join(',')).join('\n') + '\n';
}

export interface ImportIssue {
  /** The spreadsheet row (the heading is row 1), or 0 for the whole file. */
  row: number;
  column: string | null;
  message: string;
}

export interface ImportRow<T> {
  row: number;
  action: 'CREATE' | 'SKIP';
  /** Why a row is skipped. */
  reason: string | null;
  values: T;
}

export interface ImportPlan<T> {
  kind: ImportKind;
  /** Each column found, and the heading it was read from. */
  columns: { key: string; label: string; heading: string }[];
  /** Headings that match no column; they are left out. */
  ignored: string[];
  rows: ImportRow<T>[];
  issues: ImportIssue[];
  summary: { rows: number; create: number; skip: number; problems: number };
}

export interface AccountImportValues {
  code: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  parentCode: string | null;
  isPostable: boolean;
  description: string | null;
}

export interface ContactImportValues {
  name: string;
  email: string | null;
  phone: string | null;
  gstin: string | null;
  pan: string | null;
  stateCode: string | null;
  taxId: string | null;
  address: string | null;
  city: string | null;
  pincode: string | null;
  paymentTermsDays: number | null;
  creditLimit: string | null;
}

export interface OpeningBalanceImportValues {
  accountId: string;
  code: string;
  name: string;
  debit: string | null;
  credit: string | null;
}

export const IMPORT_MAX_ROWS = 2000;

const article = (word: string) => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Reads the file: delimiter, headings matched to columns, and the rows as objects by column key. */
function readFile(kind: ImportKind, text: string) {
  const issues: ImportIssue[] = [];
  const first = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const grid = parseCsv(text, delimiter).filter((r) => r.some((c) => c.trim() !== ''));
  if (!grid.length) return { columns: [], ignored: [], records: [], issues: [{ row: 0, column: null, message: 'The file is empty.' }] };
  const headings = grid[0]!.map((h) => h.trim());
  const spec = IMPORT_COLUMNS[kind];
  const columns: { key: string; label: string; heading: string; index: number }[] = [];
  const ignored: string[] = [];
  headings.forEach((h, index) => {
    const c = spec.find((s) => [s.label, s.key, ...s.aliases].some((name) => norm(name) === norm(h)));
    if (!c || !h) {
      if (h) ignored.push(h);
      return;
    }
    if (columns.some((x) => x.key === c.key)) issues.push({ row: 1, column: c.label, message: `Two columns are read as ${c.label} ("${columns.find((x) => x.key === c.key)!.heading}" and "${h}"); keep one.` });
    else columns.push({ key: c.key, label: c.label, heading: h, index });
  });
  for (const s of spec) if (s.required && !columns.some((c) => c.key === s.key)) issues.push({ row: 1, column: s.label, message: `No ${s.label} column. Name a column "${s.label}".` });
  const body = grid.slice(1);
  if (body.length > IMPORT_MAX_ROWS) issues.push({ row: 0, column: null, message: `The file has ${body.length} rows; import at most ${IMPORT_MAX_ROWS} at a time.` });
  const records = body.slice(0, IMPORT_MAX_ROWS).map((cells, i) => {
    const values: Record<string, string> = {};
    for (const c of columns) values[c.key] = (cells[c.index] ?? '').trim();
    return { row: i + 2, values };
  });
  return { columns: columns.map(({ key, label, heading }) => ({ key, label, heading })), ignored, records, issues };
}

function finish<T>(kind: ImportKind, read: ReturnType<typeof readFile>, rows: ImportRow<T>[], issues: ImportIssue[]): ImportPlan<T> {
  const all = [...read.issues, ...issues].sort((a, b) => a.row - b.row);
  const bad = new Set(all.map((i) => i.row));
  return {
    kind,
    columns: read.columns,
    ignored: read.ignored,
    rows,
    issues: all,
    summary: { rows: read.records.length, create: rows.filter((r) => r.action === 'CREATE' && !bad.has(r.row)).length, skip: rows.filter((r) => r.action === 'SKIP').length, problems: all.length },
  };
}

const TYPE_WORDS: Record<string, AccountType> = {
  asset: 'ASSET', assets: 'ASSET',
  liability: 'LIABILITY', liabilities: 'LIABILITY',
  equity: 'EQUITY', capital: 'EQUITY',
  revenue: 'REVENUE', income: 'REVENUE', sales: 'REVENUE',
  expense: 'EXPENSE', expenses: 'EXPENSE', cost: 'EXPENSE',
};
const YES = new Set(['yes', 'y', 'true', '1', 'header']);
const NO = new Set(['no', 'n', 'false', '0', '']);
const CODE = /^[A-Za-z0-9][A-Za-z0-9.\-]{0,31}$/;

/** Accounts: new codes are created (parents first), codes already in the chart are skipped. */
export function planAccountImport(text: string, existing: { code: string; type: AccountType; isPostable: boolean }[]): ImportPlan<AccountImportValues> {
  const read = readFile('accounts', text);
  const issues: ImportIssue[] = [];
  const have = new Map(existing.map((a) => [a.code.toLowerCase(), a]));
  const inFile = new Map<string, { row: number; type: AccountType | null; isPostable: boolean }>();
  const rows: ImportRow<AccountImportValues>[] = [];
  for (const { row, values: v } of read.records) {
    const problem = (column: string, message: string) => issues.push({ row, column, message });
    const code = v.code ?? '';
    if (!code) problem('Code', 'Code is empty.');
    else if (!CODE.test(code)) problem('Code', `"${code}" is not a valid code: letters, digits, dot or dash, up to 32.`);
    const name = v.name ?? '';
    if (!name) problem('Name', 'Name is empty.');
    else if (name.length > 200) problem('Name', 'Name is longer than 200 characters.');
    const type = TYPE_WORDS[norm(v.type ?? '')] ?? (ACCOUNT_TYPES as readonly string[]).find((t) => t === (v.type ?? '').toUpperCase()) as AccountType | undefined;
    if (!type) problem('Type', `"${v.type ?? ''}" is not a type: use Asset, Liability, Equity, Revenue or Expense.`);
    let subtype: string | null = null;
    if (v.subtype && type) {
      subtype = ACCOUNT_SUBTYPES[type].find((s) => norm(s) === norm(v.subtype!)) ?? null;
      if (!subtype) problem('Subtype', `"${v.subtype}" is not ${article(type.toLowerCase())} subtype. Use one of: ${ACCOUNT_SUBTYPES[type].map((s) => s.toLowerCase().replace(/_/g, ' ')).join(', ')}.`);
    }
    const headerWord = (v.header ?? '').toLowerCase();
    if (!YES.has(headerWord) && !NO.has(headerWord)) problem('Header', `"${v.header}" is not yes or no.`);
    const isPostable = !YES.has(headerWord);
    const description = v.description ? v.description.slice(0, 1000) : null;
    const parentCode = v.parentCode || null;
    if (code && inFile.has(code.toLowerCase())) {
      problem('Code', `Code ${code} is also on row ${inFile.get(code.toLowerCase())!.row}.`);
      continue;
    }
    if (code) inFile.set(code.toLowerCase(), { row, type: type ?? null, isPostable });
    const already = code ? have.get(code.toLowerCase()) : undefined;
    rows.push({
      row,
      action: already ? 'SKIP' : 'CREATE',
      reason: already ? `Code ${already.code} is already in your chart` : null,
      values: { code, name, type: type ?? ((v.type ?? '').toUpperCase() as AccountType), subtype, parentCode, isPostable, description },
    });
  }
  // Parents: in the chart or in this file, a header account of the same type, and no loops.
  for (const r of rows) {
    // A row whose own type is wrong is reported once, for its type.
    if (!r.values.parentCode || r.action === 'SKIP' || !(ACCOUNT_TYPES as readonly string[]).includes(r.values.type)) continue;
    const key = r.values.parentCode.toLowerCase();
    const parent = inFile.get(key) ?? have.get(key);
    if (!parent) issues.push({ row: r.row, column: 'Parent code', message: `Parent ${r.values.parentCode} is not in this file or your chart.` });
    else if (parent.type && parent.type !== r.values.type) issues.push({ row: r.row, column: 'Parent code', message: `Parent ${r.values.parentCode} is ${article(parent.type.toLowerCase())} account; ${article(r.values.type.toLowerCase())} account needs ${article(r.values.type.toLowerCase())} parent.` });
    else if (parent.isPostable) issues.push({ row: r.row, column: 'Parent code', message: `Parent ${r.values.parentCode} takes entries; mark it as a header (Header: yes) to put accounts under it.` });
    else if (key === r.values.code.toLowerCase()) issues.push({ row: r.row, column: 'Parent code', message: 'An account cannot be its own parent.' });
  }
  const seen = new Set<string>();
  const byCode = new Map(rows.map((r) => [r.values.code.toLowerCase(), r]));
  for (const r of rows) {
    seen.clear();
    let at: ImportRow<AccountImportValues> | undefined = r;
    while (at?.values.parentCode && byCode.has(at.values.parentCode.toLowerCase())) {
      if (seen.has(at.values.code.toLowerCase())) {
        issues.push({ row: r.row, column: 'Parent code', message: 'The parent codes go round in a loop.' });
        break;
      }
      seen.add(at.values.code.toLowerCase());
      at = byCode.get(at.values.parentCode.toLowerCase());
    }
  }
  return finish('accounts', read, orderParentsFirst(rows), dedupe(issues));
}

/** Rows to create, each after the row of its parent, so a parent always exists when its child is made. */
function orderParentsFirst(rows: ImportRow<AccountImportValues>[]): ImportRow<AccountImportValues>[] {
  const byCode = new Map(rows.map((r) => [r.values.code.toLowerCase(), r]));
  const out: ImportRow<AccountImportValues>[] = [];
  const placed = new Set<ImportRow<AccountImportValues>>();
  const visiting = new Set<ImportRow<AccountImportValues>>();
  const place = (r: ImportRow<AccountImportValues>) => {
    if (placed.has(r) || visiting.has(r)) return;
    visiting.add(r);
    const parent = r.values.parentCode ? byCode.get(r.values.parentCode.toLowerCase()) : undefined;
    if (parent) place(parent);
    visiting.delete(r);
    placed.add(r);
    out.push(r);
  };
  rows.forEach(place);
  return out;
}

function dedupe(issues: ImportIssue[]): ImportIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.row}|${i.column}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AMOUNT = /^\d{1,18}(\.\d{1,10})?$/;

/** A spreadsheet amount: thousands separators and a currency sign are allowed; negatives are not. */
export function importAmount(raw: string): Dec | null {
  const s = raw.replace(/[\s,₹$€£]/g, '');
  if (!s) return null;
  if (!AMOUNT.test(s)) throw new Error(`"${raw}" is not an amount`);
  return new D(s);
}

/**
 * Customers or vendors: new names are created, names already in your contacts are skipped
 * (compared without case). `checkGstin` is the tax engine's GSTIN check, passed in so this
 * package stays free of it.
 */
export function planContactImport(
  kind: 'customers' | 'vendors',
  text: string,
  existing: { name: string }[],
  opts: { decimals: number; checkGstin?: (gstin: string) => { valid: boolean; issues: string[]; stateCode?: string | null } },
): ImportPlan<ContactImportValues> {
  const read = readFile(kind, text);
  const issues: ImportIssue[] = [];
  const have = new Map(existing.map((c) => [c.name.trim().toLowerCase(), c.name]));
  const inFile = new Map<string, number>();
  const rows: ImportRow<ContactImportValues>[] = [];
  for (const { row, values: v } of read.records) {
    const problem = (column: string, message: string) => issues.push({ row, column, message });
    const text = (k: string, max: number, label: string) => {
      const s = v[k] ?? '';
      if (s.length > max) problem(label, `${label} is longer than ${max} characters.`);
      return s || null;
    };
    const name = v.name ?? '';
    if (!name) problem('Name', 'Name is empty.');
    else if (name.length > 200) problem('Name', 'Name is longer than 200 characters.');
    const email = text('email', 320, 'Email');
    if (email && !EMAIL.test(email)) problem('Email', `"${email}" is not an email address.`);
    const gstin = v.gstin ? v.gstin.toUpperCase().replace(/\s/g, '') : null;
    let gstState: string | null = null;
    if (gstin && opts.checkGstin) {
      const check = opts.checkGstin(gstin);
      if (!check.valid) problem('GSTIN', `${gstin}: ${check.issues.join('; ')}`);
      else gstState = check.stateCode ?? null;
    }
    const pan = v.pan ? v.pan.toUpperCase() : null;
    if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) problem('PAN', `"${pan}" is not a PAN (five letters, four digits, a letter).`);
    if (pan && gstin && gstin.slice(2, 12) !== pan) problem('PAN', `The PAN is not the one inside the GSTIN (${gstin.slice(2, 12)}).`);
    const stateCode = v.stateCode ? v.stateCode.padStart(2, '0') : null;
    if (stateCode && !/^\d{2}$/.test(stateCode)) problem('State code', `"${v.stateCode}" is not a two-digit state code.`);
    if (stateCode && gstState && stateCode !== gstState) problem('State code', `The GSTIN is registered in state ${gstState}, not ${stateCode}.`);
    const pincode = v.pincode ? v.pincode.replace(/\s/g, '') : null;
    if (pincode && !/^[1-9][0-9]{5}$/.test(pincode)) problem('PIN code', `"${v.pincode}" is not a six-digit PIN code.`);
    let paymentTermsDays: number | null = null;
    if (v.paymentTermsDays) {
      const m = v.paymentTermsDays.match(/^(?:net\s*)?(\d{1,4})(?:\s*days?)?$/i);
      if (!m || Number(m[1]) > 3650) problem('Payment terms (days)', `"${v.paymentTermsDays}" is not a number of days (0 to 3650).`);
      else paymentTermsDays = Number(m[1]);
    }
    let creditLimit: string | null = null;
    if (v.creditLimit) {
      try {
        const amount = importAmount(v.creditLimit);
        if (amount && amount.decimalPlaces() > opts.decimals) problem('Credit limit', `"${v.creditLimit}" has more than ${opts.decimals} decimal places.`);
        else creditLimit = amount ? amount.toFixed() : null;
      } catch {
        problem('Credit limit', `"${v.creditLimit}" is not an amount.`);
      }
    }
    const key = name.trim().toLowerCase();
    if (key && inFile.has(key)) {
      problem('Name', `${name} is also on row ${inFile.get(key)}.`);
      continue;
    }
    if (key) inFile.set(key, row);
    const already = key ? have.get(key) : undefined;
    rows.push({
      row,
      action: already ? 'SKIP' : 'CREATE',
      reason: already ? `${already} is already in your contacts` : null,
      values: { name, email, phone: text('phone', 50, 'Phone'), gstin, pan, stateCode, taxId: text('taxId', 50, 'Tax ID'), address: text('address', 1000, 'Address'), city: text('city', 50, 'City'), pincode, paymentTermsDays, creditLimit },
    });
  }
  return finish(kind, read, rows, issues);
}

/**
 * Opening balances: one debit or credit per account, by code, against the accounts that take an
 * opening balance. The result replaces the current opening balances as a whole; a difference
 * between debits and credits goes to Opening Balance Equity, as when they are typed in.
 */
export function planOpeningBalanceImport(text: string, accounts: { id: string; code: string; name: string }[], opts: { decimals: number }): ImportPlan<OpeningBalanceImportValues> & { totals: { debit: string; credit: string; difference: string } } {
  const read = readFile('opening-balances', text);
  const issues: ImportIssue[] = [];
  const byCode = new Map(accounts.map((a) => [a.code.toLowerCase(), a]));
  const inFile = new Map<string, number>();
  const rows: ImportRow<OpeningBalanceImportValues>[] = [];
  let debit = new D(0);
  let credit = new D(0);
  for (const { row, values: v } of read.records) {
    const problem = (column: string, message: string) => issues.push({ row, column, message });
    const code = v.code ?? '';
    const account = byCode.get(code.toLowerCase());
    if (!code) problem('Account code', 'Account code is empty.');
    else if (!account) problem('Account code', `${code} is not an account that takes an opening balance (it is not in your chart, or it is a header, inactive, a receivables or payables control account, or Opening Balance Equity).`);
    const amount = (k: 'debit' | 'credit', label: string) => {
      try {
        const a = importAmount(v[k] ?? '');
        if (a && a.decimalPlaces() > opts.decimals) {
          problem(label, `"${v[k]}" has more than ${opts.decimals} decimal places.`);
          return null;
        }
        return a && !a.isZero() ? a : null;
      } catch {
        problem(label, `"${v[k]}" is not an amount.`);
        return null;
      }
    };
    const d = amount('debit', 'Debit');
    const c = amount('credit', 'Credit');
    if (d && c) problem('Debit', 'Give a debit or a credit, not both.');
    if (account && inFile.has(account.id)) {
      problem('Account code', `${code} is also on row ${inFile.get(account.id)}.`);
      continue;
    }
    if (!d && !c) {
      if (account) rows.push({ row, action: 'SKIP', reason: 'No amount', values: { accountId: account.id, code: account.code, name: account.name, debit: null, credit: null } });
      continue;
    }
    if (!account) continue;
    inFile.set(account.id, row);
    if (d && !c) debit = debit.plus(d);
    if (c && !d) credit = credit.plus(c);
    rows.push({ row, action: 'CREATE', reason: null, values: { accountId: account.id, code: account.code, name: account.name, debit: d && !c ? d.toFixed(opts.decimals) : null, credit: c && !d ? c.toFixed(opts.decimals) : null } });
  }
  if (!read.issues.length && !issues.length && !rows.some((r) => r.action === 'CREATE')) issues.push({ row: 0, column: null, message: 'No line has an amount.' });
  return { ...finish('opening-balances', read, rows, issues), totals: { debit: debit.toFixed(opts.decimals), credit: credit.toFixed(opts.decimals), difference: debit.minus(credit).toFixed(opts.decimals) } };
}
