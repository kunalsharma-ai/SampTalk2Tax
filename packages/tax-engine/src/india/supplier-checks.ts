import { checkGstin } from './gstin';
import { checkPan } from './withholding';

/**
 * Supplier tax validation (AP-019). Checks a vendor's GST and PAN details against each other,
 * against other vendors, against the bills they sent and against the last check of their GSTIN
 * on the GST portal that someone recorded. Talk2Tax does not query the GST portal itself
 * (that needs a GST Suvidha Provider connection), so the registration status comes from a
 * person who looked it up, with the date they did.
 */

export const REGISTRATION_STATUSES = ['ACTIVE', 'CANCELLED', 'SUSPENDED', 'NOT_FOUND'] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];
export const REGISTRATION_STATUS_LABEL: Record<RegistrationStatus, string> = { ACTIVE: 'Active', CANCELLED: 'Cancelled', SUSPENDED: 'Suspended', NOT_FOUND: 'Not found on the portal' };
export const TAXPAYER_TYPES = ['REGULAR', 'COMPOSITION', 'SEZ', 'CASUAL', 'NON_RESIDENT', 'OTHER'] as const;
export type TaxpayerType = (typeof TAXPAYER_TYPES)[number];
export const TAXPAYER_TYPE_LABEL: Record<TaxpayerType, string> = { REGULAR: 'Regular', COMPOSITION: 'Composition', SEZ: 'SEZ unit or developer', CASUAL: 'Casual taxable person', NON_RESIDENT: 'Non-resident taxable person', OTHER: 'Other' };
/** A portal check older than this is due again. */
export const RECHECK_AFTER_DAYS = 180;
/** The GST portal's public "Search Taxpayer" page, where anyone can look a GSTIN up. */
export const GST_PORTAL_SEARCH_URL = 'https://services.gst.gov.in/services/searchtp';

export type SupplierIssueSeverity = 'HIGH' | 'MEDIUM' | 'LOW';
export interface SupplierIssue {
  code: string;
  severity: SupplierIssueSeverity;
  message: string;
  /** Bills the issue is about, by number. */
  bills?: string[];
}

export interface SupplierFacts {
  name: string;
  gstin: string | null;
  stateCode: string | null;
  pan: string | null;
  /** The vendor has a TDS section set. */
  tdsSection: string | null;
  /** Other active vendors with the same GSTIN or PAN. */
  sameGstin: string[];
  samePan: string[];
  /** The latest recorded portal check of this vendor's current GSTIN. */
  verification: { status: RegistrationStatus; taxpayerType: TaxpayerType | null; checkedOn: string; legalName: string | null; effectiveDate: string | null } | null;
  /** Posted bills in the period (vendor credits excluded). */
  bills: { number: string; date: string; gstin: string | null; supplierState: string | null; placeOfSupply: string | null; reverseCharge: boolean; cgst: string; sgst: string; igst: string }[];
}

const n = (s: string) => Number(s);
const list = (bills: { number: string }[]) => bills.map((b) => b.number);
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(PRIVATE|PVT|LIMITED|LTD|LLP|THE|AND|CO|COMPANY)/g, '');

/** Every issue found for one vendor, most serious first. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 2026-11-05 → "5 Nov 2026", for messages people read. */
const longDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

export function supplierTaxIssues(v: SupplierFacts, today: string): SupplierIssue[] {
  const out: SupplierIssue[] = [];
  const gstBills = v.bills.filter((b) => !b.reverseCharge && n(b.cgst) + n(b.sgst) + n(b.igst) > 0);
  if (v.gstin) {
    const g = checkGstin(v.gstin);
    if (!g.valid) out.push({ code: 'GSTIN_INVALID', severity: 'HIGH', message: `The GSTIN ${v.gstin} is not valid: ${g.issues.join('; ')}` });
    else {
      if (v.stateCode && g.stateCode !== v.stateCode) out.push({ code: 'STATE_MISMATCH', severity: 'MEDIUM', message: `The GSTIN is registered in state ${g.stateCode}, but the vendor's state is ${v.stateCode}` });
      if (v.pan && g.pan !== v.pan) out.push({ code: 'PAN_MISMATCH', severity: 'HIGH', message: `The GSTIN carries PAN ${g.pan}, but the vendor's PAN is ${v.pan}` });
    }
  }
  if (v.pan && !checkPan(v.pan).valid) out.push({ code: 'PAN_INVALID', severity: 'HIGH', message: `The PAN ${v.pan} is not valid: ${checkPan(v.pan).issues.join('; ')}` });
  if (!v.pan && v.tdsSection) out.push({ code: 'TDS_NO_PAN', severity: 'MEDIUM', message: `TDS under ${v.tdsSection} is deducted from this vendor but there is no PAN, so the higher rate under section 206AA applies. Ask for their PAN.` });
  if (v.sameGstin.length) out.push({ code: 'DUPLICATE_GSTIN', severity: 'MEDIUM', message: `The same GSTIN is on ${v.sameGstin.join(', ')}. One supplier kept as two vendors splits their bills, TDS and payments.` });
  else if (v.samePan.length) out.push({ code: 'DUPLICATE_PAN', severity: 'LOW', message: `The same PAN is on ${v.samePan.join(', ')}. That is right for branches in other states; otherwise merge them.` });

  // GST on bills.
  if (!v.gstin && gstBills.length) out.push({ code: 'GST_WITHOUT_GSTIN', severity: 'HIGH', message: `${gstBills.length === 1 ? 'A bill charges' : `${gstBills.length} bills charge`} GST, but the vendor has no GSTIN. Input tax credit needs the supplier's GSTIN on the invoice; ask for it or treat the GST as a cost.`, bills: list(gstBills) });
  const unregisteredOnBill = gstBills.filter((b) => v.gstin && !b.gstin);
  if (unregisteredOnBill.length) out.push({ code: 'BILL_WITHOUT_GSTIN', severity: 'MEDIUM', message: `${unregisteredOnBill.length === 1 ? 'A bill was' : `${unregisteredOnBill.length} bills were`} saved before the vendor's GSTIN was added, so the GSTIN is missing from ${unregisteredOnBill.length === 1 ? 'it' : 'them'}.`, bills: list(unregisteredOnBill) });
  const otherGstin = v.bills.filter((b) => v.gstin && b.gstin && b.gstin !== v.gstin);
  if (otherGstin.length) out.push({ code: 'BILL_GSTIN_CHANGED', severity: 'LOW', message: `${otherGstin.length === 1 ? 'A bill carries' : `${otherGstin.length} bills carry`} a different GSTIN from the vendor's current one; match ${otherGstin.length === 1 ? 'it' : 'them'} to GSTR-2B under the GSTIN on the bill.`, bills: list(otherGstin) });
  const wrongHead = gstBills.filter((b) => b.supplierState && b.placeOfSupply && ((b.supplierState === b.placeOfSupply && n(b.igst) > 0) || (b.supplierState !== b.placeOfSupply && n(b.cgst) + n(b.sgst) > 0)));
  if (wrongHead.length) out.push({ code: 'WRONG_TAX_HEAD', severity: 'HIGH', message: `${wrongHead.length === 1 ? 'A bill has' : `${wrongHead.length} bills have`} IGST where CGST and SGST apply, or the other way round, for the supplier's state and the place of supply. Credit of tax under the wrong head is not allowed; ask the vendor for a corrected invoice.`, bills: list(wrongHead) });

  // The registration as last checked on the GST portal.
  const vf = v.verification;
  if (v.gstin && !vf) out.push({ code: 'NOT_VERIFIED', severity: 'LOW', message: 'Nobody has recorded a check of this GSTIN on the GST portal yet. Look it up and record what it shows.' });
  if (vf) {
    if (vf.status !== 'ACTIVE') {
      const from = vf.effectiveDate;
      const after = from ? gstBills.filter((b) => b.date >= from) : gstBills;
      out.push({
        code: `REGISTRATION_${vf.status}`,
        severity: 'HIGH',
        message: `On ${longDate(vf.checkedOn)} the GST portal showed this GSTIN as ${REGISTRATION_STATUS_LABEL[vf.status].toLowerCase()}${from ? ` from ${longDate(from)}` : ''}. GST charged by a supplier without a live registration cannot be claimed as input tax credit.${after.length ? ` ${after.length === 1 ? 'One bill with GST is' : `${after.length} bills with GST are`} ${from ? 'dated from then' : 'affected'}.` : ''}`,
        ...(after.length ? { bills: list(after) } : {}),
      });
    }
    if (vf.status === 'ACTIVE' && vf.taxpayerType === 'COMPOSITION' && gstBills.length) {
      out.push({ code: 'COMPOSITION_CHARGED_GST', severity: 'HIGH', message: `The vendor is a composition taxpayer, who may not charge GST or issue a tax invoice, yet ${gstBills.length === 1 ? 'a bill charges' : `${gstBills.length} bills charge`} it. No input tax credit is available on it.`, bills: list(gstBills) });
    }
    if (days(vf.checkedOn, today) > RECHECK_AFTER_DAYS) out.push({ code: 'VERIFICATION_STALE', severity: 'LOW', message: `The GSTIN was last checked on the portal on ${longDate(vf.checkedOn)}, more than ${RECHECK_AFTER_DAYS} days ago. Check it again.` });
    if (vf.legalName && norm(vf.legalName) !== norm(v.name) && !norm(v.name).includes(norm(vf.legalName)) && !norm(vf.legalName).includes(norm(v.name))) {
      out.push({ code: 'NAME_DIFFERS', severity: 'LOW', message: `The portal's legal name is "${vf.legalName}", not "${v.name}". Make sure the bills are from the business you think.` });
    }
  }
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
