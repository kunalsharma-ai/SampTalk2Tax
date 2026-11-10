import { csvField, neutraliseFormula } from './report-export';
import { D, dec, minorUnits } from './money';
import { normaliseAccountNumber } from './payment-batches';

/**
 * International payment preparation (AP-023).
 *
 * A vendor abroad is paid in their currency by an outward remittance the bank sends over SWIFT. The
 * app prepares it: the vendor's international bank details (SWIFT/BIC, IBAN or account number,
 * bank country, and a routing code where the country needs one), the bills it settles, the purpose
 * of the payment, who bears the charges, and, for an Indian organisation, which part of Form 15CA
 * applies and whether a chartered accountant's Form 15CB is needed. A second person approves it,
 * the remittance instruction goes to the bank, and when the bank confirms, the payment is recorded
 * at the rate the bank applied. Money is moved by the bank, never by the app.
 *
 * The purpose codes listed are a short list of common ones and the Form 15CA rules follow Rule 37BB
 * as commonly applied; neither has been reviewed by a banker or a chartered accountant. The bank's
 * own remittance form is authoritative.
 */

export const remittanceRef = (n: number) => `IP-${String(n).padStart(4, '0')}`;

export const SWIFT_PATTERN = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

/** IBAN lengths by country for the countries that use IBANs and that Indian businesses most often pay. */
export const IBAN_LENGTHS: Record<string, number> = {
  AE: 23, AT: 20, BE: 16, BH: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27, GB: 22, GR: 27,
  HR: 21, HU: 28, IE: 22, IL: 23, IT: 27, KW: 30, LT: 20, LU: 20, LV: 21, MT: 31, MU: 30, NL: 18, NO: 15, PL: 28, PT: 25,
  QA: 29, RO: 24, SA: 24, SE: 24, SI: 19, SK: 24, TR: 26,
};

/** Countries without IBANs that need a local routing code, with its name and shape. */
export const ROUTING_CODES: Record<string, { name: string; pattern: RegExp; example: string }> = {
  US: { name: 'ABA routing number', pattern: /^\d{9}$/, example: '021000021' },
  CA: { name: 'transit and institution number', pattern: /^\d{8,9}$/, example: '000412345' },
  AU: { name: 'BSB code', pattern: /^\d{6}$/, example: '062000' },
  NZ: { name: 'bank and branch code', pattern: /^\d{6}$/, example: '010001' },
};

/** True when the IBAN's check digits are right (ISO 13616 mod 97). */
export function ibanChecksumOk(iban: string): boolean {
  const s = normaliseAccountNumber(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

/** ABA routing number check digit (3-7-1 weights). */
export function abaChecksumOk(n: string): boolean {
  if (!/^\d{9}$/.test(n)) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  return n.split('').reduce((s, d, i) => s + Number(d) * w[i]!, 0) % 10 === 0;
}

export interface InternationalBankInput {
  accountName: string;
  accountNumber: string;
  swiftBic: string;
  bankCountry: string;
  bankName?: string | null;
  bankAddress?: string | null;
  routingCode?: string | null;
  intermediarySwift?: string | null;
}

/** What is wrong with international bank details as entered; empty when they can be saved. */
export function internationalBankIssues(b: InternationalBankInput, homeCountry = 'IN'): string[] {
  const out: string[] = [];
  const country = b.bankCountry.trim().toUpperCase();
  const swift = b.swiftBic.replace(/\s/g, '').toUpperCase();
  const acct = normaliseAccountNumber(b.accountNumber);
  if (!b.accountName.trim()) out.push("Enter the account holder's name as the bank has it");
  if (!/^[A-Z]{2}$/.test(country)) out.push('Choose the country of the bank');
  else if (country === homeCountry) out.push('This bank is in your own country; use the domestic bank details instead');
  if (!SWIFT_PATTERN.test(swift)) out.push('A SWIFT/BIC code is 8 or 11 characters: four letters for the bank, two for the country, then two (and optionally three) letters or digits');
  else if (/^[A-Z]{2}$/.test(country) && swift.slice(4, 6) !== country) out.push(`The SWIFT/BIC code is for a bank in ${swift.slice(4, 6)}, not ${country}`);
  if (b.intermediarySwift?.trim() && !SWIFT_PATTERN.test(b.intermediarySwift.replace(/\s/g, '').toUpperCase())) out.push('The intermediary bank SWIFT/BIC code is not valid');
  const ibanLen = IBAN_LENGTHS[country];
  if (ibanLen) {
    if (!acct.startsWith(country) || acct.length !== ibanLen) out.push(`Banks in ${country} are paid to an IBAN: ${ibanLen} characters starting ${country}`);
    else if (!ibanChecksumOk(acct)) out.push('The IBAN check digits are wrong; check it against the vendor\'s invoice or bank letter');
  } else if (!/^[0-9A-Z]{4,34}$/.test(acct)) out.push('An account number is 4 to 34 letters or digits');
  const routing = ROUTING_CODES[country];
  const r = (b.routingCode ?? '').replace(/[\s-]/g, '');
  if (routing) {
    if (!routing.pattern.test(r)) out.push(`Banks in ${country} also need the ${routing.name} (for example ${routing.example})`);
    else if (country === 'US' && !abaChecksumOk(r)) out.push('The ABA routing number check digit is wrong');
  }
  return out;
}

export const CHARGES = {
  OUR: 'We pay all charges (OUR): the vendor receives the full amount',
  SHA: 'Shared (SHA): we pay our bank, the vendor pays theirs',
  BEN: 'Vendor pays all charges (BEN)',
} as const;
export type Charges = keyof typeof CHARGES;

export interface PurposeCode {
  code: string;
  label: string;
  /** On the list of payments that need no Form 15CA or 15CB (Rule 37BB(3)). */
  noForm15: boolean;
}

/** Common RBI purpose codes for payments to vendors abroad. Other codes can be typed in. */
export const PURPOSE_CODES: PurposeCode[] = [
  { code: 'S0101', label: 'Advance payment against imports', noForm15: true },
  { code: 'S0102', label: 'Payment towards imports (settlement of invoice)', noForm15: true },
  { code: 'S0802', label: 'Software consultancy and implementation', noForm15: false },
  { code: 'S1005', label: 'Accounting, auditing and bookkeeping services', noForm15: false },
  { code: 'S1006', label: 'Business and management consultancy and public relations services', noForm15: false },
  { code: 'S1007', label: 'Advertising and trade fair services', noForm15: false },
  { code: 'S1008', label: 'Research and development services', noForm15: false },
  { code: 'S1014', label: 'Engineering services', noForm15: false },
];
export const PURPOSE_CODE_PATTERN = /^[PS]\d{4}$/;

export type Form15Part = 'NONE' | 'A' | 'B' | 'C' | 'D';

/** Rupees above which a taxable remittance needs Part C of Form 15CA and a CA's Form 15CB. */
export const FORM_15CB_THRESHOLD_INR = '500000';

/**
 * Which part of Form 15CA an Indian organisation files before the bank sends the money, and whether
 * a chartered accountant's Form 15CB is needed:
 * - purposes on the Rule 37BB(3) list (for example paying for imported goods): neither;
 * - not chargeable to tax in India: Part D;
 * - chargeable, covered by an order or certificate from the assessing officer: Part B;
 * - chargeable, up to ₹5 lakh to this vendor in the financial year (this one included): Part A;
 * - chargeable, above that: Part C, after the CA's Form 15CB.
 */
export function form15Requirement(input: { homeCountry: string; purposeCode: string; taxableInIndia: boolean; hasOrder: boolean; inrThisYear: string }): { part: Form15Part; needs15cb: boolean; reason: string } {
  if (input.homeCountry !== 'IN') return { part: 'NONE', needs15cb: false, reason: 'Form 15CA and 15CB apply only to payments from India.' };
  const p = PURPOSE_CODES.find((x) => x.code === input.purposeCode);
  if (p?.noForm15) return { part: 'NONE', needs15cb: false, reason: `${p.code} (${p.label}) is on the list of payments that need no Form 15CA or 15CB.` };
  if (!input.taxableInIndia) return { part: 'D', needs15cb: false, reason: 'Not chargeable to tax in India: Form 15CA Part D.' };
  if (input.hasOrder) return { part: 'B', needs15cb: false, reason: 'Covered by an order or certificate from the assessing officer: Form 15CA Part B.' };
  if (dec(input.inrThisYear).lte(FORM_15CB_THRESHOLD_INR)) return { part: 'A', needs15cb: false, reason: 'Chargeable to tax and not more than ₹5 lakh to this vendor this financial year: Form 15CA Part A.' };
  return { part: 'C', needs15cb: true, reason: 'Chargeable to tax and more than ₹5 lakh to this vendor this financial year: Form 15CB from a chartered accountant, then Form 15CA Part C.' };
}

export interface RemittanceCheck {
  bank: { international: boolean; verified: boolean } | null;
  purposeCode: string | null;
  part: Form15Part;
  needs15cb: boolean;
  form15caAck: string | null;
  form15cbNumber: string | null;
  items: { number: string; currency: string; status: string; due: string; amount: string }[];
  currency: string;
}

/** Why a remittance cannot be approved as it stands. */
export function remittanceIssues(r: RemittanceCheck): string[] {
  const out: string[] = [];
  if (!r.bank) out.push('The vendor has no bank details');
  else if (!r.bank.international) out.push("The vendor's bank details are domestic; enter their international bank details");
  else if (!r.bank.verified) out.push("The vendor's international bank details are not verified yet");
  if (!r.purposeCode || !PURPOSE_CODE_PATTERN.test(r.purposeCode)) out.push('Choose the purpose of the payment (an RBI purpose code such as S0802)');
  if (!r.items.length) out.push('Add at least one bill');
  for (const i of r.items) {
    if (i.status !== 'POSTED') out.push(`${i.number} is no longer posted`);
    else if (i.currency !== r.currency) out.push(`${i.number} is in ${i.currency}, not ${r.currency}`);
    else if (dec(i.amount).gt(i.due)) out.push(`${i.number} has ${dec(i.due).toFixed(minorUnits(r.currency))} ${r.currency} left to pay, less than the ${dec(i.amount).toFixed(minorUnits(r.currency))} in this payment`);
  }
  if (r.part !== 'NONE' && !r.form15caAck?.trim()) out.push(`Enter the acknowledgement number of Form 15CA Part ${r.part}`);
  if (r.needs15cb && !r.form15cbNumber?.trim()) out.push('Enter the Form 15CB acknowledgement number from the chartered accountant');
  return out;
}

/** The functional-currency estimate at a rate, to two places. */
export const atRateInr = (amount: string, rate: string) => new D(amount).times(rate).toFixed(2);

export interface InstructionData {
  reference: string;
  date: string;
  debitAccount: string;
  remitter: { name: string; address: string | null; pan: string | null };
  beneficiary: { name: string; address: string | null; country: string | null; accountName: string; account: string; swift: string; bankName: string | null; bankAddress: string | null; bankCountry: string; routingCode: string | null; intermediarySwift: string | null };
  currency: string;
  amount: string;
  purposeCode: string;
  purpose: string;
  charges: Charges;
  invoices: string[];
  form15: { part: Form15Part; ack: string | null; cb: string | null };
}

/** The remittance instruction as label/value rows (what an outward remittance application asks for). */
export function instructionRows(d: InstructionData): [string, string][] {
  return [
    ['Our reference', d.reference],
    ['Value date', d.date],
    ['Debit account', d.debitAccount],
    ['Remitter', d.remitter.name],
    ['Remitter address', d.remitter.address ?? ''],
    ['Remitter PAN', d.remitter.pan ?? ''],
    ['Currency', d.currency],
    ['Amount', d.amount],
    ['Beneficiary name', d.beneficiary.name],
    ['Beneficiary address', [d.beneficiary.address, d.beneficiary.country].filter(Boolean).join(', ')],
    ['Account holder name', d.beneficiary.accountName],
    ['Account number / IBAN', d.beneficiary.account],
    ['Beneficiary bank SWIFT/BIC', d.beneficiary.swift],
    ['Beneficiary bank', d.beneficiary.bankName ?? ''],
    ['Beneficiary bank address', d.beneficiary.bankAddress ?? ''],
    ['Beneficiary bank country', d.beneficiary.bankCountry],
    ['Routing code', d.beneficiary.routingCode ?? ''],
    ['Intermediary bank SWIFT/BIC', d.beneficiary.intermediarySwift ?? ''],
    ['Purpose code', d.purposeCode],
    ['Purpose', d.purpose],
    ['Charges', d.charges],
    ['Invoices paid', d.invoices.join('; ')],
    ['Form 15CA', d.form15.part === 'NONE' ? 'Not required' : `Part ${d.form15.part}${d.form15.ack ? `, acknowledgement ${d.form15.ack}` : ''}`],
    ['Form 15CB', d.form15.cb ?? (d.form15.part === 'C' ? 'Required' : 'Not required')],
  ];
}

/** The instruction as a two-column CSV, with spreadsheet formulas neutralised. */
export function instructionCsv(d: InstructionData): string {
  const t = (s: string) => csvField(neutraliseFormula(s));
  return `${[['Field', 'Value'], ...instructionRows(d)].map((r) => r.map(t).join(',')).join('\r\n')}\r\n`;
}
