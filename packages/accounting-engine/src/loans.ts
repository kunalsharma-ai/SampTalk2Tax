import Decimal from 'decimal.js';
import { D, dec, type Dec } from './money';

/**
 * Loans: repayment schedules, interest and the split of what is owed between the next twelve
 * months and later. Interest is charged monthly on the balance at the start of each installment
 * period (monthly rests), as Indian term and vehicle loans usually are.
 */
export type LoanMethod = 'EMI' | 'EQUAL_PRINCIPAL';

export class LoanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoanError';
  }
}

export interface LoanRow {
  no: number;
  dueDate: string;
  opening: string;
  interest: string;
  principal: string;
  payment: string;
  closing: string;
}

export interface LoanProjection {
  /** Balance owed now. */
  balance: string;
  /** Annual interest rate in percent, e.g. "9.25". */
  annualRate: string;
  method: LoanMethod;
  /** The EMI (EMI method) or the principal part of each installment (equal principal). */
  installment: string;
  /** Number of the next installment. */
  startNo: number;
  /** Due date of installment 1; later ones fall on the same day of each month. */
  firstDueDate: string;
  /** When set, this installment clears the balance (a fixed term); otherwise rows run until it is paid. */
  lastNo?: number | null;
  scale: number;
}

const MAX_ROWS = 600;

/** Annual percent to the monthly rate as a fraction. */
export function monthlyRate(annualRate: string | Dec): Dec {
  return dec(annualRate).div(1200);
}

/** The due date of installment k: the first due date's day in each later month, or the month's last day. */
export function loanDueDate(firstDueDate: string, k: number): string {
  const y = +firstDueDate.slice(0, 4);
  const m = +firstDueDate.slice(5, 7) - 1 + (k - 1);
  const day = +firstDueDate.slice(8, 10);
  const ty = y + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ty, tm, Math.min(day, last))).toISOString().slice(0, 10);
}

/**
 * The installment for a balance over n months: the EMI (balance × r × (1+r)^n / ((1+r)^n − 1),
 * or balance / n at a zero rate), or the principal part (balance / n) for equal principal.
 * Rounded to the currency; the last installment takes whatever rounding leaves.
 */
export function loanInstallment(method: LoanMethod, balance: string | Dec, annualRate: string | Dec, months: number, scale: number): Dec {
  if (!Number.isInteger(months) || months < 1) throw new LoanError('The term must be at least one month');
  const b = dec(balance);
  const r = monthlyRate(annualRate);
  if (method === 'EQUAL_PRINCIPAL' || r.isZero()) return b.div(months).toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
  const f = r.plus(1).pow(months);
  return b.times(r).times(f).div(f.minus(1)).toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
}

/** The rows still to pay, from the balance owed now. */
export function projectLoan(p: LoanProjection): LoanRow[] {
  const r = monthlyRate(p.annualRate);
  const inst = dec(p.installment);
  if (!inst.gt(0)) throw new LoanError('The installment must be more than zero');
  let bal = dec(p.balance);
  const rows: LoanRow[] = [];
  for (let no = p.startNo; bal.gt(0); no++) {
    if (rows.length >= MAX_ROWS) throw new LoanError(`The loan would take more than ${MAX_ROWS} installments to repay`);
    const interest = bal.times(r).toDecimalPlaces(p.scale, Decimal.ROUND_HALF_UP);
    let principal = p.method === 'EMI' ? inst.minus(interest) : inst;
    if (!principal.gt(0)) throw new LoanError(`The installment of ${inst.toFixed(p.scale)} does not cover the interest of ${interest.toFixed(p.scale)}; raise it or keep the term instead`);
    if (principal.gt(bal) || (p.lastNo != null && no >= p.lastNo)) principal = bal;
    const closing = bal.minus(principal);
    rows.push({ no, dueDate: loanDueDate(p.firstDueDate, no), opening: bal.toFixed(p.scale), interest: interest.toFixed(p.scale), principal: principal.toFixed(p.scale), payment: principal.plus(interest).toFixed(p.scale), closing: closing.toFixed(p.scale) });
    bal = closing;
  }
  return rows;
}

export interface LoanTermsInput {
  principal: string;
  annualRate: string;
  months: number;
  method: LoanMethod;
  disbursementDate: string;
  firstDueDate: string;
}

/** What is wrong with a loan's terms, if anything. */
export function checkLoanTerms(t: LoanTermsInput): string[] {
  const errors: string[] = [];
  const amount = /^\d{1,15}(\.\d{1,6})?$/.test(t.principal) ? new D(t.principal) : null;
  if (!amount || !amount.gt(0)) errors.push('The amount borrowed must be more than zero');
  const rate = /^\d{1,3}(\.\d{1,4})?$/.test(t.annualRate) ? new D(t.annualRate) : null;
  if (!rate || rate.gte(100)) errors.push('Give the annual interest rate as a percentage below 100, up to 4 decimal places');
  if (!Number.isInteger(t.months) || t.months < 1 || t.months > 480) errors.push('The term must be 1 to 480 months');
  if (t.firstDueDate <= t.disbursementDate) errors.push('The first installment must fall after the loan is taken');
  return errors;
}

/** The full schedule of a new loan. */
export function loanSchedule(t: LoanTermsInput, scale: number): LoanRow[] {
  const errors = checkLoanTerms(t);
  if (errors.length) throw new LoanError(errors[0]!);
  const installment = loanInstallment(t.method, t.principal, t.annualRate, t.months, scale);
  return projectLoan({ balance: t.principal, annualRate: t.annualRate, method: t.method, installment: installment.toFixed(scale), startNo: 1, firstDueDate: t.firstDueDate, lastNo: t.months, scale });
}

/** Principal falling due within twelve months of a date (current) and after (non-current). */
export function loanMaturity(rows: readonly LoanRow[], asOf: string, scale: number) {
  const y = +asOf.slice(0, 4) + 1;
  const horizon = `${y}${asOf.slice(4)}`;
  let current = new D(0);
  let later = new D(0);
  for (const r of rows) (r.dueDate <= horizon ? (current = current.plus(r.principal)) : (later = later.plus(r.principal)));
  return { current: current.toFixed(scale), nonCurrent: later.toFixed(scale) };
}

/** Totals of a set of rows. */
export function loanTotals(rows: readonly LoanRow[], scale: number) {
  const s = (k: 'interest' | 'principal' | 'payment') => rows.reduce((a, r) => a.plus(r[k]), new D(0)).toFixed(scale);
  return { interest: s('interest'), principal: s('principal'), payment: s('payment'), installments: rows.length };
}
