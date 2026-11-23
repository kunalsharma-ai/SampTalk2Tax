import { D, Dec, dec } from '@talk2tax/accounting-engine';
import type { GstReturnDocument } from './returns';
import { FOREIGN_PLACE_OF_SUPPLY } from './states';

/**
 * Reverse charge (TAX-032). Under the CGST Act s.9(3) and the IGST Act s.5(3), the buyer pays the
 * GST on notified goods and services. On import of services (IGST Act s.5(3)) the buyer pays it too.
 * Bills already carry a reverse-charge flag. This module adds three things:
 * - the notified categories, matched by HSN/SAC, so a bill that may need reverse charge is pointed out;
 * - a month's register of reverse-charge bills and vendor credits, with the tax by head;
 * - the self-invoice a buyer must issue when the supplier is not registered (CGST Act s.31(3)(f),
 *   within 30 days of receiving the supply under rule 47A).
 * A category match is a prompt to check, never a decision: most entries have conditions about who
 * the supplier and the buyer are that the books cannot see.
 */
export interface ReverseChargeCategory {
  key: string;
  kind: 'GOODS' | 'SERVICES';
  /** HSN/SAC prefixes (digits only) that the category covers. */
  codes: readonly string[];
  title: string;
  /** Who must supply to whom for reverse charge to apply. */
  condition: string;
  /** UNREGISTERED: only when the supplier is not registered (a supplier with a GSTIN is not flagged). */
  supplier: 'ANY' | 'UNREGISTERED';
  source: string;
}

const RCM_SERVICES = 'Notification 13/2017-Central Tax (Rate), as amended';
const RCM_GOODS = 'Notification 4/2017-Central Tax (Rate), as amended';

export const REVERSE_CHARGE_CATEGORIES: readonly ReverseChargeCategory[] = [
  { key: 'GTA', kind: 'SERVICES', codes: ['9965', '996791'], title: 'Goods transport agency (GTA)', condition: 'A goods transport agency that has not opted to charge GST itself, supplying to a factory, society, co-operative, registered person, body corporate, partnership firm or casual taxable person.', supplier: 'ANY', source: `${RCM_SERVICES}, entry 1` },
  { key: 'LEGAL', kind: 'SERVICES', codes: ['99821'], title: 'Legal services by an advocate', condition: 'An individual advocate, a senior advocate or a firm of advocates (or an arbitral tribunal) supplying to a business entity.', supplier: 'ANY', source: `${RCM_SERVICES}, entries 2 and 3` },
  { key: 'SPONSORSHIP', kind: 'SERVICES', codes: ['998397'], title: 'Sponsorship services', condition: 'Any person supplying sponsorship to a body corporate or partnership firm.', supplier: 'ANY', source: `${RCM_SERVICES}, entry 4` },
  { key: 'INSURANCE_AGENT', kind: 'SERVICES', codes: ['997161'], title: 'Insurance agent services', condition: 'An insurance agent supplying to a person carrying on insurance business.', supplier: 'ANY', source: `${RCM_SERVICES}, entry 7` },
  { key: 'SECURITY', kind: 'SERVICES', codes: ['99852'], title: 'Security services', condition: 'Security services (including supply of security personnel) by a person other than a body corporate to a registered person.', supplier: 'ANY', source: `${RCM_SERVICES}, entry 14` },
  { key: 'MOTOR_VEHICLE', kind: 'SERVICES', codes: ['996601'], title: 'Renting of a motor vehicle', condition: 'A person other than a body corporate renting a passenger motor vehicle (with fuel) to a body corporate, without charging GST at the forward-charge rate.', supplier: 'ANY', source: `${RCM_SERVICES}, entry 15` },
  { key: 'RESIDENTIAL_RENT', kind: 'SERVICES', codes: ['997211'], title: 'Renting of a residential dwelling', condition: 'Any person renting a residential dwelling to a registered person.', supplier: 'ANY', source: `${RCM_SERVICES}, entry 5AA` },
  { key: 'COMMERCIAL_RENT', kind: 'SERVICES', codes: ['997212'], title: 'Renting of other immovable property by an unregistered person', condition: 'An unregistered person renting property other than a residential dwelling to a registered person (from 10 October 2024).', supplier: 'UNREGISTERED', source: `${RCM_SERVICES}, entry 5AB` },
  { key: 'CASHEW', kind: 'GOODS', codes: ['0801'], title: 'Cashew nuts, not shelled or peeled', condition: 'Supplied by an agriculturist.', supplier: 'ANY', source: `${RCM_GOODS}, entry 1` },
  { key: 'BIDI_LEAVES', kind: 'GOODS', codes: ['14049010'], title: 'Bidi wrapper leaves (tendu)', condition: 'Supplied by an agriculturist.', supplier: 'ANY', source: `${RCM_GOODS}, entry 2` },
  { key: 'TOBACCO', kind: 'GOODS', codes: ['2401'], title: 'Tobacco leaves', condition: 'Supplied by an agriculturist.', supplier: 'ANY', source: `${RCM_GOODS}, entry 3` },
  { key: 'SILK_YARN', kind: 'GOODS', codes: ['5004', '5005', '5006'], title: 'Silk yarn', condition: 'Supplied by a person who makes silk yarn from raw silk or silk worm cocoons.', supplier: 'ANY', source: `${RCM_GOODS}, entry 4` },
  { key: 'RAW_COTTON', kind: 'GOODS', codes: ['5201'], title: 'Raw cotton', condition: 'Supplied by an agriculturist.', supplier: 'ANY', source: `${RCM_GOODS}, entry 5` },
  { key: 'METAL_SCRAP', kind: 'GOODS', codes: ['7204', '7404', '7503', '7602', '7802', '7902', '8002'], title: 'Metal scrap', condition: 'Supplied by an unregistered person to a registered person (from 10 October 2024).', supplier: 'UNREGISTERED', source: `${RCM_GOODS}, entry 7 (Notification 6/2024-Central Tax (Rate))` },
];

/** The notified category an HSN/SAC code falls under (longest matching prefix), if any. */
export function reverseChargeCategory(hsn: string | null | undefined): ReverseChargeCategory | null {
  const code = (hsn ?? '').replace(/\D/g, '');
  if (!code) return null;
  let best: { c: ReverseChargeCategory; len: number } | null = null;
  for (const c of REVERSE_CHARGE_CATEGORIES) for (const p of c.codes) if (code.startsWith(p) && (!best || p.length > best.len)) best = { c, len: p.length }; // not money
  return best?.c ?? null;
}

/** A self-invoice is due when the supplier is not registered in India (s.31(3)(f)); for import of services too. */
export const selfInvoiceRequired = (d: Pick<GstReturnDocument, 'kind' | 'gstin' | 'supplierState' | 'reverseCharge'>) => d.kind === 'BILL' && !!d.reverseCharge && (!d.gstin || d.supplierState === FOREIGN_PLACE_OF_SUPPLY);

/** Days from receipt of the supply to issue the self-invoice (CGST Rules, rule 47A). */
export const SELF_INVOICE_DAYS = 30; // not money

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10); // not money

/** The financial year of a date, e.g. 2026-27. */
export function financialYearOf(iso: string): string {
  const y = Number(iso.slice(0, 4)); // not money
  const start = Number(iso.slice(5, 7)) >= 4 ? y : y - 1; // not money
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** RCM/2026-27/0001: self-invoices are numbered in one series per financial year (rule 46 allows a separate series). */
export const selfInvoiceNumber = (fy: string, seq: number) => `RCM/${fy}/${String(seq).padStart(4, '0')}`;

export interface SelfInvoiceRecord {
  number: string;
  issuedOn: string;
}

/** Why a self-invoice cannot be issued for this document on `issuedOn` (empty when it can). */
export function selfInvoiceIssues(d: Pick<GstReturnDocument, 'kind' | 'status' | 'gstin' | 'supplierState' | 'reverseCharge' | 'issueDate' | 'number'>, existing: SelfInvoiceRecord | null, issuedOn: string, today: string): string[] {
  const issues: string[] = [];
  if (d.kind !== 'BILL') issues.push('Self-invoices are issued for bills, not vendor credits');
  else if (!d.reverseCharge) issues.push(`${d.number} is not under reverse charge`);
  else if (!selfInvoiceRequired(d)) issues.push('The supplier is registered, so their own tax invoice is the document; no self-invoice is needed');
  if (d.status !== 'POSTED') issues.push(`${d.number} is void`);
  if (existing) issues.push(`Self-invoice ${existing.number} was already issued on ${existing.issuedOn}`);
  if (issuedOn < d.issueDate) issues.push(`A self-invoice cannot be dated before the bill (${d.issueDate})`);
  if (issuedOn > today) issues.push('A self-invoice cannot be dated in the future');
  return issues;
}

type Head = 'igst' | 'cgst' | 'sgst';
const HEADS: readonly Head[] = ['igst', 'cgst', 'sgst'];
interface Totals {
  taxable: string;
  igst: string;
  cgst: string;
  sgst: string;
  tax: string;
}

export interface ReverseChargeRow extends Totals {
  id: string;
  kind: 'BILL' | 'VENDOR_CREDIT';
  number: string;
  issueDate: string;
  contactName: string;
  gstin: string | null;
  importOfServices: boolean;
  /** Notified categories the bill's lines fall under (empty for import of services or an unlisted code). */
  categories: { key: string; title: string }[];
  selfInvoice: { required: boolean; number: string | null; issuedOn: string | null; dueBy: string | null; overdue: boolean };
}

export interface PossiblyMissed {
  id: string;
  number: string;
  issueDate: string;
  contactName: string;
  hsnCode: string;
  category: ReverseChargeCategory;
  /** GST the supplier charged on the bill's matching lines. */
  taxCharged: string;
}

export interface ReverseChargeRegister {
  rows: ReverseChargeRow[];
  /** Bills less vendor credits: the tax to pay in cash for the month (CGST Act s.49(4)). */
  totals: Totals;
  selfInvoices: { required: number; issued: number; overdue: number };
  /** Bills not under reverse charge whose lines fall under a notified category: check the condition. */
  possiblyMissed: PossiblyMissed[];
}

/** The month's reverse-charge register from its purchase documents (bills and vendor credits). */
export function reverseChargeRegister(docs: readonly GstReturnDocument[], selfInvoices: ReadonlyMap<string, SelfInvoiceRecord>, today: string): ReverseChargeRegister {
  const sum = { taxable: new D(0), igst: new D(0), cgst: new D(0), sgst: new D(0) } as Record<'taxable' | Head, Dec>;
  const rows: ReverseChargeRow[] = [];
  const possiblyMissed: PossiblyMissed[] = [];
  for (const d of docs) {
    if (d.status !== 'POSTED' || (d.kind !== 'BILL' && d.kind !== 'VENDOR_CREDIT')) continue;
    if (!d.reverseCharge) {
      if (d.kind !== 'BILL') continue;
      for (const l of d.lines) {
        const c = reverseChargeCategory(l.hsnCode);
        if (!c || (c.supplier === 'UNREGISTERED' && d.gstin)) continue;
        possiblyMissed.push({ id: d.id, number: d.number, issueDate: d.issueDate, contactName: d.contactName, hsnCode: l.hsnCode!, category: c, taxCharged: dec(l.igst).plus(dec(l.cgst)).plus(dec(l.sgst)).toFixed(2) });
        break;
      }
      continue;
    }
    const sign = d.kind === 'VENDOR_CREDIT' ? -1 : 1; // not money
    const t = { taxable: new D(0), igst: new D(0), cgst: new D(0), sgst: new D(0) } as Record<'taxable' | Head, Dec>;
    for (const l of d.lines) for (const k of ['taxable', ...HEADS] as const) t[k] = t[k].plus(dec(l[k]));
    for (const k of ['taxable', ...HEADS] as const) sum[k] = sum[k].plus(t[k].times(sign));
    const cats = new Map<string, string>();
    for (const l of d.lines) {
      const c = reverseChargeCategory(l.hsnCode);
      if (c) cats.set(c.key, c.title);
    }
    const required = selfInvoiceRequired(d);
    const si = selfInvoices.get(d.id) ?? null;
    const dueBy = required ? addDays(d.issueDate, SELF_INVOICE_DAYS) : null;
    rows.push({
      id: d.id,
      kind: d.kind,
      number: d.number,
      issueDate: d.issueDate,
      contactName: d.contactName,
      gstin: d.gstin,
      importOfServices: d.supplierState === FOREIGN_PLACE_OF_SUPPLY,
      categories: [...cats].map(([key, title]) => ({ key, title })),
      taxable: t.taxable.toFixed(2),
      igst: t.igst.toFixed(2),
      cgst: t.cgst.toFixed(2),
      sgst: t.sgst.toFixed(2),
      tax: t.igst.plus(t.cgst).plus(t.sgst).toFixed(2),
      selfInvoice: { required, number: si?.number ?? null, issuedOn: si?.issuedOn ?? null, dueBy, overdue: required && !si && !!dueBy && dueBy < today },
    });
  }
  const req = rows.filter((r) => r.selfInvoice.required);
  return {
    rows,
    totals: { taxable: sum.taxable.toFixed(2), igst: sum.igst.toFixed(2), cgst: sum.cgst.toFixed(2), sgst: sum.sgst.toFixed(2), tax: sum.igst.plus(sum.cgst).plus(sum.sgst).toFixed(2) },
    selfInvoices: { required: req.length, issued: req.filter((r) => r.selfInvoice.number).length, overdue: req.filter((r) => r.selfInvoice.overdue).length },
    possiblyMissed,
  };
}
