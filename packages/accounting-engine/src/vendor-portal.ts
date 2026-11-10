/**
 * Vendor portal (AP-013). A vendor opens a private link to see their bills, when they will be
 * paid, the payments made to them, the purchase orders still open, and their statement, and to
 * send an invoice for the business to record. Only the SHA-256 of the link's secret is stored.
 */
import { makePortalToken } from './customer-portal';
import { addDays } from './documents';
import { D } from './money';

/** t2tv_ followed by 40 letters and digits (about 238 bits). */
export const VENDOR_PORTAL_TOKEN_PATTERN = /^t2tv_[A-Za-z0-9]{40}$/;
export const makeVendorPortalToken = (random: (n: number) => Uint8Array) => `t2tv_${makePortalToken(random).slice(5)}`;
export const vendorPortalTokenPrefix = (token: string) => token.slice(5, 13);

/** How a bill stands for the vendor: what is still to be paid to them. */
export type VendorBillState = 'TO_BE_PAID' | 'DUE' | 'PART_PAID' | 'PAID' | 'VOID';
export function vendorBillState(d: { status: string; total: string; open: string; dueDate: string | null }, today: string): VendorBillState {
  if (d.status === 'VOID') return 'VOID';
  if (new D(d.open).lte(0)) return 'PAID';
  if (new D(d.open).lt(d.total)) return 'PART_PAID';
  if (d.dueDate && d.dueDate <= today) return 'DUE';
  return 'TO_BE_PAID';
}

export const VENDOR_SUBMISSION_STATUSES = ['RECEIVED', 'RECORDED', 'REJECTED'] as const;
export type VendorSubmissionStatus = (typeof VENDOR_SUBMISSION_STATUSES)[number];
export const VENDOR_SUBMISSION_LABEL: Record<VendorSubmissionStatus, string> = { RECEIVED: 'Received, being checked', RECORDED: 'Recorded', REJECTED: 'Not accepted' };

/** At most this many invoices from one vendor can wait to be checked at once. */
export const MAX_PENDING_VENDOR_SUBMISSIONS = 25;
/** An invoice dated longer ago than this cannot be sent through the portal. */
export const VENDOR_SUBMISSION_MAX_AGE_DAYS = 548;
/** A file can be added to a sent invoice for this long after sending it. */
export const VENDOR_SUBMISSION_FILE_MINUTES = 60;

/** The invoice number as compared for duplicates: case, spaces and separators do not matter. */
export const invoiceNumberKey = (n: string) => n.toUpperCase().replace(/[\s\-/_.]/g, '');

export interface VendorSubmissionInput {
  invoiceNumber: string;
  invoiceDate: string;
  amount: string;
  currency: string;
}

/** What is wrong with an invoice a vendor sends; empty when it can be accepted for checking. */
export function validateVendorSubmission(s: VendorSubmissionInput, today: string): string[] {
  const issues: string[] = [];
  const n = s.invoiceNumber.trim();
  if (!n) issues.push('Enter your invoice number');
  else if (n.length > 40) issues.push('The invoice number can be at most 40 characters');
  else if (!/^[A-Za-z0-9][A-Za-z0-9 \-/_.]*$/.test(n)) issues.push('The invoice number can have letters, digits, spaces and - / _ . only');
  else if (!invoiceNumberKey(n)) issues.push('Enter your invoice number');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.invoiceDate) || Number.isNaN(Date.parse(`${s.invoiceDate}T00:00:00Z`))) issues.push('Enter the invoice date');
  else if (s.invoiceDate > today) issues.push('The invoice date cannot be in the future');
  else if (s.invoiceDate < addDays(today, -VENDOR_SUBMISSION_MAX_AGE_DAYS)) issues.push('The invoice is dated more than 18 months ago; contact the business instead');
  if (!/^\d{1,15}(\.\d{1,2})?$/.test(s.amount)) issues.push('Enter the invoice total, with at most 2 decimal places');
  else if (new D(s.amount).lte(0)) issues.push('The invoice total must be more than zero');
  if (!/^[A-Z]{3}$/.test(s.currency)) issues.push('Choose the currency');
  return issues;
}

/** Whether a file can still be added to a sent invoice. */
export const submissionFileOpen = (createdAt: Date, now: Date) => now.getTime() - createdAt.getTime() < VENDOR_SUBMISSION_FILE_MINUTES * 60_000;
