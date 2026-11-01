/**
 * India GST e-way bills (CGST Rule 138): when one is needed for an invoice, the JSON the
 * e-way bill portal's bulk upload takes, how long an e-way bill stays valid, and the
 * windows the portal allows for cancellation and for changing the vehicle.
 *
 * Talk2Tax does not talk to the e-way bill portal. The user uploads the JSON (or keys the
 * bill in) and records the e-way bill number and validity the portal gives back; see
 * docs/E_WAY_BILLS_INDIA.md.
 */
import { D, Dec } from '@talk2tax/accounting-engine';
import { indiaState } from './states';

/** Format version of the portal's bulk-generation JSON (as used by the offline tool). */
export const EWB_JSON_VERSION = '1.0.0621';
/** Rule 138(1): an e-way bill is needed when the consignment value exceeds Rs 50,000. */
export const EWB_DEFAULT_THRESHOLD = '50000';
/** Rule 138(10): one day of validity per 200 km (20 km for over-dimensional cargo), or part of it. */
export const EWB_KM_PER_DAY = { R: 200, O: 20 } as const;
/** The portal takes distances up to 4,000 km; for the same PIN code at both ends, at most 100 km. */
export const EWB_MAX_DISTANCE = 4000;
export const EWB_SAME_PIN_MAX_DISTANCE = 100;
/** GSTN advisory of 17 December 2024, from 1 January 2025: e-way bills only for documents dated within 180 days. */
export const EWB_DOCUMENT_AGE_LIMIT = { from: '2025-01-01', days: 180, source: 'GSTN advisory, 17 December 2024' } as const;
/** Hours after generation during which the portal lets an e-way bill be cancelled. */
export const EWB_CANCEL_HOURS = 24;
export const EWB_CANCEL_REASONS = { '1': 'Duplicate', '2': 'Order cancelled', '3': 'Data entry mistake', '4': 'Others' } as const;
export type EWayBillCancelReason = keyof typeof EWB_CANCEL_REASONS;
/** Reasons the portal takes for a Part B (vehicle) update. */
export const EWB_VEHICLE_REASONS = { '1': 'Breakdown', '2': 'Transhipment', '3': 'Others', '4': 'First time' } as const;
export type EWayBillVehicleReason = keyof typeof EWB_VEHICLE_REASONS;
export const EWB_TRANSPORT_MODES = { ROAD: '1', RAIL: '2', AIR: '3', SHIP: '4' } as const;
export type EWayBillTransportMode = keyof typeof EWB_TRANSPORT_MODES;

export interface EWayBillLine {
  description: string;
  hsnCode: string | null;
  quantity: string;
  netAmount: string;
  gstRate: string;
  cgst: string;
  sgst: string;
  igst: string;
  /** Nil-rated, exempt or non-GST: left out of the consignment value (Rule 138, explanation). */
  exempt: boolean;
}

export interface EWayBillTransport {
  /** null: Part A only; the transporter or the user adds Part B (the vehicle) later. */
  mode: EWayBillTransportMode | null;
  distanceKm: number;
  vehicleNo?: string | null;
  /** R regular, O over-dimensional cargo. */
  vehicleType: 'R' | 'O';
  transporterId?: string | null;
  transporterName?: string | null;
  /** Lorry receipt, railway receipt, airway bill or bill of lading. */
  transDocNo?: string | null;
  transDocDate?: string | null;
}

export interface EWayBillParty {
  /** null for an unregistered buyer (URP). */
  gstin: string | null;
  legalName: string;
  address1: string;
  address2?: string | null;
  place: string;
  pincode: string;
  /** State of the address (where goods are dispatched from or delivered to). */
  stateCode: string;
}

export interface EWayBillInput {
  number: string;
  issueDate: string;
  /** The date the e-way bill is to be generated (today), for the 180-day check. */
  generationDate: string;
  placeOfSupply: string;
  seller: EWayBillParty & { gstin: string };
  buyer: EWayBillParty;
  lines: EWayBillLine[];
  /** TCS and other charges on the invoice. */
  otherCharges: string;
  total: string;
  goodsUnit: string;
  transport: EWayBillTransport;
}

export interface EWayBillIssue {
  field: string;
  message: string;
}

const money2 = (d: Dec) => Number(d.toFixed(2));
const fmtDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const GSTIN = /^[0-9]{2}[0-9A-Z]{13}$/;
const DOC_NO = /^[A-Za-z0-9/-]{1,16}$/;
const PIN = /^[1-9][0-9]{5}$/;
const HSN = /^([0-9]{4}|[0-9]{6}|[0-9]{8})$/;
const isGoods = (hsn: string | null) => !!hsn && !hsn.startsWith('99');
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Upper case, without spaces or dashes: MH 12 AB 1234 → MH12AB1234. */
export function normaliseVehicleNo(s: string): string {
  return s.toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Vehicle numbers the portal accepts: state registrations (MH12AB1234, DL1C1234,
 * KA011234), Bharat series (22BH1234AA), and temporary or defence numbers (TM…, DF…, TR…).
 */
export function vehicleNoIssue(raw: string): string | null {
  const v = normaliseVehicleNo(raw);
  if (/^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$/.test(v)) return null;
  if (/^[0-9]{2}BH[0-9]{4}[A-Z]{1,2}$/.test(v)) return null;
  if (/^(TM|TR|DF|BP|NP)[A-Z0-9]{4,13}$/.test(v)) return null;
  return 'Not a vehicle number the portal accepts (for example MH12AB1234)';
}

/** Value of goods for the threshold: taxable value plus GST of goods lines, leaving out exempt goods and services. */
export function consignmentValue(lines: Pick<EWayBillLine, 'hsnCode' | 'netAmount' | 'cgst' | 'sgst' | 'igst' | 'exempt'>[]): string {
  return lines
    .filter((l) => isGoods(l.hsnCode) && !l.exempt)
    .reduce((s, l) => s.plus(l.netAmount).plus(l.cgst).plus(l.sgst).plus(l.igst), new D(0))
    .toFixed(2);
}

/** Whether the movement needs an e-way bill: value over the threshold (a state's own for movement within it, when set). */
export function ewayBillRequired(value: string, threshold: string, intraState: boolean, intraStateThreshold?: string | null): boolean {
  const limit = intraState && intraStateThreshold ? intraStateThreshold : threshold;
  return new D(value).gt(limit);
}

/** Days of validity for a distance: one per 200 km, or 20 km for over-dimensional cargo, or part of it. */
export function validityDays(distanceKm: number, vehicleType: 'R' | 'O' = 'R'): number {
  return Math.max(1, Math.ceil(distanceKm / EWB_KM_PER_DAY[vehicleType]));
}

/**
 * When an e-way bill with Part B first entered at `partBAt` expires: each day ends at
 * midnight, the first at the midnight after the day of Part B. Returned as an ISO
 * timestamp (23:59:59 IST of the last day).
 */
export function expectedValidUntil(partBAt: string, distanceKm: number, vehicleType: 'R' | 'O' = 'R'): string {
  const istDay = new Date(Date.parse(partBAt) + 330 * 60_000).toISOString().slice(0, 10);
  const last = addDays(istDay, validityDays(distanceKm, vehicleType));
  return new Date(Date.parse(`${last}T23:59:59+05:30`)).toISOString();
}

/** Last date an e-way bill can be generated for a document dated `issueDate`. */
export function generationDeadline(issueDate: string): string {
  return addDays(issueDate, EWB_DOCUMENT_AGE_LIMIT.days);
}

/** Whether an e-way bill generated at `generatedAt` can still be cancelled at `at`. */
export function ewayBillCancellable(generatedAt: string, at: string): boolean {
  const ms = Date.parse(at) - Date.parse(generatedAt);
  return ms >= 0 && ms <= EWB_CANCEL_HOURS * 3_600_000;
}

/** Checks on Part B: what each mode of transport needs, distance and the vehicle. */
export function transportIssues(t: EWayBillTransport, ctx: { issueDate: string; samePin: boolean }): EWayBillIssue[] {
  const issues: EWayBillIssue[] = [];
  if (!Number.isInteger(t.distanceKm) || t.distanceKm < 1 || t.distanceKm > EWB_MAX_DISTANCE) issues.push({ field: 'transport.distanceKm', message: `The distance must be a whole number of km from 1 to ${EWB_MAX_DISTANCE}` });
  else if (ctx.samePin && t.distanceKm > EWB_SAME_PIN_MAX_DISTANCE) issues.push({ field: 'transport.distanceKm', message: `With the same PIN code at both ends the distance can be at most ${EWB_SAME_PIN_MAX_DISTANCE} km` });
  if (t.transporterId && !GSTIN.test(t.transporterId)) issues.push({ field: 'transport.transporterId', message: 'The transporter ID is the transporter’s GSTIN or 15-character TRANSIN' });
  if ((t.transporterName ?? '').length > 100) issues.push({ field: 'transport.transporterName', message: 'The transporter name is longer than 100 characters' });
  if (!t.mode) {
    if (t.vehicleNo || t.transDocNo) issues.push({ field: 'transport.mode', message: 'Choose the mode of transport for the vehicle or transport document' });
    return issues;
  }
  if ((t.mode === 'ROAD' || t.mode === 'SHIP') && !t.vehicleNo) issues.push({ field: 'transport.vehicleNo', message: t.mode === 'ROAD' ? 'A vehicle number is needed for transport by road' : 'A vessel number is needed for transport by ship' });
  if (t.mode === 'ROAD' && t.vehicleNo) {
    const v = vehicleNoIssue(t.vehicleNo);
    if (v) issues.push({ field: 'transport.vehicleNo', message: v });
  }
  if (t.mode !== 'ROAD' && !t.transDocNo) issues.push({ field: 'transport.transDocNo', message: 'A transport document number (railway receipt, airway bill or bill of lading) is needed' });
  if (t.transDocNo && !/^[A-Za-z0-9/ -]{1,15}$/.test(t.transDocNo)) issues.push({ field: 'transport.transDocNo', message: 'The transport document number is up to 15 letters, digits, /, - or spaces' });
  if (t.transDocNo && !t.transDocDate) issues.push({ field: 'transport.transDocDate', message: 'The transport document needs its date' });
  if (t.transDocDate && t.transDocDate < ctx.issueDate) issues.push({ field: 'transport.transDocDate', message: 'The transport document cannot be dated before the invoice' });
  if (t.mode !== 'ROAD' && t.vehicleType === 'O') issues.push({ field: 'transport.vehicleType', message: 'Over-dimensional cargo applies to road transport only' });
  return issues;
}

function partyIssues(p: EWayBillParty, who: 'Dispatch' | 'Delivery', issues: EWayBillIssue[]) {
  const f = (k: string) => `${who === 'Dispatch' ? 'seller' : 'buyer'}.${k}`;
  if (p.gstin !== null && !GSTIN.test(p.gstin)) issues.push({ field: f('gstin'), message: `${who === 'Dispatch' ? 'Seller' : 'Buyer'} GSTIN is malformed` });
  if (p.legalName.trim().length < 1 || p.legalName.length > 100) issues.push({ field: f('legalName'), message: `${who === 'Dispatch' ? 'Seller' : 'Buyer'} name must be 1 to 100 characters` });
  if (!p.address1.trim()) issues.push({ field: f('address1'), message: `${who} address is missing` });
  else if (p.address1.length > 120) issues.push({ field: f('address1'), message: `${who} address line 1 is longer than 120 characters` });
  if ((p.address2 ?? '').length > 120) issues.push({ field: f('address2'), message: `${who} address line 2 is longer than 120 characters` });
  if (!p.place.trim()) issues.push({ field: f('place'), message: `${who} city is missing` });
  else if (p.place.length > 50) issues.push({ field: f('place'), message: `${who} city is longer than 50 characters` });
  if (!PIN.test(p.pincode)) issues.push({ field: f('pincode'), message: p.pincode ? `${who} PIN code must be six digits` : `${who} PIN code is missing` });
  if (!indiaState(p.stateCode)) issues.push({ field: f('stateCode'), message: `${who} state is missing` });
}

/** One bill for the portal's bulk JSON (`billLists`), or what is missing. Outward supply of goods on a tax invoice. */
export function buildEWayBill(input: EWayBillInput): { payload: Record<string, unknown> | null; issues: EWayBillIssue[] } {
  const issues: EWayBillIssue[] = [];
  if (!DOC_NO.test(input.number)) issues.push({ field: 'number', message: 'The document number must be up to 16 letters, digits, / or -' });
  if (input.placeOfSupply === '96') issues.push({ field: 'placeOfSupply', message: 'Exports are not supported yet' });
  else if (!indiaState(input.placeOfSupply)) issues.push({ field: 'placeOfSupply', message: 'The place of supply is not a state code' });
  if (input.generationDate >= EWB_DOCUMENT_AGE_LIMIT.from && input.generationDate > generationDeadline(input.issueDate)) issues.push({ field: 'issueDate', message: `The portal takes documents dated within ${EWB_DOCUMENT_AGE_LIMIT.days} days only` });
  if (input.generationDate < input.issueDate) issues.push({ field: 'issueDate', message: 'The invoice is dated in the future' });
  partyIssues(input.seller, 'Dispatch', issues);
  partyIssues(input.buyer, 'Delivery', issues);
  if (input.buyer.gstin && input.buyer.gstin === input.seller.gstin) issues.push({ field: 'buyer.gstin', message: 'The buyer GSTIN is the same as the seller GSTIN' });
  if (!input.lines.some((l) => isGoods(l.hsnCode))) issues.push({ field: 'lines', message: 'There are no goods on this invoice (only services)' });
  if (input.lines.length > 250) issues.push({ field: 'lines', message: 'The portal takes at most 250 items' });
  if (!/^[A-Z]{3,8}$/.test(input.goodsUnit)) issues.push({ field: 'goodsUnit', message: 'The unit for goods must be a UQC code such as NOS' });
  issues.push(...transportIssues(input.transport, { issueDate: input.issueDate, samePin: input.seller.pincode === input.buyer.pincode }));

  let taxable = new D(0);
  let cgst = new D(0);
  let sgst = new D(0);
  let igst = new D(0);
  const items = input.lines.map((l, i) => {
    const n = i + 1;
    if (!l.hsnCode || !HSN.test(l.hsnCode)) issues.push({ field: `lines.${n}.hsnCode`, message: `Line ${n}: an HSN or SAC code of 4, 6 or 8 digits is needed` });
    const rate = new D(l.gstRate);
    taxable = taxable.plus(l.netAmount);
    cgst = cgst.plus(l.cgst);
    sgst = sgst.plus(l.sgst);
    igst = igst.plus(l.igst);
    const intra = !new D(l.cgst).isZero() || !new D(l.sgst).isZero();
    const half = Number(rate.dividedBy(2).toFixed());
    return {
      itemNo: n,
      productName: (l.description || '').trim().slice(0, 100),
      productDesc: (l.description || '').trim().slice(0, 100),
      hsnCode: Number(l.hsnCode ?? 0),
      quantity: Number(new D(l.quantity).toDecimalPlaces(3).toFixed()),
      qtyUnit: isGoods(l.hsnCode) ? input.goodsUnit : 'OTH',
      taxableAmount: money2(new D(l.netAmount)),
      cgstRate: intra ? half : 0,
      sgstRate: intra ? half : 0,
      igstRate: !new D(l.igst).isZero() ? Number(rate.toFixed()) : 0,
      cessRate: 0,
      cessNonAdvol: 0,
    };
  });
  const other = new D(input.otherCharges);
  const computed = taxable.plus(cgst).plus(sgst).plus(igst).plus(other);
  if (!computed.minus(input.total).abs().lte('0.01')) issues.push({ field: 'total', message: `Lines and other charges add up to ${computed.toFixed(2)}, not the total ${new D(input.total).toFixed(2)}` });
  if (issues.length) return { payload: null, issues };

  const t = input.transport;
  const main = input.lines.filter((l) => isGoods(l.hsnCode)).sort((a, b) => new D(b.netAmount).comparedTo(a.netAmount))[0];
  const payload = {
    userGstin: input.seller.gstin,
    supplyType: 'O',
    subSupplyType: 1,
    subSupplyDesc: '',
    docType: 'INV',
    docNo: input.number,
    docDate: fmtDate(input.issueDate),
    transType: 1,
    fromGstin: input.seller.gstin,
    fromTrdName: input.seller.legalName.trim(),
    fromAddr1: input.seller.address1.trim(),
    fromAddr2: (input.seller.address2 ?? '').trim(),
    fromPlace: input.seller.place.trim(),
    fromPincode: Number(input.seller.pincode),
    fromStateCode: Number(input.seller.gstin.slice(0, 2)),
    actualFromStateCode: Number(input.seller.stateCode),
    toGstin: input.buyer.gstin ?? 'URP',
    toTrdName: input.buyer.legalName.trim(),
    toAddr1: input.buyer.address1.trim(),
    toAddr2: (input.buyer.address2 ?? '').trim(),
    toPlace: input.buyer.place.trim(),
    toPincode: Number(input.buyer.pincode),
    toStateCode: Number(input.placeOfSupply),
    actualToStateCode: Number(input.buyer.stateCode),
    totalValue: money2(taxable),
    cgstValue: money2(cgst),
    sgstValue: money2(sgst),
    igstValue: money2(igst),
    cessValue: 0,
    TotNonAdvolVal: 0,
    OthValue: money2(other),
    totInvValue: money2(new D(input.total)),
    transMode: t.mode ? EWB_TRANSPORT_MODES[t.mode] : '',
    transDistance: String(t.distanceKm),
    transporterId: t.transporterId ?? '',
    transporterName: (t.transporterName ?? '').trim(),
    transDocNo: t.transDocNo ?? '',
    transDocDate: t.transDocDate ? fmtDate(t.transDocDate) : '',
    vehicleNo: t.vehicleNo ? normaliseVehicleNo(t.vehicleNo) : '',
    vehicleType: t.mode ? t.vehicleType : '',
    mainHsnCode: Number(main?.hsnCode ?? 0),
    itemList: items,
  };
  return { payload, issues: [] };
}

/** The portal's bulk-upload file around one or more bills. */
export function ewayBillFile(bills: Record<string, unknown>[]) {
  return { version: EWB_JSON_VERSION, billLists: bills };
}

/** E-way bill numbers are 12 digits. */
export const EWB_NUMBER = /^[0-9]{12}$/;
