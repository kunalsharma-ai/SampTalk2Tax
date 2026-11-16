import { JournalLineInput } from './journal';
import { D, Dec, MoneyError, assertCurrencyPrecision, dec, roundToCurrency, sum } from './money';
import { assertIsoDate } from './periods';

/**
 * Sales and purchase documents (Directive Parts 6 and 7).
 *
 * INVOICE and CREDIT_NOTE belong to customers and post through the receivables
 * control account. BILL and VENDOR_CREDIT belong to vendors and post through the
 * payables control account. A document posts one journal entry; payments and
 * credit applications only move amounts between documents inside the same
 * control account, so they never need a journal of their own.
 */
export const DOCUMENT_KINDS = ['INVOICE', 'CREDIT_NOTE', 'BILL', 'VENDOR_CREDIT'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const PAYMENT_KINDS = ['RECEIPT', 'PAYMENT'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export type Ledger = 'SALES' | 'PURCHASES';

export function ledgerOf(kind: DocumentKind): Ledger {
  return kind === 'INVOICE' || kind === 'CREDIT_NOTE' ? 'SALES' : 'PURCHASES';
}

/** Documents that are settled by payments (targets of an allocation). */
export function isChargeDocument(kind: DocumentKind): boolean {
  return kind === 'INVOICE' || kind === 'BILL';
}

/** The credit document that can be applied against a charge document of the same ledger. */
export function creditKindFor(kind: DocumentKind): DocumentKind {
  return kind === 'INVOICE' ? 'CREDIT_NOTE' : kind === 'BILL' ? 'VENDOR_CREDIT' : kind;
}

export function paymentKindFor(ledger: Ledger): PaymentKind {
  return ledger === 'SALES' ? 'RECEIPT' : 'PAYMENT';
}

export const DOCUMENT_PREFIX: Readonly<Record<DocumentKind | PaymentKind, string>> = Object.freeze({
  INVOICE: 'INV',
  CREDIT_NOTE: 'CN',
  BILL: 'BILL',
  VENDOR_CREDIT: 'VC',
  RECEIPT: 'RCPT',
  PAYMENT: 'PAY',
});

export function documentNumber(kind: DocumentKind | PaymentKind, n: number): string {
  return `${DOCUMENT_PREFIX[kind]}-${String(n).padStart(6, '0')}`;
}

export class DocumentValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join('; '));
    this.name = 'DocumentValidationError';
  }
}

export interface DocumentLineInput {
  accountId: string;
  description?: string;
  /** Decimal string, > 0, up to 6 decimal places. */
  quantity: string;
  /** Decimal string, >= 0, in the document currency, up to 6 decimal places. */
  unitPrice: string;
  taxRateId?: string | null;
  /** HSN (goods) or SAC (services) code; used by tax regimes that report it, such as India GST. */
  hsnCode?: string | null;
}

export interface TaxRateInfo {
  id: string;
  name: string;
  /** Percentage as a decimal string, e.g. "18" for 18 %. */
  rate: string;
  /** Account that receives the tax for this ledger (output tax for sales, input tax for purchases). */
  accountId: string | null;
  /**
   * SIMPLE rates post the whole tax to accountId. Any other kind (for example
   * India GST, which splits into central and state components by place of
   * supply) is split by the TaxSplitter passed to computeDocument.
   */
  kind?: 'SIMPLE' | 'GST';
}

/** One part of a line's tax, posted to its own account. */
export interface TaxComponent {
  /** Short label, e.g. "TAX", "CGST", "SGST", "UTGST", "IGST". */
  code: string;
  accountId: string;
  /** Percentage applied for this component. */
  rate: Dec;
  amount: Dec;
}

/**
 * Splits a line's tax into components for rates whose kind is not SIMPLE.
 * Returns the components (already rounded to the currency), or a string
 * explaining why this line cannot be taxed with that rate.
 */
export type TaxSplitter = (netAmount: Dec, rate: TaxRateInfo, currency: string) => TaxComponent[] | string;

export interface ComputedDocumentLine {
  lineNo: number;
  accountId: string;
  description?: string;
  quantity: Dec;
  unitPrice: Dec;
  taxRateId: string | null;
  taxRate: Dec;
  taxAccountId: string | null;
  netAmount: Dec;
  taxAmount: Dec;
  hsnCode: string | null;
  /** The tax amount by account. Their sum always equals taxAmount. */
  taxComponents: TaxComponent[];
}

export interface ComputedDocument {
  lines: ComputedDocumentLine[];
  subtotal: Dec;
  /** Tax charged by the supplier (excludes reverse-charge tax, which the supplier does not charge). */
  taxTotal: Dec;
  /** The amount settled with the contact through the control account. */
  total: Dec;
  /**
   * Reverse charge (for example India GST s.9(3)/(4), IGST s.5(3)): the buyer
   * pays the tax instead of the supplier. Each tax component then posts twice:
   * the input-tax credit to the component's account and the same amount as a
   * liability to `reverseChargeAccounts[accountId]`. None of it is owed to the
   * supplier, so it is not in taxTotal or total.
   */
  reverseCharge?: { accounts: ReadonlyMap<string, string>; tax: Dec };
  /** Income tax withheld (TDS, deducted from what the vendor is paid) or collected (TCS, added to what the customer pays). */
  withholding?: Withholding;
}

export interface Withholding {
  /** Label for the journal line, e.g. "TDS 393(1)-6(iii)(b)". */
  label: string;
  accountId: string;
  amount: Dec;
  /** DEDUCT lowers what the contact is paid (TDS); COLLECT raises what the contact pays (TCS). */
  effect: 'DEDUCT' | 'COLLECT';
}

const MAX_QTY_SCALE = 6;

/**
 * Compute line amounts and totals. Each line's net (quantity x unit price) and
 * tax (net x rate %) are rounded half-even to the currency's minor units; the
 * totals are the sums of the rounded line amounts, so the document always
 * equals the sum of its lines.
 */
export function computeDocument(lines: DocumentLineInput[], currency: string, taxRates: ReadonlyMap<string, TaxRateInfo>, splitter?: TaxSplitter): ComputedDocument {
  const issues: string[] = [];
  if (lines.length === 0) issues.push('A document needs at least one line');
  const computed: ComputedDocumentLine[] = [];
  lines.forEach((l, i) => {
    const n = i + 1;
    let quantity: Dec;
    let unitPrice: Dec;
    try {
      quantity = dec(l.quantity);
      unitPrice = dec(l.unitPrice);
    } catch (e) {
      issues.push(`Line ${n}: ${(e as Error).message}`);
      return;
    }
    if (quantity.lte(0)) issues.push(`Line ${n}: quantity must be greater than zero`);
    if (unitPrice.isNegative()) issues.push(`Line ${n}: unit price cannot be negative`);
    if (quantity.decimalPlaces() > MAX_QTY_SCALE) issues.push(`Line ${n}: quantity allows at most ${MAX_QTY_SCALE} decimal places`);
    if (unitPrice.decimalPlaces() > MAX_QTY_SCALE) issues.push(`Line ${n}: unit price allows at most ${MAX_QTY_SCALE} decimal places`);
    let taxRate = new D(0);
    let taxAccountId: string | null = null;
    const netAmount = roundToCurrency(quantity.times(unitPrice), currency);
    let taxComponents: TaxComponent[] = [];
    if (l.taxRateId) {
      const t = taxRates.get(l.taxRateId);
      if (!t) {
        issues.push(`Line ${n}: tax rate not found or inactive`);
      } else if ((t.kind ?? 'SIMPLE') !== 'SIMPLE') {
        taxRate = dec(t.rate);
        const split = splitter ? splitter(netAmount, t, currency) : `tax rate "${t.name}" needs ${t.kind} details that this document does not have`;
        if (typeof split === 'string') issues.push(`Line ${n}: ${split}`);
        else taxComponents = split.filter((c) => !c.amount.isZero());
      } else {
        taxRate = dec(t.rate);
        taxAccountId = t.accountId;
        if (taxRate.gt(0) && !taxAccountId) issues.push(`Line ${n}: tax rate "${t.name}" has no account for this ledger`);
        const amount = roundToCurrency(netAmount.times(taxRate).dividedBy(100), currency);
        if (amount.gt(0) && taxAccountId) taxComponents = [{ code: 'TAX', accountId: taxAccountId, rate: taxRate, amount }];
      }
    }
    const taxAmount = sum(taxComponents.map((c) => c.amount));
    computed.push({
      lineNo: n,
      accountId: l.accountId,
      description: l.description,
      quantity,
      unitPrice,
      taxRateId: l.taxRateId ?? null,
      taxRate,
      taxAccountId,
      netAmount,
      taxAmount,
      hsnCode: l.hsnCode?.trim() || null,
      taxComponents,
    });
  });
  if (issues.length) throw new DocumentValidationError(issues);
  const subtotal = sum(computed.map((l) => l.netAmount));
  const taxTotal = sum(computed.map((l) => l.taxAmount));
  const total = subtotal.plus(taxTotal);
  if (total.lte(0)) throw new DocumentValidationError(['Document total must be greater than zero']);
  return { lines: computed, subtotal, taxTotal, total };
}

/**
 * Turn a computed purchase document into a reverse-charge one: its tax stays on
 * the lines (it is still the tax on the supply) but leaves taxTotal and total,
 * and each tax account is paired with the liability account it is self-assessed to.
 */
export function applyReverseCharge(doc: ComputedDocument, liabilityFor: ReadonlyMap<string, string>): ComputedDocument {
  if (doc.withholding) throw new MoneyError('Apply reverse charge before withholding');
  const issues: string[] = [];
  for (const l of doc.lines) for (const c of l.taxComponents) if (!liabilityFor.has(c.accountId)) issues.push(`Line ${l.lineNo}: no reverse-charge account for ${c.code}`);
  if (issues.length) throw new DocumentValidationError(issues);
  return { ...doc, taxTotal: new D(0), total: doc.subtotal, reverseCharge: { accounts: liabilityFor, tax: doc.taxTotal } };
}

/**
 * Withhold income tax on a computed document. The amount must already be
 * rounded to the currency and be less than the document total.
 */
export function applyWithholding(doc: ComputedDocument, w: Withholding, currency: string): ComputedDocument {
  if (doc.withholding) throw new MoneyError('A document carries at most one withholding');
  if (w.amount.isNegative()) throw new MoneyError('Withholding cannot be negative');
  assertCurrencyPrecision(w.amount, currency, 'Withholding');
  if (w.amount.isZero()) return doc;
  const total = w.effect === 'DEDUCT' ? doc.total.minus(w.amount) : doc.total.plus(w.amount);
  if (total.lte(0)) throw new DocumentValidationError(['Withholding cannot be the whole document']);
  return { ...doc, total, withholding: w };
}

/**
 * The journal a posted document creates. The control account takes the total;
 * each line's account takes its net amount and each tax account the tax, on
 * the opposite side. Lines that share an account are kept separate so the
 * journal mirrors the document.
 *
 * INVOICE:        Dr receivables  / Cr revenue, Cr output tax
 * CREDIT_NOTE:    Dr revenue, Dr output tax / Cr receivables
 * BILL:           Dr expense, Dr input tax  / Cr payables
 * VENDOR_CREDIT:  Dr payables / Cr expense, Cr input tax
 *
 * Reverse charge adds, per tax account, the self-assessed liability on the
 * control account's side (BILL: Cr output tax). Withholding adds the tax
 * withheld on the control's side when deducted (BILL with TDS: Cr TDS payable,
 * and payables take the total less TDS) or on the other side when collected
 * (INVOICE with TCS: Cr TCS payable, and receivables take the total plus TCS).
 */
export function buildDocumentJournal(kind: DocumentKind, doc: ComputedDocument, controlAccountId: string, currency: string): JournalLineInput[] {
  const controlOnDebit = kind === 'INVOICE' || kind === 'VENDOR_CREDIT';
  const side = (amount: Dec, debit: boolean) => (debit ? { debit: amount.toFixed() } : { credit: amount.toFixed() });
  const out: JournalLineInput[] = [{ accountId: controlAccountId, currency, ...side(doc.total, controlOnDebit), description: 'Document total' }];
  for (const l of doc.lines) {
    if (l.netAmount.gt(0)) out.push({ accountId: l.accountId, currency, ...side(l.netAmount, !controlOnDebit), description: l.description });
  }
  const taxByAccount = new Map<string, Dec>();
  const labelByAccount = new Map<string, string>();
  for (const l of doc.lines) {
    for (const c of l.taxComponents) {
      if (c.amount.lte(0)) continue;
      taxByAccount.set(c.accountId, (taxByAccount.get(c.accountId) ?? new D(0)).plus(c.amount));
      labelByAccount.set(c.accountId, c.code === 'TAX' ? 'Tax' : c.code);
    }
  }
  for (const [accountId, amount] of taxByAccount) out.push({ accountId, currency, ...side(amount, !controlOnDebit), description: labelByAccount.get(accountId) });
  if (doc.reverseCharge) {
    const byLiability = new Map<string, Dec>();
    const labels = new Map<string, string>();
    for (const [accountId, amount] of taxByAccount) {
      const liability = doc.reverseCharge.accounts.get(accountId);
      if (!liability) throw new MoneyError(`No reverse-charge account for ${accountId}`);
      byLiability.set(liability, (byLiability.get(liability) ?? new D(0)).plus(amount));
      labels.set(liability, `${labelByAccount.get(accountId)} (reverse charge)`);
    }
    for (const [accountId, amount] of byLiability) out.push({ accountId, currency, ...side(amount, controlOnDebit), description: labels.get(accountId) });
  }
  if (doc.withholding && doc.withholding.amount.gt(0)) {
    const w = doc.withholding;
    out.push({ accountId: w.accountId, currency, ...side(w.amount, w.effect === 'DEDUCT' ? controlOnDebit : !controlOnDebit), description: w.label });
  }
  return out;
}

/** Receipt: Dr bank / Cr receivables. Payment: Dr payables / Cr bank. */
export function buildPaymentJournal(kind: PaymentKind, amount: Dec, bankAccountId: string, controlAccountId: string, currency: string): JournalLineInput[] {
  if (amount.lte(0)) throw new MoneyError('Payment amount must be greater than zero');
  assertCurrencyPrecision(amount, currency, 'Payment amount');
  const a = amount.toFixed();
  return kind === 'RECEIPT'
    ? [
        { accountId: bankAccountId, currency, debit: a },
        { accountId: controlAccountId, currency, credit: a },
      ]
    : [
        { accountId: controlAccountId, currency, debit: a },
        { accountId: bankAccountId, currency, credit: a },
      ];
}

/** Add days to an ISO date (UTC calendar arithmetic). */
export function addDays(iso: string, days: number): string {
  assertIsoDate(iso);
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  assertIsoDate(fromIso);
  assertIsoDate(toIso);
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

export const AGEING_BUCKETS = ['current', 'days1to30', 'days31to60', 'days61to90', 'over90'] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

/** Bucket by days past the due date as of a date. Not yet due is "current". */
export function ageingBucket(dueDate: string, asOf: string): AgeingBucket {
  const overdue = daysBetween(dueDate, asOf);
  if (overdue <= 0) return 'current';
  if (overdue <= 30) return 'days1to30';
  if (overdue <= 60) return 'days31to60';
  if (overdue <= 90) return 'days61to90';
  return 'over90';
}

/**
 * Validate an allocation of `amount` from a source (payment or credit document)
 * with `sourceRemaining` unallocated, to a target with `targetOutstanding` open.
 * Returns issues; empty means valid.
 */
export function allocationIssues(amount: Dec, sourceRemaining: Dec, targetOutstanding: Dec, currency: string): string[] {
  const issues: string[] = [];
  if (amount.lte(0)) issues.push('Allocation amount must be greater than zero');
  try {
    assertCurrencyPrecision(amount, currency, 'Allocation amount');
  } catch (e) {
    issues.push((e as Error).message);
  }
  if (amount.gt(sourceRemaining)) issues.push(`Allocation ${amount.toFixed()} exceeds the unallocated amount ${sourceRemaining.toFixed()}`);
  if (amount.gt(targetOutstanding)) issues.push(`Allocation ${amount.toFixed()} exceeds the amount still due ${targetOutstanding.toFixed()}`);
  return issues;
}
