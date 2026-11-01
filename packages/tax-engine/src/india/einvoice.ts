/**
 * India GST e-invoicing: the INV-01 JSON (schema version 1.1) for the Invoice
 * Registration Portal (IRP), the checks the IRP applies that we can apply first, the
 * 30-day reporting limit, and reading what the IRP sends back.
 *
 * Talk2Tax does not talk to the IRP. The user uploads the JSON (portal or offline
 * tool) and imports the IRP's response; see docs/E_INVOICING_INDIA.md.
 */
import { D, Dec } from '@talk2tax/accounting-engine';
import { indiaState } from './states';

export const EINVOICE_SCHEMA_VERSION = '1.1';
/** GST rates the IRP accepts on an item (GstRt), including 40% from 22 September 2025. */
export const EINVOICE_GST_RATES: readonly string[] = ['0', '0.1', '0.25', '1', '1.5', '3', '5', '6', '7.5', '12', '18', '28', '40'];
/** Reasons the IRP accepts when an IRN is cancelled (CnlRsn). */
export const EINVOICE_CANCEL_REASONS = { '1': 'Duplicate', '2': 'Data entry mistake', '3': 'Order cancelled', '4': 'Others' } as const;
export type EInvoiceCancelReason = keyof typeof EINVOICE_CANCEL_REASONS;
/** Hours after the acknowledgement during which the IRP lets an IRN be cancelled. */
export const EINVOICE_CANCEL_HOURS = 24;
/**
 * GSTN advisory of 5 November 2024: from 1 April 2025, taxpayers with aggregate annual
 * turnover (AATO) of Rs 10 crore or more cannot report an invoice, credit note or debit
 * note more than 30 days old ("an invoice dated 1 April 2025 cannot be reported after
 * 30 April 2025").
 */
export const EINVOICE_TIME_LIMIT = { from: '2025-04-01', days: 30, source: 'GSTN advisory, 5 November 2024 (AATO of Rs 10 crore and above)' } as const;

export interface EInvoiceParty {
  gstin: string;
  legalName: string;
  tradeName?: string | null;
  address1: string;
  address2?: string | null;
  location: string;
  pincode: string;
}

export interface EInvoiceLineInput {
  description: string;
  hsnCode: string | null;
  quantity: string;
  unitPrice: string;
  netAmount: string;
  gstRate: string;
  cgst: string;
  sgst: string;
  igst: string;
}

export interface EInvoiceInput {
  kind: 'INVOICE' | 'CREDIT_NOTE';
  number: string;
  issueDate: string;
  currency: string;
  placeOfSupply: string;
  seller: EInvoiceParty;
  buyer: EInvoiceParty;
  lines: EInvoiceLineInput[];
  /** TCS collected on the invoice: reported as other charges. */
  otherCharges: string;
  total: string;
  /** UQC for goods lines (for example NOS); services carry none. */
  goodsUnit: string;
}

export interface EInvoiceIssue {
  field: string;
  message: string;
}

const money2 = (d: Dec) => Number(d.toFixed(2));
const fmtDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const GSTIN = /^[0-9]{2}[0-9A-Z]{13}$/;
/** IRP document number: up to 16 characters, letters, digits, / and -, not starting with 0, / or -. */
const DOC_NO = /^[A-Za-z1-9][A-Za-z0-9/-]{0,15}$/;
const PIN = /^[1-9][0-9]{5}$/;
const HSN = /^([0-9]{4}|[0-9]{6}|[0-9]{8})$/;

function checkParty(p: EInvoiceParty, who: 'Seller' | 'Buyer', issues: EInvoiceIssue[]) {
  const f = (k: string) => `${who.toLowerCase()}.${k}`;
  if (!GSTIN.test(p.gstin)) issues.push({ field: f('gstin'), message: `${who} GSTIN is missing or malformed` });
  if (p.legalName.trim().length < 3 || p.legalName.length > 100) issues.push({ field: f('legalName'), message: `${who} legal name must be 3 to 100 characters` });
  if (!p.address1.trim() || p.address1.length > 100) issues.push({ field: f('address1'), message: `${who} address line 1 is needed (up to 100 characters)` });
  if ((p.address2 ?? '').length > 100) issues.push({ field: f('address2'), message: `${who} address line 2 is longer than 100 characters` });
  if (p.location.trim().length < 3 || p.location.length > 50) issues.push({ field: f('location'), message: `${who} city or location must be 3 to 50 characters` });
  if (!PIN.test(p.pincode)) issues.push({ field: f('pincode'), message: `${who} PIN code must be six digits` });
}

/** The INV-01 payload for a posted B2B invoice or credit note, or the reasons it cannot be built. */
export function buildEInvoice(input: EInvoiceInput): { payload: Record<string, unknown> | null; issues: EInvoiceIssue[] } {
  const issues: EInvoiceIssue[] = [];
  if (input.currency !== 'INR') issues.push({ field: 'currency', message: 'Only invoices in INR are supported' });
  if (!DOC_NO.test(input.number)) issues.push({ field: 'number', message: 'The document number must be up to 16 letters, digits, / or -, not starting with 0, / or -' });
  if (input.placeOfSupply === '96') issues.push({ field: 'placeOfSupply', message: 'Exports are not supported yet' });
  else if (!indiaState(input.placeOfSupply)) issues.push({ field: 'placeOfSupply', message: 'The place of supply is not a state code' });
  checkParty(input.seller, 'Seller', issues);
  checkParty(input.buyer, 'Buyer', issues);
  if (input.seller.gstin === input.buyer.gstin) issues.push({ field: 'buyer.gstin', message: 'The buyer GSTIN is the same as the seller GSTIN' });
  if (!input.lines.length) issues.push({ field: 'lines', message: 'There are no lines' });
  if (input.lines.length > 1000) issues.push({ field: 'lines', message: 'The IRP takes at most 1,000 items' });
  if (!/^[A-Z]{3,8}$/.test(input.goodsUnit)) issues.push({ field: 'goodsUnit', message: 'The unit for goods must be a UQC code such as NOS' });

  let ass = new D(0);
  let cgst = new D(0);
  let sgst = new D(0);
  let igst = new D(0);
  const items = input.lines.map((l, i) => {
    const n = i + 1;
    if (!l.hsnCode || !HSN.test(l.hsnCode)) issues.push({ field: `lines.${n}.hsnCode`, message: `Line ${n}: an HSN or SAC code of 4, 6 or 8 digits is needed` });
    const rate = new D(l.gstRate).toFixed();
    if (!EINVOICE_GST_RATES.includes(rate)) issues.push({ field: `lines.${n}.gstRate`, message: `Line ${n}: ${rate}% is not a GST rate the IRP accepts` });
    const qty = new D(l.quantity);
    if (qty.lte(0)) issues.push({ field: `lines.${n}.quantity`, message: `Line ${n}: the quantity must be more than zero` });
    const desc = (l.description || '').trim();
    const isService = (l.hsnCode ?? '').startsWith('99');
    const net = new D(l.netAmount);
    const tax = new D(l.cgst).plus(l.sgst).plus(l.igst);
    ass = ass.plus(net);
    cgst = cgst.plus(l.cgst);
    sgst = sgst.plus(l.sgst);
    igst = igst.plus(l.igst);
    // The IRP checks TotAmt against Qty × UnitPrice, so the unit price is the line amount over the quantity.
    const unit = qty.gt(0) ? net.dividedBy(qty).toDecimalPlaces(3) : new D(0);
    return {
      SlNo: String(n),
      PrdDesc: desc.length >= 3 ? desc.slice(0, 300) : (l.hsnCode ?? 'Item'),
      IsServc: isService ? 'Y' : 'N',
      HsnCd: l.hsnCode ?? '',
      Qty: Number(qty.toDecimalPlaces(3).toFixed()),
      ...(isService ? {} : { Unit: input.goodsUnit }),
      UnitPrice: Number(unit.toFixed()),
      TotAmt: money2(net),
      Discount: 0,
      AssAmt: money2(net),
      GstRt: Number(rate),
      IgstAmt: money2(new D(l.igst)),
      CgstAmt: money2(new D(l.cgst)),
      SgstAmt: money2(new D(l.sgst)),
      CesRt: 0,
      CesAmt: 0,
      CesNonAdvlAmt: 0,
      OthChrg: 0,
      TotItemVal: money2(net.plus(tax)),
    };
  });
  const other = new D(input.otherCharges);
  const computed = ass.plus(cgst).plus(sgst).plus(igst).plus(other);
  if (!computed.minus(input.total).abs().lte('0.01')) issues.push({ field: 'total', message: `Lines and other charges add up to ${computed.toFixed(2)}, not the total ${new D(input.total).toFixed(2)}` });
  if (issues.length) return { payload: null, issues };

  const party = (p: EInvoiceParty) => ({
    Gstin: p.gstin,
    LglNm: p.legalName.trim(),
    TrdNm: (p.tradeName || p.legalName).trim().slice(0, 100),
    Addr1: p.address1.trim(),
    ...(p.address2?.trim() ? { Addr2: p.address2.trim() } : {}),
    Loc: p.location.trim(),
    Pin: Number(p.pincode),
    Stcd: p.gstin.slice(0, 2),
  });
  const payload = {
    Version: EINVOICE_SCHEMA_VERSION,
    TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
    DocDtls: { Typ: input.kind === 'INVOICE' ? 'INV' : 'CRN', No: input.number, Dt: fmtDate(input.issueDate) },
    SellerDtls: party(input.seller),
    BuyerDtls: { ...party(input.buyer), Pos: input.placeOfSupply },
    ItemList: items,
    ValDtls: {
      AssVal: money2(ass),
      CgstVal: money2(cgst),
      SgstVal: money2(sgst),
      IgstVal: money2(igst),
      CesVal: 0,
      StCesVal: 0,
      Discount: 0,
      OthChrg: money2(other),
      RndOffAmt: 0,
      TotInvVal: money2(new D(input.total)),
    },
  };
  return { payload, issues: [] };
}

/** Last day a document can be reported to the IRP under the 30-day limit, or null when the limit does not apply. */
export function reportingDeadline(issueDate: string, aatoTenCroreOrMore: boolean): string | null {
  if (!aatoTenCroreOrMore) return null;
  const deadline = new Date(Date.parse(`${issueDate}T00:00:00Z`) + (EINVOICE_TIME_LIMIT.days - 1) * 86_400_000).toISOString().slice(0, 10);
  // The limit applies to reporting on or after 1 April 2025.
  return deadline < EINVOICE_TIME_LIMIT.from ? null : deadline;
}

/** Whether an IRN acknowledged at `ackDate` can still be cancelled at `at`. */
export function cancellable(ackDate: string, at: string): boolean {
  const ms = Date.parse(at) - Date.parse(ackDate);
  return ms >= 0 && ms <= EINVOICE_CANCEL_HOURS * 3_600_000;
}

// ---------------------------------------------------------------- IRP response

export interface IrpResponse {
  irn: string;
  ackNo: string;
  /** ISO timestamp with the India offset. */
  ackDate: string;
  signedQrCode: string;
  signedInvoice: string | null;
}

/** What the signed QR code says (its JWT payload's `data`). */
export interface QrData {
  SellerGstin: string;
  BuyerGstin: string;
  DocNo: string;
  DocTyp: string;
  DocDt: string;
  TotInvVal: number;
  ItemCnt?: number;
  MainHsnCode?: string;
  Irn: string;
  IrnDt: string;
}

function base64UrlJson(part: string): unknown {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const text = typeof Buffer !== 'undefined' ? Buffer.from(b64, 'base64').toString('utf8') : decodeURIComponent(escape(atob(b64)));
  return JSON.parse(text);
}

/** The payload of a JWT, without checking its signature. Throws when it is not a JWT. */
export function jwtPayload(token: string): Record<string, unknown> {
  const parts = token.trim().split('.');
  if (parts.length !== 3) throw new Error('Not a signed token (expected three dot-separated parts)');
  const p = base64UrlJson(parts[1]);
  if (!p || typeof p !== 'object') throw new Error('The token has no payload');
  return p as Record<string, unknown>;
}

/** The `data` claim of a signed QR code or signed invoice: JSON, sometimes itself a JSON string. */
export function signedData<T>(token: string): T {
  const p = jwtPayload(token);
  const data = p.data;
  if (data === undefined) throw new Error('The token has no data claim');
  return (typeof data === 'string' ? JSON.parse(data) : data) as T;
}

/** IRP acknowledgement dates come as "2026-10-12 14:03:00" in India time. */
export function irpDateToIso(s: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s.trim());
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}+05:30`;
}

/**
 * Read the IRP's response for one document. Accepts the response object (Irn, AckNo,
 * AckDt, SignedInvoice, SignedQRCode; any letter case) or that object under `data`
 * or `Data`.
 */
export function parseIrpResponse(raw: unknown): { response: IrpResponse | null; issues: string[] } {
  const issues: string[] = [];
  let obj = raw as Record<string, unknown> | null;
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const inner = obj.data ?? obj.Data;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) obj = inner as Record<string, unknown>;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { response: null, issues: ['Paste the IRP response for one document: a JSON object with Irn, AckNo, AckDt and SignedQRCode'] };
  const get = (k: string) => {
    const key = Object.keys(obj!).find((x) => x.toLowerCase() === k.toLowerCase());
    const v = key ? obj![key] : undefined;
    return v === undefined || v === null ? '' : String(v).trim();
  };
  const irn = get('Irn');
  const ackNo = get('AckNo');
  const ackDt = get('AckDt');
  const qr = get('SignedQRCode');
  const inv = get('SignedInvoice');
  if (!/^[0-9a-f]{64}$/i.test(irn)) issues.push('Irn must be the 64-character IRN');
  if (!/^\d{10,20}$/.test(ackNo)) issues.push('AckNo must be the acknowledgement number');
  const ackIso = irpDateToIso(ackDt);
  if (!ackIso) issues.push('AckDt must be the acknowledgement date and time, like 2026-10-12 14:03:00');
  if (!qr) issues.push('SignedQRCode is missing');
  if (issues.length) return { response: null, issues };
  return { response: { irn: irn.toLowerCase(), ackNo, ackDate: ackIso!, signedQrCode: qr, signedInvoice: inv || null }, issues: [] };
}

/**
 * Check that what the IRP signed is this document: same IRN, seller, buyer, number,
 * type, date and total. Signature verification is separate (it needs the IRP's key).
 */
export function matchIrpResponse(
  response: IrpResponse,
  doc: { sellerGstin: string; buyerGstin: string; number: string; kind: 'INVOICE' | 'CREDIT_NOTE'; issueDate: string; total: string },
): string[] {
  const issues: string[] = [];
  let qr: QrData;
  try {
    qr = signedData<QrData>(response.signedQrCode);
  } catch (e) {
    return [`The signed QR code could not be read: ${(e as Error).message}`];
  }
  const same = (a: unknown, b: string) => String(a ?? '').toUpperCase() === b.toUpperCase();
  if (!same(qr.Irn, response.irn)) issues.push('The QR code is for a different IRN');
  if (!same(qr.SellerGstin, doc.sellerGstin)) issues.push(`The QR code is for seller ${qr.SellerGstin}, not ${doc.sellerGstin}`);
  if (!same(qr.BuyerGstin, doc.buyerGstin)) issues.push(`The QR code is for buyer ${qr.BuyerGstin}, not ${doc.buyerGstin}`);
  // Document numbers are case-insensitive at the IRP.
  if (!same(qr.DocNo, doc.number)) issues.push(`The QR code is for document ${qr.DocNo}, not ${doc.number}`);
  if (!same(qr.DocTyp, doc.kind === 'INVOICE' ? 'INV' : 'CRN')) issues.push(`The QR code is for a ${qr.DocTyp}, not this ${doc.kind === 'INVOICE' ? 'invoice' : 'credit note'}`);
  if (String(qr.DocDt ?? '') !== fmtDate(doc.issueDate)) issues.push(`The QR code is dated ${qr.DocDt}, not ${fmtDate(doc.issueDate)}`);
  if (qr.TotInvVal === undefined || !new D(String(qr.TotInvVal)).minus(doc.total).abs().lte('0.01')) issues.push(`The QR code total ${qr.TotInvVal} does not match ${new D(doc.total).toFixed(2)}`);
  if (response.signedInvoice) {
    try {
      const inv = signedData<{ DocDtls?: { No?: string }; ValDtls?: { TotInvVal?: number } }>(response.signedInvoice);
      if (!same(inv.DocDtls?.No, doc.number)) issues.push('The signed invoice is for a different document number');
    } catch (e) {
      issues.push(`The signed invoice could not be read: ${(e as Error).message}`);
    }
  }
  return issues;
}
