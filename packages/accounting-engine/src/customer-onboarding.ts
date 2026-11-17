/**
 * Customer onboarding (AR-003).
 *
 * Before a new customer is invoiced, the organisation collects what it needs about them: contact
 * and tax details on the customer record, documents such as KYC proof or a signed agreement, and
 * an agreed credit limit and payment terms. Someone with approval rights approves the onboarding,
 * which sets the credit limit and terms on the customer. While an onboarding is not approved, no
 * invoice to that customer can be posted.
 *
 * Vendor onboarding (AP-002) is the same process for suppliers: tax details, verified bank details,
 * documents and payment terms, approved before their bills are posted or they are paid.
 */
import { D } from './money';

export type OnboardingStatus = 'OPEN' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';

export const ONBOARDING_STATUS_LABEL: Record<OnboardingStatus, string> = {
  OPEN: 'In progress',
  SUBMITTED: 'Waiting for approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

/** The organisation's own checklist when it has not set one: documents and checks to collect. */
export const DEFAULT_ONBOARDING_REQUIREMENTS: { label: string; needsFile: boolean }[] = [
  { label: 'Proof of identity or registration (certificate of incorporation, GST certificate or PAN card)', needsFile: true },
  { label: 'Signed customer agreement or accepted terms of sale', needsFile: true },
  { label: 'Credit check done (references, bureau report or past payment record)', needsFile: false },
];

export type OnboardingParty = 'CUSTOMER' | 'VENDOR';

/** A vendor's checklist when the organisation has not set one. */
export const DEFAULT_VENDOR_ONBOARDING_REQUIREMENTS: { label: string; needsFile: boolean }[] = [
  { label: 'GST certificate or PAN card', needsFile: true },
  { label: 'Cancelled cheque or bank letter for the account to pay', needsFile: true },
  { label: 'MSME (Udyam) status checked and recorded', needsFile: false },
];

export interface OnboardingContact {
  email: string | null;
  address: string | null;
  pincode: string | null;
  gstin: string | null;
  pan: string | null;
  taxId: string | null;
}

export interface DetailCheck {
  key: 'EMAIL' | 'ADDRESS' | 'TAX_ID' | 'CREDIT_TERMS' | 'BANK' | 'PAYMENT_TERMS';
  label: string;
  done: boolean;
  hint: string;
}

/**
 * The checks read from the customer record and the requested terms, so they can never disagree
 * with it. India: the billing address needs its PIN code and the customer a GSTIN or a PAN.
 */
export function detailChecks(c: OnboardingContact, terms: { creditLimit: string | null; paymentTermsDays: number | null }, countryCode: string): DetailCheck[] {
  const india = countryCode.toUpperCase() === 'IN';
  const has = (s: string | null) => !!s && s.trim().length > 0;
  return [
    { key: 'EMAIL', label: 'Email for invoices and statements', done: has(c.email), hint: 'Add an email address on the customer.' },
    {
      key: 'ADDRESS',
      label: india ? 'Billing address with PIN code' : 'Billing address',
      done: has(c.address) && (!india || /^\d{6}$/.test(c.pincode ?? '')),
      hint: india ? 'Add the billing address and its six-digit PIN code on the customer.' : 'Add the billing address on the customer.',
    },
    {
      key: 'TAX_ID',
      label: india ? 'GSTIN or PAN' : 'Tax registration number',
      done: india ? has(c.gstin) || has(c.pan) : has(c.taxId) || has(c.gstin),
      hint: india ? 'Add the GSTIN, or the PAN of an unregistered customer.' : 'Add the tax number on the customer.',
    },
    {
      key: 'CREDIT_TERMS',
      label: 'Credit limit and payment terms proposed',
      done: terms.creditLimit !== null && terms.paymentTermsDays !== null,
      hint: 'Propose the credit limit (0 for payment in advance) and payment terms.',
    },
  ];
}

/**
 * A vendor's checks from its record: email for remittance advice, address, GSTIN or PAN (TDS
 * depends on the PAN), bank details verified by a second person, and agreed payment terms.
 */
export function vendorDetailChecks(c: OnboardingContact, v: { bankVerified: boolean; paymentTermsDays: number | null }, countryCode: string): DetailCheck[] {
  const [email, address, tax] = detailChecks(c, { creditLimit: null, paymentTermsDays: null }, countryCode).map((d) => ({ ...d, hint: d.hint.replace('customer', 'vendor') }));
  return [
    { ...email!, label: 'Email for remittance advice' },
    { ...address!, label: address!.label.replace('Billing address', 'Address') },
    tax!,
    { key: 'BANK', label: 'Bank details entered and verified', done: v.bankVerified, hint: 'Enter the bank details on the vendor and have someone else verify them.' },
    { key: 'PAYMENT_TERMS', label: 'Payment terms agreed', done: v.paymentTermsDays !== null, hint: 'Enter the payment terms agreed with the vendor.' },
  ];
}

/** Problems with proposed credit terms. */
export function termsIssues(creditLimit: string | null, paymentTermsDays: number | null): string[] {
  const out: string[] = [];
  if (creditLimit !== null) {
    let v: InstanceType<typeof D> | null = null;
    try {
      v = new D(creditLimit);
    } catch {
      out.push('The credit limit must be a number');
    }
    if (v && (v.isNaN() || v.lt(0))) out.push('The credit limit cannot be negative');
    if (v && v.decimalPlaces() > 2) out.push('The credit limit has at most two decimals');
  }
  if (paymentTermsDays !== null && (!Number.isInteger(paymentTermsDays) || paymentTermsDays < 0 || paymentTermsDays > 365)) out.push('Payment terms are 0 to 365 days');
  return out;
}

export interface ItemState {
  label: string;
  needsFile: boolean;
  done: boolean;
  hasFile: boolean;
}

/** What still stands in the way of submitting an onboarding for approval. */
export function submitIssues(details: DetailCheck[], items: ItemState[]): string[] {
  const out = details.filter((d) => !d.done).map((d) => `${d.label}: ${d.hint}`);
  for (const i of items) {
    if (!i.done) out.push(`${i.label}: not done yet`);
    else if (i.needsFile && !i.hasFile) out.push(`${i.label}: attach the file`);
  }
  return out;
}

/** Share of the checklist done, 0 to 100, for progress bars. */
export function onboardingProgress(details: DetailCheck[], items: ItemState[]): number {
  const all = details.length + items.length;
  if (!all) return 100;
  const done = details.filter((d) => d.done).length + items.filter((i) => i.done && (!i.needsFile || i.hasFile)).length;
  return Math.round((done / all) * 100);
}

/**
 * Whether this person may decide on an onboarding: someone other than whoever submitted it, unless
 * nobody else in the organisation can approve (then it is recorded as self-approved).
 */
export function decisionAllowed(submittedById: string, deciderId: string, otherApprovers: number): { allowed: boolean; selfApproved: boolean; reason?: string } {
  if (submittedById !== deciderId) return { allowed: true, selfApproved: false };
  if (otherApprovers > 0) return { allowed: false, selfApproved: false, reason: 'Someone other than the person who submitted it must approve it' };
  return { allowed: true, selfApproved: true };
}
