import { D, dec, minorUnits, type Dec } from './money';

/**
 * Invoice templates: country presets, themes, colour palettes, editable sections, a safe
 * placeholder language for HTML templates, and the renderer that turns an invoice into a
 * self-contained HTML page for printing or saving as PDF.
 *
 * Everything here is pure: the API stores templates and gathers the invoice's data, the web app
 * and the API both render with these functions, so the preview in the designer is the page that
 * prints.
 *
 * Safety model for HTML templates (written by users):
 *  - values are always HTML-escaped; there is no unescaped placeholder;
 *  - `checkHtmlTemplate` refuses scripts, event handlers, javascript: URLs, frames, forms,
 *    <base>/<link>/<meta> and anything that loads from the network;
 *  - the rendered page carries a Content-Security-Policy that allows no script and no network
 *    loads, and the web app shows it in a sandboxed iframe without allow-scripts.
 */

export class InvoiceTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceTemplateError';
  }
}

// ---------------------------------------------------------------------------------------------
// Configuration model
// ---------------------------------------------------------------------------------------------

export type InvoiceTheme = 'CLASSIC' | 'MODERN' | 'MINIMAL' | 'BOLD' | 'ELEGANT';
export const INVOICE_THEMES: readonly { id: InvoiceTheme; name: string; description: string }[] = [
  { id: 'CLASSIC', name: 'Classic', description: 'Ruled table, title on the right, quiet colour.' },
  { id: 'MODERN', name: 'Modern', description: 'Full-width colour band and rounded table header.' },
  { id: 'MINIMAL', name: 'Minimal', description: 'No boxes, thin rules and plenty of white space.' },
  { id: 'BOLD', name: 'Bold', description: 'Large title, accent bar and a coloured total box.' },
  { id: 'ELEGANT', name: 'Elegant', description: 'Centred heading, small capitals and double rules.' },
];

export type InvoiceFont = 'SANS' | 'SERIF' | 'MONO' | 'HUMANIST';
export const INVOICE_FONTS: readonly { id: InvoiceFont; name: string; stack: string }[] = [
  { id: 'SANS', name: 'Sans serif', stack: "'Helvetica Neue', Helvetica, Arial, 'Noto Sans', sans-serif" },
  { id: 'SERIF', name: 'Serif', stack: "Georgia, 'Times New Roman', 'Noto Serif', serif" },
  { id: 'MONO', name: 'Monospace', stack: "'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace" },
  { id: 'HUMANIST', name: 'Humanist', stack: "'Segoe UI', Candara, 'Trebuchet MS', 'Noto Sans', sans-serif" },
];

export type PageSize = 'A4' | 'LETTER';
export type DateStyle = 'DMY' | 'MDY' | 'ISO';
export type NumberStyle = 'INDIAN' | 'INTERNATIONAL';

export interface InvoicePalette {
  primary: string;
  accent: string;
  text: string;
  muted: string;
  background: string;
  /** Table header and highlighted boxes. */
  surface: string;
  border: string;
}
export const PALETTE_KEYS: readonly (keyof InvoicePalette)[] = [
  'primary',
  'accent',
  'text',
  'muted',
  'background',
  'surface',
  'border',
];

export const PRESET_PALETTES: readonly { id: string; name: string; palette: InvoicePalette }[] = [
  { id: 'indigo', name: 'Indigo', palette: { primary: '#3730a3', accent: '#6366f1', text: '#1f2937', muted: '#6b7280', background: '#ffffff', surface: '#eef2ff', border: '#c7d2fe' } },
  { id: 'emerald', name: 'Emerald', palette: { primary: '#065f46', accent: '#10b981', text: '#1f2937', muted: '#6b7280', background: '#ffffff', surface: '#ecfdf5', border: '#a7f3d0' } },
  { id: 'crimson', name: 'Crimson', palette: { primary: '#9f1239', accent: '#e11d48', text: '#1f2937', muted: '#6b7280', background: '#ffffff', surface: '#fff1f2', border: '#fecdd3' } },
  { id: 'ocean', name: 'Ocean', palette: { primary: '#075985', accent: '#0ea5e9', text: '#0f172a', muted: '#64748b', background: '#ffffff', surface: '#f0f9ff', border: '#bae6fd' } },
  { id: 'saffron', name: 'Saffron', palette: { primary: '#9a3412', accent: '#f97316', text: '#1c1917', muted: '#78716c', background: '#ffffff', surface: '#fff7ed', border: '#fed7aa' } },
  { id: 'plum', name: 'Plum', palette: { primary: '#6b21a8', accent: '#a855f7', text: '#1f2937', muted: '#6b7280', background: '#ffffff', surface: '#faf5ff', border: '#e9d5ff' } },
  { id: 'slate', name: 'Slate', palette: { primary: '#1e293b', accent: '#475569', text: '#0f172a', muted: '#64748b', background: '#ffffff', surface: '#f1f5f9', border: '#cbd5e1' } },
  { id: 'mono', name: 'Black and white', palette: { primary: '#000000', accent: '#404040', text: '#000000', muted: '#525252', background: '#ffffff', surface: '#f5f5f5', border: '#a3a3a3' } },
];

export type SectionKey =
  | 'HEADER'
  | 'TITLE'
  | 'META'
  | 'PARTIES'
  | 'LINES'
  | 'TOTALS'
  | 'TAX_SUMMARY'
  | 'AMOUNT_IN_WORDS'
  | 'BANK_DETAILS'
  | 'NOTES'
  | 'TERMS'
  | 'SIGNATURE'
  | 'FOOTER';

export const SECTION_INFO: Readonly<Record<SectionKey, { name: string; help: string }>> = {
  HEADER: { name: 'Header', help: 'Logo, your business name, tax number and the details you type (address, phone, email).' },
  TITLE: { name: 'Title', help: 'The document title, such as Tax Invoice, and an optional line under it.' },
  META: { name: 'Invoice details', help: 'Number, dates, reference, place of supply, reverse charge and IRN.' },
  PARTIES: { name: 'Bill to', help: "The customer's name, tax number and address, and an optional ship-to text." },
  LINES: { name: 'Line items', help: 'The table of items. Choose and rename its columns.' },
  TOTALS: { name: 'Totals', help: 'Subtotal, tax, TCS and the total.' },
  TAX_SUMMARY: { name: 'Tax summary', help: 'Tax by rate (CGST, SGST and IGST for India GST).' },
  AMOUNT_IN_WORDS: { name: 'Amount in words', help: 'The total written out in words.' },
  BANK_DETAILS: { name: 'Bank details', help: 'How to pay you: bank, account number, IFSC or IBAN, UPI.' },
  NOTES: { name: 'Notes', help: "Your text, followed by the invoice's own memo." },
  TERMS: { name: 'Terms and conditions', help: 'Payment terms, late fees, jurisdiction.' },
  SIGNATURE: { name: 'Signature', help: 'The e-signature placed when the invoice is signed, with the signer and time.' },
  FOOTER: { name: 'Footer', help: 'A closing line at the bottom of the page.' },
};
export const SECTION_KEYS = Object.keys(SECTION_INFO) as SectionKey[];

export type ColumnKey =
  | 'NO'
  | 'DESCRIPTION'
  | 'HSN'
  | 'QUANTITY'
  | 'UNIT_PRICE'
  | 'TAX_RATE'
  | 'TAX_AMOUNT'
  | 'AMOUNT'
  | 'LINE_TOTAL';
export const COLUMN_KEYS: readonly ColumnKey[] = [
  'NO',
  'DESCRIPTION',
  'HSN',
  'QUANTITY',
  'UNIT_PRICE',
  'TAX_RATE',
  'TAX_AMOUNT',
  'AMOUNT',
  'LINE_TOTAL',
];

export interface ColumnConfig {
  key: ColumnKey;
  label: string;
  visible: boolean;
}

export type SectionWidth = 'FULL' | 'HALF';
export type SectionAlign = 'LEFT' | 'CENTER' | 'RIGHT';

export interface SectionConfig {
  key: SectionKey;
  visible: boolean;
  /** Heading shown on the section; empty hides the heading. */
  title: string;
  /** Free text, may use placeholders like {{seller.name}}. New lines are kept. */
  text: string;
  /** Two HALF sections in a row sit side by side. */
  width: SectionWidth;
  align: SectionAlign;
  /** LINES only. */
  columns?: ColumnConfig[];
}

export interface LayoutConfig {
  theme: InvoiceTheme;
  palette: InvoicePalette;
  font: InvoiceFont;
  pageSize: PageSize;
  dateStyle: DateStyle;
  numberStyle: NumberStyle;
  /** The document title, such as "Tax Invoice". */
  title: string;
  /** Label for the tax number, such as GSTIN, TRN, VAT No. */
  taxIdLabel: string;
  /** Short name of the tax, such as GST, VAT, Sales tax. */
  taxLabel: string;
  showLogo: boolean;
  sections: SectionConfig[];
}

// ---------------------------------------------------------------------------------------------
// Country presets
// ---------------------------------------------------------------------------------------------

export type PresetId = 'IN_GST' | 'AE_VAT' | 'GB_VAT' | 'US_SALES' | 'SG_GST' | 'AU_GST' | 'EU_VAT' | 'GENERIC';

interface PresetRule {
  /** Shown when the rule is not met. */
  message: string;
  section?: SectionKey;
  column?: ColumnKey;
  titleIncludes?: string;
}

export interface CountryPreset {
  id: PresetId;
  name: string;
  /** ISO country the preset is written for; null for EU-wide and generic presets. */
  countryCode: string | null;
  summary: string;
  title: string;
  taxIdLabel: string;
  taxLabel: string;
  pageSize: PageSize;
  dateStyle: DateStyle;
  numberStyle: NumberStyle;
  paletteId: string;
  theme: InvoiceTheme;
  hiddenSections: SectionKey[];
  hiddenColumns: ColumnKey[];
  texts: Partial<Record<SectionKey, string>>;
  titles: Partial<Record<SectionKey, string>>;
  columnLabels: Partial<Record<ColumnKey, string>>;
  rules: PresetRule[];
}

const DEFAULT_COLUMN_LABELS: Record<ColumnKey, string> = {
  NO: '#',
  DESCRIPTION: 'Description',
  HSN: 'HSN/SAC',
  QUANTITY: 'Qty',
  UNIT_PRICE: 'Rate',
  TAX_RATE: 'Tax %',
  TAX_AMOUNT: 'Tax',
  AMOUNT: 'Amount',
  LINE_TOTAL: 'Total',
};

const DEFAULT_SECTION_TITLES: Record<SectionKey, string> = {
  HEADER: '',
  TITLE: '',
  META: '',
  PARTIES: 'Bill to',
  LINES: '',
  TOTALS: '',
  TAX_SUMMARY: 'Tax summary',
  AMOUNT_IN_WORDS: 'Amount in words',
  BANK_DETAILS: 'Bank details',
  NOTES: 'Notes',
  TERMS: 'Terms and conditions',
  SIGNATURE: 'Authorised signatory',
  FOOTER: '',
};

const DEFAULT_WIDTH: Partial<Record<SectionKey, SectionWidth>> = {
  META: 'HALF',
  PARTIES: 'HALF',
  BANK_DETAILS: 'HALF',
  SIGNATURE: 'HALF',
};
const DEFAULT_ALIGN: Partial<Record<SectionKey, SectionAlign>> = {
  SIGNATURE: 'RIGHT',
  FOOTER: 'CENTER',
  TITLE: 'RIGHT',
};

export const COUNTRY_PRESETS: readonly CountryPreset[] = [
  {
    id: 'IN_GST',
    name: 'India: GST tax invoice',
    countryCode: 'IN',
    summary: 'CGST Rule 46: GSTIN of both parties, HSN/SAC, place of supply, tax by head, signature.',
    title: 'Tax Invoice',
    taxIdLabel: 'GSTIN',
    taxLabel: 'GST',
    pageSize: 'A4',
    dateStyle: 'DMY',
    numberStyle: 'INDIAN',
    paletteId: 'saffron',
    theme: 'CLASSIC',
    hiddenSections: [],
    hiddenColumns: ['LINE_TOTAL'],
    texts: {
      TITLE: 'Original for recipient',
      BANK_DETAILS: 'Bank: \nA/c no: \nIFSC: \nUPI: ',
      TERMS: 'Payment due by the due date shown above.\nInterest at 18% a year may be charged on late payment.\nSubject to local jurisdiction.',
      SIGNATURE: 'For {{seller.name}}',
      FOOTER: 'This is a computer-generated invoice.',
    },
    titles: {},
    columnLabels: { UNIT_PRICE: 'Rate', TAX_RATE: 'GST %', TAX_AMOUNT: 'GST', AMOUNT: 'Taxable value' },
    rules: [
      { titleIncludes: 'tax invoice', message: 'A registered supplier must title the document "Tax Invoice" (CGST Rule 46).' },
      { section: 'META', message: 'Rule 46 needs the invoice number, date and place of supply: keep Invoice details visible.' },
      { section: 'PARTIES', message: "Rule 46 needs the recipient's name, address and GSTIN: keep Bill to visible." },
      { column: 'HSN', message: 'Rule 46 needs the HSN or SAC code on each line: keep the HSN/SAC column.' },
      { section: 'TAX_SUMMARY', message: 'Rule 46 needs the rate and amount of CGST, SGST/UTGST and IGST: keep the tax summary.' },
      { section: 'SIGNATURE', message: 'Rule 46 needs the signature or digital signature of the supplier: keep the signature section.' },
    ],
  },
  {
    id: 'AE_VAT',
    name: 'UAE: VAT tax invoice',
    countryCode: 'AE',
    summary: 'Federal Decree-Law 8 of 2017, Article 59: TRN, "Tax Invoice", VAT by line in AED.',
    title: 'Tax Invoice | فاتورة ضريبية',
    taxIdLabel: 'TRN',
    taxLabel: 'VAT',
    pageSize: 'A4',
    dateStyle: 'DMY',
    numberStyle: 'INTERNATIONAL',
    paletteId: 'emerald',
    theme: 'MODERN',
    hiddenSections: ['AMOUNT_IN_WORDS'],
    hiddenColumns: ['HSN'],
    texts: { BANK_DETAILS: 'Bank: \nIBAN: \nSWIFT: ', SIGNATURE: 'For {{seller.name}}', FOOTER: 'Amounts in {{doc.currency}}.' },
    titles: {},
    columnLabels: { TAX_RATE: 'VAT %', TAX_AMOUNT: 'VAT', AMOUNT: 'Net amount', LINE_TOTAL: 'Gross amount' },
    rules: [
      { titleIncludes: 'tax invoice', message: 'UAE VAT invoices must be titled "Tax Invoice".' },
      { column: 'TAX_RATE', message: 'Article 59 needs the VAT rate on each line: keep the VAT % column.' },
      { column: 'TAX_AMOUNT', message: 'Article 59 needs the VAT amount: keep the VAT column.' },
      { section: 'META', message: 'Keep Invoice details visible: the invoice number and date are required.' },
    ],
  },
  {
    id: 'GB_VAT',
    name: 'United Kingdom: VAT invoice',
    countryCode: 'GB',
    summary: 'HMRC full VAT invoice: VAT number, tax point, rate per line, VAT total in sterling.',
    title: 'VAT Invoice',
    taxIdLabel: 'VAT No.',
    taxLabel: 'VAT',
    pageSize: 'A4',
    dateStyle: 'DMY',
    numberStyle: 'INTERNATIONAL',
    paletteId: 'slate',
    theme: 'MINIMAL',
    hiddenSections: ['AMOUNT_IN_WORDS', 'TAX_SUMMARY'],
    hiddenColumns: ['HSN', 'LINE_TOTAL'],
    texts: { BANK_DETAILS: 'Bank: \nSort code: \nAccount no: ', TERMS: 'Payment within 30 days of the invoice date.', SIGNATURE: '' },
    titles: {},
    columnLabels: { UNIT_PRICE: 'Unit price', TAX_RATE: 'VAT %', TAX_AMOUNT: 'VAT', AMOUNT: 'Net' },
    rules: [
      { column: 'TAX_RATE', message: 'A full VAT invoice shows the VAT rate for each item: keep the VAT % column.' },
      { section: 'TOTALS', message: 'A full VAT invoice shows the total VAT: keep Totals visible.' },
    ],
  },
  {
    id: 'US_SALES',
    name: 'United States: invoice',
    countryCode: 'US',
    summary: 'Letter paper, month-first dates, sales tax as a total.',
    title: 'Invoice',
    taxIdLabel: 'EIN',
    taxLabel: 'Sales tax',
    pageSize: 'LETTER',
    dateStyle: 'MDY',
    numberStyle: 'INTERNATIONAL',
    paletteId: 'ocean',
    theme: 'MODERN',
    hiddenSections: ['AMOUNT_IN_WORDS', 'TAX_SUMMARY', 'SIGNATURE'],
    hiddenColumns: ['HSN', 'TAX_RATE', 'TAX_AMOUNT', 'LINE_TOTAL'],
    texts: { BANK_DETAILS: 'Bank: \nRouting no: \nAccount no: ', TERMS: 'Net 30. Please include the invoice number with your payment.', FOOTER: 'Thank you for your business.' },
    titles: { BANK_DETAILS: 'Payment details' },
    columnLabels: { UNIT_PRICE: 'Unit price' },
    rules: [],
  },
  {
    id: 'SG_GST',
    name: 'Singapore: GST tax invoice',
    countryCode: 'SG',
    summary: 'IRAS tax invoice: GST registration number, "Tax Invoice", GST amount in SGD.',
    title: 'Tax Invoice',
    taxIdLabel: 'GST Reg No.',
    taxLabel: 'GST',
    pageSize: 'A4',
    dateStyle: 'DMY',
    numberStyle: 'INTERNATIONAL',
    paletteId: 'crimson',
    theme: 'BOLD',
    hiddenSections: ['AMOUNT_IN_WORDS'],
    hiddenColumns: ['HSN', 'LINE_TOTAL'],
    texts: { SIGNATURE: 'For {{seller.name}}' },
    titles: {},
    columnLabels: { TAX_RATE: 'GST %', TAX_AMOUNT: 'GST' },
    rules: [
      { titleIncludes: 'tax invoice', message: 'IRAS requires the words "Tax Invoice".' },
      { section: 'TOTALS', message: 'Keep Totals visible: the total GST payable must be shown.' },
    ],
  },
  {
    id: 'AU_GST',
    name: 'Australia: tax invoice',
    countryCode: 'AU',
    summary: 'ATO tax invoice: ABN, "Tax invoice", GST shown or stated as included.',
    title: 'Tax invoice',
    taxIdLabel: 'ABN',
    taxLabel: 'GST',
    pageSize: 'A4',
    dateStyle: 'DMY',
    numberStyle: 'INTERNATIONAL',
    paletteId: 'indigo',
    theme: 'MINIMAL',
    hiddenSections: ['AMOUNT_IN_WORDS', 'TAX_SUMMARY', 'SIGNATURE'],
    hiddenColumns: ['HSN', 'LINE_TOTAL'],
    texts: { BANK_DETAILS: 'BSB: \nAccount no: ' },
    titles: {},
    columnLabels: { TAX_RATE: 'GST %', TAX_AMOUNT: 'GST' },
    rules: [{ titleIncludes: 'tax invoice', message: 'The ATO requires the document to say it is a tax invoice.' }],
  },
  {
    id: 'EU_VAT',
    name: 'European Union: VAT invoice',
    countryCode: null,
    summary: 'VAT Directive Article 226: VAT numbers of both parties, rate per line, VAT by rate.',
    title: 'Invoice',
    taxIdLabel: 'VAT ID',
    taxLabel: 'VAT',
    pageSize: 'A4',
    dateStyle: 'ISO',
    numberStyle: 'INTERNATIONAL',
    paletteId: 'indigo',
    theme: 'ELEGANT',
    hiddenSections: ['AMOUNT_IN_WORDS', 'SIGNATURE'],
    hiddenColumns: ['HSN', 'LINE_TOTAL'],
    texts: { BANK_DETAILS: 'IBAN: \nBIC: ' },
    titles: {},
    columnLabels: { TAX_RATE: 'VAT %', TAX_AMOUNT: 'VAT', AMOUNT: 'Net' },
    rules: [
      { section: 'PARTIES', message: "Article 226 needs the customer's name, address and VAT ID: keep Bill to visible." },
      { column: 'TAX_RATE', message: 'Article 226 needs the VAT rate applied: keep the VAT % column.' },
      { section: 'TAX_SUMMARY', message: 'Article 226 needs the VAT amount by rate: keep the tax summary.' },
    ],
  },
  {
    id: 'GENERIC',
    name: 'Generic invoice',
    countryCode: null,
    summary: 'A plain invoice for any country; adjust labels to suit.',
    title: 'Invoice',
    taxIdLabel: 'Tax ID',
    taxLabel: 'Tax',
    pageSize: 'A4',
    dateStyle: 'DMY',
    numberStyle: 'INTERNATIONAL',
    paletteId: 'slate',
    theme: 'CLASSIC',
    hiddenSections: ['AMOUNT_IN_WORDS', 'SIGNATURE'],
    hiddenColumns: ['HSN', 'LINE_TOTAL'],
    texts: { FOOTER: 'Thank you for your business.' },
    titles: {},
    columnLabels: {},
    rules: [],
  },
];

export function getPreset(id: string): CountryPreset {
  const preset = COUNTRY_PRESETS.find((p) => p.id === id);
  if (!preset) throw new InvoiceTemplateError(`Unknown template preset ${id}.`);
  return preset;
}

/** The preset that suits an organisation's country (generic when there is none). */
export function presetForCountry(countryCode: string): CountryPreset {
  const eu = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'];
  const code = countryCode.toUpperCase();
  return (
    COUNTRY_PRESETS.find((p) => p.countryCode === code) ??
    (eu.includes(code) ? getPreset('EU_VAT') : getPreset('GENERIC'))
  );
}

export function paletteById(id: string): InvoicePalette {
  const found = PRESET_PALETTES.find((p) => p.id === id);
  if (!found) throw new InvoiceTemplateError(`Unknown palette ${id}.`);
  return { ...found.palette };
}

/** A full layout built from a country preset; every part can then be changed. */
export function layoutFromPreset(presetId: string, overrides: Partial<Pick<LayoutConfig, 'theme' | 'palette'>> = {}): LayoutConfig {
  const p = getPreset(presetId);
  const sections: SectionConfig[] = SECTION_KEYS.map((key) => {
    const section: SectionConfig = {
      key,
      visible: !p.hiddenSections.includes(key),
      title: p.titles[key] ?? DEFAULT_SECTION_TITLES[key],
      text: p.texts[key] ?? '',
      width: DEFAULT_WIDTH[key] ?? 'FULL',
      align: DEFAULT_ALIGN[key] ?? 'LEFT',
    };
    if (key === 'LINES') {
      section.columns = COLUMN_KEYS.map((c) => ({
        key: c,
        label: p.columnLabels[c] ?? DEFAULT_COLUMN_LABELS[c],
        visible: !p.hiddenColumns.includes(c),
      }));
    }
    return section;
  });
  return {
    theme: overrides.theme ?? p.theme,
    palette: overrides.palette ? { ...overrides.palette } : paletteById(p.paletteId),
    font: p.theme === 'ELEGANT' ? 'SERIF' : 'SANS',
    pageSize: p.pageSize,
    dateStyle: p.dateStyle,
    numberStyle: p.numberStyle,
    title: p.title,
    taxIdLabel: p.taxIdLabel,
    taxLabel: p.taxLabel,
    showLogo: true,
    sections,
  };
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

const HEX = /^#[0-9a-fA-F]{6}$/;
const MAX_TEXT = 2000;
const MAX_LABEL = 120;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new InvoiceTemplateError(`${label} must be one of ${allowed.join(', ')}.`);
  }
  return value as T;
}

function text(value: unknown, label: string, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new InvoiceTemplateError(`${label} must be text.`);
  if (value.length > max) throw new InvoiceTemplateError(`${label} is longer than ${max} characters.`);
  return value.replace(/\r\n?/g, '\n');
}

/**
 * Checks a layout from outside (the API body) and returns a clean copy: every section once, in
 * the given order, every column once, colours as #RRGGBB, placeholders that parse.
 */
export function normaliseLayout(input: unknown): LayoutConfig {
  if (!input || typeof input !== 'object') throw new InvoiceTemplateError('The layout is missing.');
  const raw = input as Record<string, unknown>;
  const paletteRaw = (raw.palette ?? {}) as Record<string, unknown>;
  const palette = {} as InvoicePalette;
  for (const key of PALETTE_KEYS) {
    const v = paletteRaw[key];
    if (typeof v !== 'string' || !HEX.test(v)) {
      throw new InvoiceTemplateError(`Colour ${key} must be a hex colour like #1f2937.`);
    }
    palette[key] = v.toLowerCase();
  }
  if (!Array.isArray(raw.sections)) throw new InvoiceTemplateError('The layout has no sections.');
  const seen = new Set<SectionKey>();
  const sections: SectionConfig[] = [];
  for (const s of raw.sections as Record<string, unknown>[]) {
    const key = oneOf(s?.key, SECTION_KEYS, 'Section');
    if (seen.has(key)) throw new InvoiceTemplateError(`Section ${SECTION_INFO[key].name} appears twice.`);
    seen.add(key);
    const section: SectionConfig = {
      key,
      visible: s.visible !== false,
      title: text(s.title, `${SECTION_INFO[key].name} heading`, MAX_LABEL),
      text: text(s.text, `${SECTION_INFO[key].name} text`, MAX_TEXT),
      width: oneOf(s.width ?? 'FULL', ['FULL', 'HALF'] as const, 'Section width'),
      align: oneOf(s.align ?? 'LEFT', ['LEFT', 'CENTER', 'RIGHT'] as const, 'Section alignment'),
    };
    compileTemplate(section.text, `${SECTION_INFO[key].name} text`);
    if (key === 'LINES') {
      const cols = Array.isArray(s.columns) ? (s.columns as Record<string, unknown>[]) : [];
      const seenCols = new Set<ColumnKey>();
      section.columns = [];
      for (const c of cols) {
        const ck = oneOf(c?.key, COLUMN_KEYS, 'Column');
        if (seenCols.has(ck)) throw new InvoiceTemplateError(`Column ${ck} appears twice.`);
        seenCols.add(ck);
        section.columns.push({ key: ck, label: text(c.label, 'Column label', 40) || DEFAULT_COLUMN_LABELS[ck], visible: c.visible !== false });
      }
      for (const ck of COLUMN_KEYS) {
        if (!seenCols.has(ck)) section.columns.push({ key: ck, label: DEFAULT_COLUMN_LABELS[ck], visible: false });
      }
      if (!section.columns.some((c) => c.visible && c.key === 'DESCRIPTION')) {
        throw new InvoiceTemplateError('The line items table must show the Description column.');
      }
    }
    sections.push(section);
  }
  for (const key of SECTION_KEYS) {
    if (!seen.has(key)) {
      const blank = layoutFromPreset('GENERIC').sections.find((s) => s.key === key)!;
      sections.push({ ...blank, visible: false });
    }
  }
  const title = text(raw.title, 'Title', MAX_LABEL).trim();
  if (!title) throw new InvoiceTemplateError('The title cannot be empty.');
  return {
    theme: oneOf(raw.theme, INVOICE_THEMES.map((t) => t.id), 'Theme'),
    palette,
    font: oneOf(raw.font ?? 'SANS', INVOICE_FONTS.map((f) => f.id), 'Font'),
    pageSize: oneOf(raw.pageSize ?? 'A4', ['A4', 'LETTER'] as const, 'Page size'),
    dateStyle: oneOf(raw.dateStyle ?? 'DMY', ['DMY', 'MDY', 'ISO'] as const, 'Date style'),
    numberStyle: oneOf(raw.numberStyle ?? 'INTERNATIONAL', ['INDIAN', 'INTERNATIONAL'] as const, 'Number style'),
    title,
    taxIdLabel: text(raw.taxIdLabel, 'Tax number label', 40).trim() || 'Tax ID',
    taxLabel: text(raw.taxLabel, 'Tax label', 40).trim() || 'Tax',
    showLogo: raw.showLogo !== false,
    sections,
  };
}

/** WCAG contrast ratio of two #RRGGBB colours. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * Advice on a layout: country rules it no longer meets and colours that will be hard to read.
 * These are warnings; the template still saves.
 */
export function layoutWarnings(layout: LayoutConfig, presetId: string | null): string[] {
  const out: string[] = [];
  const preset = presetId ? COUNTRY_PRESETS.find((p) => p.id === presetId) : undefined;
  const visible = (k: SectionKey) => layout.sections.some((s) => s.key === k && s.visible);
  const lines = layout.sections.find((s) => s.key === 'LINES');
  const colVisible = (k: ColumnKey) => !!lines?.visible && !!lines.columns?.some((c) => c.key === k && c.visible);
  for (const rule of preset?.rules ?? []) {
    if (rule.section && !visible(rule.section)) out.push(rule.message);
    else if (rule.column && !colVisible(rule.column)) out.push(rule.message);
    else if (rule.titleIncludes && !layout.title.toLowerCase().includes(rule.titleIncludes)) out.push(rule.message);
  }
  if (!visible('LINES')) out.push('The line items table is hidden, so the invoice will not list what was sold.');
  if (!visible('TOTALS')) out.push('Totals are hidden, so the invoice will not show the amount due.');
  if (contrastRatio(layout.palette.text, layout.palette.background) < 4.5) {
    out.push('The text colour is hard to read on the background colour (contrast below 4.5 to 1).');
  }
  if (layout.theme === 'MODERN' && contrastRatio('#ffffff', layout.palette.primary) < 3) {
    out.push('White text on the primary colour band will be hard to read; pick a darker primary colour.');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Placeholder language (a small, logic-less subset of Mustache)
// ---------------------------------------------------------------------------------------------

type Node =
  | { t: 'text'; v: string }
  | { t: 'var'; path: string }
  | { t: 'section'; path: string; inverted: boolean; children: Node[] };

const TAG = /\{\{\s*([#^/!]?)\s*([^}]*?)\s*\}\}/g;
const PATH = /^(\.|[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*)$/;

/**
 * Parses placeholders: {{path}} (escaped value), {{#path}}…{{/path}} (repeat for a list, show
 * when true), {{^path}}…{{/path}} (show when empty or false), {{! comment }}. {{{…}}} and {{&…}}
 * (unescaped values) are refused.
 */
export function compileTemplate(source: string, label = 'Template'): Node[] {
  if (source.includes('{{{') || /\{\{\s*&/.test(source)) {
    throw new InvoiceTemplateError(`${label}: unescaped placeholders ({{{…}}} or {{&…}}) are not allowed.`);
  }
  const root: Node[] = [];
  const stack: { path: string; children: Node[]; line: number }[] = [];
  let current = root;
  let last = 0;
  const lineAt = (i: number) => source.slice(0, i).split('\n').length;
  TAG.lastIndex = 0;
  for (let m = TAG.exec(source); m; m = TAG.exec(source)) {
    if (m.index > last) current.push({ t: 'text', v: source.slice(last, m.index) });
    last = m.index + m[0].length;
    const [, sigil, name] = m;
    if (sigil === '!') continue;
    if (!PATH.test(name!)) {
      throw new InvoiceTemplateError(`${label}: "${m[0]}" on line ${lineAt(m.index)} is not a valid placeholder.`);
    }
    if (sigil === '#' || sigil === '^') {
      const node: Node = { t: 'section', path: name!, inverted: sigil === '^', children: [] };
      current.push(node);
      stack.push({ path: name!, children: current, line: lineAt(m.index) });
      current = node.children;
    } else if (sigil === '/') {
      const open = stack.pop();
      if (!open || open.path !== name) {
        throw new InvoiceTemplateError(
          `${label}: {{/${name}}} on line ${lineAt(m.index)} does not close ${open ? `{{#${open.path}}}` : 'any section'}.`,
        );
      }
      current = open.children;
    } else {
      current.push({ t: 'var', path: name! });
    }
  }
  if (stack.length) {
    const open = stack[stack.length - 1]!;
    throw new InvoiceTemplateError(`${label}: {{#${open.path}}} on line ${open.line} is never closed.`);
  }
  if (last < source.length) current.push({ t: 'text', v: source.slice(last) });
  if (source.includes('{{') && !root.length) throw new InvoiceTemplateError(`${label}: a placeholder is not closed.`);
  return root;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

function lookup(stack: unknown[], path: string): unknown {
  if (path === '.') return stack[stack.length - 1];
  const parts = path.split('.');
  for (let i = stack.length - 1; i >= 0; i--) {
    const ctx = stack[i];
    if (ctx && typeof ctx === 'object' && parts[0]! in (ctx as object)) {
      let v: unknown = ctx;
      for (const p of parts) {
        if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, p)) v = (v as Record<string, unknown>)[p];
        else return undefined;
      }
      return v;
    }
  }
  return undefined;
}

function renderNodes(nodes: Node[], stack: unknown[], out: string[], newlines: boolean, plain = false) {
  for (const n of nodes) {
    if (n.t === 'text') out.push(plain ? escapeHtml(n.v).replace(/\n/g, '<br>') : n.v);
    else if (n.t === 'var') {
      const v = lookup(stack, n.path);
      if (v === undefined || v === null || typeof v === 'object' || typeof v === 'function') continue;
      const s = escapeHtml(String(v));
      out.push(newlines ? s.replace(/\n/g, '<br>') : s);
    } else {
      const v = lookup(stack, n.path);
      const empty = v === undefined || v === null || v === false || v === '' || (Array.isArray(v) && v.length === 0);
      if (n.inverted) {
        if (empty) renderNodes(n.children, stack, out, newlines, plain);
      } else if (!empty) {
        if (Array.isArray(v)) for (const item of v) renderNodes(n.children, [...stack, item], out, newlines, plain);
        else renderNodes(n.children, typeof v === 'object' ? [...stack, v] : stack, out, newlines, plain);
      }
    }
  }
}

/**
 * Renders placeholders with escaped values. `newlines` turns line breaks in values into <br>.
 * `plain` treats the source itself as plain text (section text in layouts): it is escaped too,
 * so typed text can never add HTML.
 */
export function renderPlaceholders(source: string, view: unknown, opts: { newlines?: boolean; plain?: boolean } = {}): string {
  const out: string[] = [];
  renderNodes(compileTemplate(source), [view], out, !!opts.newlines || !!opts.plain, !!opts.plain);
  return out.join('');
}

/** Every placeholder an invoice offers, for the reference panel and unknown-name checks. */
export const INVOICE_PLACEHOLDERS: readonly { path: string; description: string; list?: boolean }[] = [
  { path: 'title', description: 'The template title, such as Tax Invoice' },
  { path: 'labels.taxId', description: 'Label for tax numbers (GSTIN, TRN, VAT No.)' },
  { path: 'labels.tax', description: 'Short tax name (GST, VAT, Sales tax)' },
  { path: 'logo', description: 'The logo as a data: URL, for <img src="{{logo}}">; empty when there is none' },
  { path: 'doc.kind', description: 'Invoice, Debit note or Credit note' },
  { path: 'doc.number', description: 'Document number (DRAFT until posted)' },
  { path: 'doc.originalInvoice', description: 'Debit notes: the invoice they adjust, with its date; empty otherwise' },
  { path: 'doc.issueDate', description: 'Issue date, formatted' },
  { path: 'doc.dueDate', description: 'Due date, formatted' },
  { path: 'doc.reference', description: 'Your reference or PO number' },
  { path: 'doc.memo', description: 'Memo typed on the invoice' },
  { path: 'doc.currency', description: 'Currency code' },
  { path: 'doc.status', description: 'Draft, Posted or Void' },
  { path: 'doc.isProForma', description: 'True for a pro forma invoice (not a tax invoice)' },
  { path: 'doc.dueLabel', description: 'Due date, or Valid until on a pro forma invoice' },
  { path: 'doc.isDraft', description: 'True for drafts (use {{#doc.isDraft}}…{{/doc.isDraft}})' },
  { path: 'doc.isVoid', description: 'True for void documents' },
  { path: 'doc.placeOfSupply', description: 'India GST place of supply, such as 27 Maharashtra' },
  { path: 'doc.reverseCharge', description: 'Yes or No' },
  { path: 'doc.irn', description: 'India e-invoice IRN, when generated' },
  { path: 'doc.ackNo', description: 'India e-invoice acknowledgement number' },
  { path: 'doc.ackDate', description: 'India e-invoice acknowledgement date' },
  { path: 'seller.name', description: 'Your business name' },
  { path: 'seller.legalName', description: 'Your legal name' },
  { path: 'seller.taxId', description: 'Your tax number (GSTIN on Indian GST invoices)' },
  { path: 'buyer.name', description: "Customer's name" },
  { path: 'buyer.taxId', description: "Customer's tax number" },
  { path: 'buyer.address', description: "Customer's address (several lines)" },
  { path: 'buyer.email', description: "Customer's email" },
  { path: 'buyer.phone', description: "Customer's phone" },
  { path: 'buyer.state', description: "Customer's state (India)" },
  { path: 'lines', description: 'The items: {{#lines}}…{{/lines}}', list: true },
  { path: 'lines.no', description: 'Line number' },
  { path: 'lines.description', description: 'Item description' },
  { path: 'lines.hsn', description: 'HSN or SAC code' },
  { path: 'lines.quantity', description: 'Quantity' },
  { path: 'lines.unitPrice', description: 'Unit price' },
  { path: 'lines.taxRate', description: 'Tax rate, such as 18%' },
  { path: 'lines.taxAmount', description: 'Tax on the line' },
  { path: 'lines.amount', description: 'Line amount before tax' },
  { path: 'lines.total', description: 'Line amount with tax' },
  { path: 'taxes', description: 'Tax by rate: {{#taxes}}…{{/taxes}}', list: true },
  { path: 'taxes.rate', description: 'Rate' },
  { path: 'taxes.taxable', description: 'Taxable amount at the rate' },
  { path: 'taxes.cgst', description: 'CGST (India)' },
  { path: 'taxes.sgst', description: 'SGST/UTGST (India)' },
  { path: 'taxes.igst', description: 'IGST (India)' },
  { path: 'taxes.amount', description: 'Tax at the rate' },
  { path: 'hasGst', description: 'True when the tax is split into CGST, SGST and IGST' },
  { path: 'totals.subtotal', description: 'Total before tax' },
  { path: 'totals.tax', description: 'Total tax' },
  { path: 'totals.withholding', description: 'TCS collected, when any' },
  { path: 'totals.total', description: 'Invoice total' },
  { path: 'totals.paid', description: 'Amount received so far' },
  { path: 'totals.due', description: 'Amount still due' },
  { path: 'amountInWords', description: 'The total in words' },
  { path: 'signature', description: 'Present once signed: {{#signature}}…{{/signature}}' },
  { path: 'signature.image', description: 'Signature image as a data: URL' },
  { path: 'signature.name', description: 'Signer name' },
  { path: 'signature.designation', description: 'Signer designation' },
  { path: 'signature.signedAt', description: 'Date and time signed' },
  { path: 'signature.hash', description: 'Content hash recorded at signing (first 16 characters)' },
];

/** Placeholder names used, each with the section names around it. */
function collectPaths(nodes: Node[], prefix: string[], out: { prefix: string[]; path: string }[]) {
  for (const n of nodes) {
    if (n.t === 'text' || n.path === '.') continue;
    out.push({ prefix, path: n.path });
    if (n.t === 'section') collectPaths(n.children, n.inverted ? prefix : [...prefix, n.path], out);
  }
}

// ---------------------------------------------------------------------------------------------
// HTML template checks
// ---------------------------------------------------------------------------------------------

export const MAX_HTML_TEMPLATE_BYTES = 200_000;

const FORBIDDEN_TAGS = [
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'form', 'input',
  'button', 'textarea', 'select', 'option', 'link', 'meta', 'html', 'head', 'body', 'portal',
  'noscript', 'template', 'audio', 'video', 'source', 'track', 'foreignobject',
];

function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

export interface HtmlTemplateCheck {
  ok: boolean;
  errors: string[];
  /** Placeholders that are not in the reference; they render empty. */
  unknownPlaceholders: string[];
}

/**
 * Checks an HTML template written by a user. The template is the page body (with <style> blocks
 * if wanted); the page shell, charset and security policy are added when it renders.
 */
export function checkHtmlTemplate(html: string): HtmlTemplateCheck {
  const errors: string[] = [];
  const lineOf = (i: number) => html.slice(0, i).split('\n').length;
  if (!html.trim()) errors.push('The HTML template is empty.');
  if (utf8Length(html) > MAX_HTML_TEMPLATE_BYTES) {
    errors.push(`The HTML template is larger than ${MAX_HTML_TEMPLATE_BYTES / 1000} KB.`);
  }
  const tagRe = /<\s*\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/g;
  for (let m = tagRe.exec(html); m; m = tagRe.exec(html)) {
    const tag = m[1]!.toLowerCase();
    if (FORBIDDEN_TAGS.includes(tag)) {
      const hint = ['html', 'head', 'body', 'meta'].includes(tag)
        ? ' Write only the page body; put styles in a <style> block.'
        : '';
      errors.push(`<${tag}> on line ${lineOf(m.index)} is not allowed in invoice templates.${hint}`);
    }
  }
  const handlerRe = /<[^>]*?\s(on[a-z]+)\s*=/gi;
  for (let m = handlerRe.exec(html); m; m = handlerRe.exec(html)) {
    errors.push(`The ${m[1]!.toLowerCase()} attribute on line ${lineOf(m.index)} is not allowed: templates cannot run code.`);
  }
  const schemeRe = /(javascript|vbscript|livescript)\s*:/gi;
  for (let m = schemeRe.exec(html); m; m = schemeRe.exec(html)) {
    errors.push(`A ${m[1]!.toLowerCase()}: link on line ${lineOf(m.index)} is not allowed.`);
  }
  const externalRe = /(?:\b(?:src|srcset|background|poster|xlink:href|data)\s*=\s*["']?\s*(?:https?:|\/\/|ftp:|file:))|(?:url\(\s*["']?\s*(?:https?:|\/\/|ftp:|file:))|(?:@import)/gi;
  for (let m = externalRe.exec(html); m; m = externalRe.exec(html)) {
    errors.push(
      `Line ${lineOf(m.index)} loads something from the network. Templates must be self-contained: use {{logo}} or data: images.`,
    );
  }
  if (/expression\s*\(/i.test(html)) errors.push('CSS expression() is not allowed.');
  let unknownPlaceholders: string[] = [];
  try {
    const nodes = compileTemplate(html, 'HTML template');
    const used: { prefix: string[]; path: string }[] = [];
    collectPaths(nodes, [], used);
    const known = new Set(INVOICE_PLACEHOLDERS.map((p) => p.path));
    const unknown = new Set<string>();
    for (const { prefix, path } of used) {
      // Inside {{#lines}} the name {{amount}} means lines.amount; outer names still resolve.
      let found = false;
      for (let k = prefix.length; k >= 0 && !found; k--) found = known.has([...prefix.slice(0, k), path].join('.'));
      if (!found) unknown.add(path);
    }
    unknownPlaceholders = [...unknown];
  } catch (e) {
    errors.push((e as Error).message);
  }
  return { ok: errors.length === 0, errors, unknownPlaceholders };
}

// ---------------------------------------------------------------------------------------------
// Amounts, dates and words
// ---------------------------------------------------------------------------------------------

function groupDigits(int: string, style: NumberStyle): string {
  if (style === 'INDIAN' && int.length > 3) {
    const last3 = int.slice(-3);
    const rest = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    return `${rest},${last3}`;
  }
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 1234567.5 → 12,34,567.50 (Indian) or 1,234,567.50, at the currency's minor units. */
export function formatAmount(value: string | Dec, currency: string, style: NumberStyle): string {
  const d = typeof value === 'string' ? dec(value) : value;
  const scale = minorUnits(currency);
  const fixed = d.abs().toFixed(scale, D.ROUND_HALF_UP);
  const [int, frac] = fixed.split('.');
  const body = groupDigits(int!, style) + (frac ? `.${frac}` : '');
  return d.isNeg() && !d.abs().toFixed(scale, D.ROUND_HALF_UP).match(/^0(\.0+)?$/) ? `-${body}` : body;
}

/** Quantity without trailing zeros: 2.500000 → 2.5. */
export function formatQuantity(value: string): string {
  const d = dec(value);
  return d.toFixed(Math.min(6, Math.max(0, d.decimalPlaces())));
}

/** Rate given as a fraction (0.18) or a percentage string → "18%". */
export function formatRate(percent: string): string {
  const d = dec(percent);
  return `${d.toFixed(Math.min(4, Math.max(0, d.decimalPlaces())))}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** YYYY-MM-DD → 02 Nov 2026, Nov 2, 2026 or 2026-11-02. */
export function formatDate(iso: string | null | undefined, style: DateStyle): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  if (style === 'ISO') return `${y}-${mo}-${d}`;
  const month = MONTHS[Number(mo) - 1];
  return style === 'MDY' ? `${month} ${Number(d)}, ${y}` : `${d} ${month} ${y}`;
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} Hundred`);
    n %= 100;
  }
  if (n >= 20) {
    parts.push(TENS[Math.floor(n / 10)]! + (n % 10 ? `-${ONES[n % 10]}` : ''));
  } else if (n > 0) {
    parts.push(ONES[n]!);
  }
  return parts.join(' ');
}

function intWordsInternational(n: bigint): string {
  if (n === 0n) return 'Zero';
  const scales = ['', 'Thousand', 'Million', 'Billion', 'Trillion', 'Quadrillion'];
  const parts: string[] = [];
  let i = 0;
  while (n > 0n) {
    const chunk = Number(n % 1000n);
    if (chunk) parts.unshift(`${below1000(chunk)}${scales[i] ? ` ${scales[i]}` : ''}`);
    n /= 1000n;
    i++;
    if (i >= scales.length && n > 0n) throw new InvoiceTemplateError('The amount is too large to write in words.');
  }
  return parts.join(' ');
}

function intWordsIndian(n: bigint): string {
  if (n === 0n) return 'Zero';
  const parts: string[] = [];
  const crore = n / 10_000_000n;
  let rest = n % 10_000_000n;
  if (crore > 0n) parts.push(`${intWordsIndian(crore)} Crore`);
  const lakh = Number(rest / 100_000n);
  rest %= 100_000n;
  if (lakh) parts.push(`${below1000(lakh)} Lakh`);
  const thousand = Number(rest / 1000n);
  rest %= 1000n;
  if (thousand) parts.push(`${below1000(thousand)} Thousand`);
  if (rest > 0n) parts.push(below1000(Number(rest)));
  return parts.join(' ');
}

const CURRENCY_WORDS: Record<string, [string, string]> = {
  INR: ['Rupees', 'Paise'],
  USD: ['US Dollars', 'Cents'],
  AED: ['UAE Dirhams', 'Fils'],
  GBP: ['Pounds Sterling', 'Pence'],
  EUR: ['Euros', 'Cents'],
  SGD: ['Singapore Dollars', 'Cents'],
  AUD: ['Australian Dollars', 'Cents'],
  CAD: ['Canadian Dollars', 'Cents'],
  JPY: ['Yen', ''],
  SAR: ['Saudi Riyals', 'Halalas'],
};

/**
 * The amount in words: "Rupees One Lakh Twenty Thousand and Fifty Paise Only" (Indian lakh/crore
 * for INR), "US Dollars One Thousand Two Hundred and Five Cents Only" elsewhere.
 */
export function amountInWords(amount: string | Dec, currency: string, style?: NumberStyle): string {
  const d = (typeof amount === 'string' ? dec(amount) : amount).toDecimalPlaces(minorUnits(currency), D.ROUND_HALF_UP);
  const neg = d.isNeg() && !d.isZero();
  const abs = d.abs();
  const scale = minorUnits(currency);
  const [intStr, fracStr = ''] = abs.toFixed(scale).split('.');
  const indian = (style ?? (currency === 'INR' ? 'INDIAN' : 'INTERNATIONAL')) === 'INDIAN';
  const words = (n: bigint) => (indian ? intWordsIndian(n) : intWordsInternational(n));
  const [major, minor] = CURRENCY_WORDS[currency] ?? [currency, 'Hundredths'];
  let out = `${major} ${words(BigInt(intStr!))}`;
  const fraction = fracStr ? Number(fracStr) : 0;
  if (fraction > 0) {
    out += minor && scale === 2 ? ` and ${below1000(fraction)} ${minor}` : ` and ${fracStr}/${10 ** scale}`;
  }
  return `${neg ? 'Minus ' : ''}${out} Only`;
}

// ---------------------------------------------------------------------------------------------
// The invoice view: data from the API, formatted for the page
// ---------------------------------------------------------------------------------------------

export interface InvoicePrintLine {
  description: string | null;
  hsnCode: string | null;
  quantity: string;
  unitPrice: string;
  /** Percentage, such as "18". */
  taxRate: string;
  netAmount: string;
  taxAmount: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
}

export interface InvoiceSignatureInfo {
  imageDataUrl: string;
  signerName: string;
  designation: string | null;
  /** ISO timestamp. */
  signedAt: string;
  contentHash: string;
}

/** Everything the page needs about one invoice, as the API returns it. */
export interface InvoicePrintSource {
  /** PRO_FORMA: a pro forma invoice (AR-008), printed as "not a tax invoice" with its valid-until date in place of the due date. */
  kind: 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE' | 'PRO_FORMA';
  /** Debit notes: the invoice whose value they raise (CGST Rule 53(1A) asks for its number and date). */
  originalInvoice?: { number: string; issueDate: string } | null;
  status: 'DRAFT' | 'POSTED' | 'VOID';
  number: string | null;
  issueDate: string;
  dueDate: string;
  reference: string | null;
  memo: string | null;
  currency: string;
  placeOfSupply: string | null;
  reverseCharge: boolean;
  seller: { name: string; legalName: string | null; taxId: string | null };
  buyer: {
    name: string;
    taxId: string | null;
    address: string | null;
    city: string | null;
    pincode: string | null;
    email: string | null;
    phone: string | null;
    stateCode: string | null;
  };
  lines: InvoicePrintLine[];
  subtotal: string;
  taxTotal: string;
  /** TCS added to an invoice; zero when none. */
  withholdingAmount: string;
  total: string;
  paid: string;
  eInvoice: { irn: string; ackNo: string; ackDate: string } | null;
  signature: InvoiceSignatureInfo | null;
  logoDataUrl: string | null;
}

export const INDIAN_STATES: Readonly<Record<string, string>> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
  '96': 'Outside India',
};

export interface InvoiceView {
  title: string;
  labels: { taxId: string; tax: string };
  logo: string;
  doc: Record<string, string | boolean>;
  seller: { name: string; legalName: string; taxId: string };
  buyer: { name: string; taxId: string; address: string; email: string; phone: string; state: string };
  lines: Record<string, string>[];
  taxes: Record<string, string>[];
  hasGst: boolean;
  hasWithholding: boolean;
  totals: { subtotal: string; tax: string; withholding: string; total: string; paid: string; due: string };
  amountInWords: string;
  signature: { image: string; name: string; designation: string; signedAt: string; hash: string } | null;
}

function formatTimestamp(iso: string, style: DateStyle): string {
  const date = formatDate(iso.slice(0, 10), style);
  const time = /T(\d{2}:\d{2})/.exec(iso)?.[1] ?? '';
  return time ? `${date}, ${time} UTC` : date;
}

export function buildInvoiceView(
  src: InvoicePrintSource,
  opts: Pick<LayoutConfig, 'title' | 'taxIdLabel' | 'taxLabel' | 'dateStyle' | 'numberStyle' | 'showLogo'>,
): InvoiceView {
  const money = (v: string | Dec) => formatAmount(v, src.currency, opts.numberStyle);
  const hasGst = src.lines.some((l) => !dec(l.cgstAmount).isZero() || !dec(l.sgstAmount).isZero() || !dec(l.igstAmount).isZero());
  const byRate = new Map<string, { taxable: Dec; cgst: Dec; sgst: Dec; igst: Dec; tax: Dec }>();
  for (const l of src.lines) {
    const key = dec(l.taxRate).toString();
    const row = byRate.get(key) ?? { taxable: dec('0'), cgst: dec('0'), sgst: dec('0'), igst: dec('0'), tax: dec('0') };
    row.taxable = row.taxable.plus(dec(l.netAmount));
    row.cgst = row.cgst.plus(dec(l.cgstAmount));
    row.sgst = row.sgst.plus(dec(l.sgstAmount));
    row.igst = row.igst.plus(dec(l.igstAmount));
    row.tax = row.tax.plus(dec(l.taxAmount));
    byRate.set(key, row);
  }
  const taxes = [...byRate.entries()]
    .sort((a, b) => dec(a[0]).comparedTo(dec(b[0])))
    .map(([rate, r]) => ({
      rate: formatRate(rate),
      taxable: money(r.taxable),
      cgst: money(r.cgst),
      sgst: money(r.sgst),
      igst: money(r.igst),
      amount: money(r.tax),
    }));
  const pos = src.placeOfSupply ? `${src.placeOfSupply} ${INDIAN_STATES[src.placeOfSupply] ?? ''}`.trim() : '';
  const due = dec(src.total).minus(dec(src.paid));
  const addressLines = [src.buyer.address, [src.buyer.city, src.buyer.pincode].filter(Boolean).join(' ')].filter(
    (s) => s && s.trim(),
  ) as string[];
  return {
    title: src.kind === 'PRO_FORMA' ? 'Pro forma invoice' : opts.title,
    labels: { taxId: opts.taxIdLabel, tax: opts.taxLabel },
    logo: opts.showLogo && src.logoDataUrl ? src.logoDataUrl : '',
    doc: {
      kind: src.kind === 'CREDIT_NOTE' ? 'Credit note' : src.kind === 'DEBIT_NOTE' ? 'Debit note' : src.kind === 'PRO_FORMA' ? 'Pro forma invoice' : 'Invoice',
      isProForma: src.kind === 'PRO_FORMA',
      dueLabel: src.kind === 'PRO_FORMA' ? 'Valid until' : 'Due date',
      originalInvoice: src.originalInvoice ? `${src.originalInvoice.number} of ${formatDate(src.originalInvoice.issueDate, opts.dateStyle)}` : '',
      number: src.number ?? 'DRAFT',
      issueDate: formatDate(src.issueDate, opts.dateStyle),
      dueDate: formatDate(src.dueDate, opts.dateStyle),
      reference: src.reference ?? '',
      memo: src.memo ?? '',
      currency: src.currency,
      status: src.status === 'DRAFT' ? 'Draft' : src.status === 'VOID' ? 'Void' : 'Posted',
      isDraft: src.status === 'DRAFT',
      isVoid: src.status === 'VOID',
      placeOfSupply: pos,
      reverseCharge: src.reverseCharge ? 'Yes' : 'No',
      irn: src.eInvoice?.irn ?? '',
      ackNo: src.eInvoice?.ackNo ?? '',
      ackDate: src.eInvoice ? formatDate(src.eInvoice.ackDate.slice(0, 10), opts.dateStyle) : '',
    },
    seller: { name: src.seller.name, legalName: src.seller.legalName ?? '', taxId: src.seller.taxId ?? '' },
    buyer: {
      name: src.buyer.name,
      taxId: src.buyer.taxId ?? '',
      address: addressLines.join('\n'),
      email: src.buyer.email ?? '',
      phone: src.buyer.phone ?? '',
      state: src.buyer.stateCode ? `${src.buyer.stateCode} ${INDIAN_STATES[src.buyer.stateCode] ?? ''}`.trim() : '',
    },
    lines: src.lines.map((l, i) => ({
      no: String(i + 1),
      description: l.description ?? '',
      hsn: l.hsnCode ?? '',
      quantity: formatQuantity(l.quantity),
      unitPrice: money(l.unitPrice),
      taxRate: formatRate(l.taxRate),
      taxAmount: money(l.taxAmount),
      amount: money(l.netAmount),
      total: money(dec(l.netAmount).plus(dec(l.taxAmount))),
    })),
    taxes,
    hasGst,
    hasWithholding: !dec(src.withholdingAmount).isZero(),
    totals: {
      subtotal: money(src.subtotal),
      tax: money(src.taxTotal),
      withholding: money(src.withholdingAmount),
      total: money(src.total),
      paid: money(src.paid),
      due: money(due),
    },
    amountInWords: amountInWords(src.total, src.currency, opts.numberStyle),
    signature: src.signature
      ? {
          image: src.signature.imageDataUrl,
          name: src.signature.signerName,
          designation: src.signature.designation ?? '',
          signedAt: formatTimestamp(src.signature.signedAt, opts.dateStyle),
          hash: src.signature.contentHash.slice(0, 16),
        }
      : null,
  };
}

/** A realistic invoice for the designer's preview when no real invoice is picked. */
export function sampleInvoiceSource(presetId: string): InvoicePrintSource {
  const p = getPreset(presetId);
  const currency = { IN: 'INR', AE: 'AED', GB: 'GBP', US: 'USD', SG: 'SGD', AU: 'AUD' }[p.countryCode ?? ''] ?? (p.id === 'EU_VAT' ? 'EUR' : 'USD');
  const rate = { IN_GST: '18', AE_VAT: '5', GB_VAT: '20', US_SALES: '8.875', SG_GST: '9', AU_GST: '10', EU_VAT: '19', GENERIC: '10' }[p.id];
  const india = p.id === 'IN_GST';
  const items: [string, string, string, string][] = [
    ['Implementation services, October', '998313', '1', '85000'],
    ['Annual software subscription (12 seats)', '997331', '12', '4500'],
    ['On-site training day', '999293', '2', '12500'],
  ];
  const lines: InvoicePrintLine[] = items.map(([description, hsn, qty, price]) => {
    const net = dec(qty).times(dec(price));
    const tax = net.times(dec(rate!)).div(100).toDecimalPlaces(2, D.ROUND_HALF_UP);
    const half = tax.div(2).toDecimalPlaces(2, D.ROUND_HALF_UP);
    return {
      description,
      hsnCode: india ? hsn : null,
      quantity: qty,
      unitPrice: price,
      taxRate: rate!,
      netAmount: net.toFixed(2),
      taxAmount: tax.toFixed(2),
      cgstAmount: india ? half.toFixed(2) : '0',
      sgstAmount: india ? tax.minus(half).toFixed(2) : '0',
      igstAmount: '0',
    };
  });
  const subtotal = lines.reduce((s, l) => s.plus(dec(l.netAmount)), dec('0'));
  const tax = lines.reduce((s, l) => s.plus(dec(l.taxAmount)), dec('0'));
  return {
    kind: 'INVOICE',
    status: 'POSTED',
    number: 'INV-000123',
    issueDate: '2026-11-02',
    dueDate: '2026-12-02',
    reference: 'PO-7781',
    memo: 'Thank you for choosing us.',
    currency,
    placeOfSupply: india ? '27' : null,
    reverseCharge: false,
    seller: { name: 'Your Business', legalName: 'Your Business Private Limited', taxId: india ? '27AAACY1234F1Z5' : 'TAX-123456' },
    buyer: {
      name: 'Acme Retail',
      taxId: india ? '27AAPFA9876K1Z2' : 'TAX-987654',
      address: '14 Market Road',
      city: india ? 'Pune' : 'Springfield',
      pincode: india ? '411001' : '10001',
      email: 'accounts@acme.example',
      phone: '+1 555 0100',
      stateCode: india ? '27' : null,
    },
    lines,
    subtotal: subtotal.toFixed(2),
    taxTotal: tax.toFixed(2),
    withholdingAmount: '0',
    total: subtotal.plus(tax).toFixed(2),
    paid: '0',
    eInvoice: null,
    signature: null,
    logoDataUrl: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

export const INVOICE_PAGE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

function themeCss(l: LayoutConfig): string {
  const c = l.palette;
  const font = INVOICE_FONTS.find((f) => f.id === l.font)!.stack;
  const base = `
  @page { size: ${l.pageSize === 'LETTER' ? 'letter' : 'A4'}; margin: 14mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: ${c.background}; }
  body { color: ${c.text}; font-family: ${font}; font-size: 12.5px; line-height: 1.45; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .inv { max-width: ${l.pageSize === 'LETTER' ? '8.5in' : '210mm'}; margin: 0 auto; padding: 28px 32px; position: relative; }
  .row { display: flex; gap: 24px; }
  .row > .sec { flex: 1 1 0; min-width: 0; }
  .sec { margin: 0 0 18px; }
  .a-CENTER { text-align: center; } .a-RIGHT { text-align: right; } .a-LEFT { text-align: left; }
  .sec h3 { margin: 0 0 6px; font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: ${c.muted}; font-weight: 600; }
  .muted { color: ${c.muted}; }
  .txt { white-space: normal; }
  .hdr { display: flex; align-items: flex-start; gap: 18px; }
  .hdr .who { flex: 1; }
  .hdr img.logo { max-height: 64px; max-width: 180px; object-fit: contain; }
  .seller { font-size: 18px; font-weight: 700; color: ${c.primary}; margin: 0 0 2px; }
  .ttl h1 { margin: 0; font-size: 26px; color: ${c.primary}; letter-spacing: .02em; }
  .ttl .sub { color: ${c.muted}; font-size: 11px; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; }
  .kv td { padding: 2px 0; vertical-align: top; }
  .kv td.k { color: ${c.muted}; padding-right: 12px; white-space: nowrap; width: 1%; }
  table.items th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; padding: 8px; background: ${c.surface}; color: ${c.primary}; border-bottom: 2px solid ${c.border}; }
  table.items td { padding: 8px; border-bottom: 1px solid ${c.border}; vertical-align: top; }
  table.items .n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  table.tax th, table.tax td { padding: 5px 8px; border-bottom: 1px solid ${c.border}; font-size: 11.5px; }
  table.tax th { text-align: left; color: ${c.muted}; font-weight: 600; }
  table.tax .n { text-align: right; font-variant-numeric: tabular-nums; }
  .totals { margin-left: auto; width: 52%; min-width: 260px; }
  .totals td { padding: 4px 8px; font-variant-numeric: tabular-nums; }
  .totals td.n { text-align: right; }
  .totals tr.grand td { font-weight: 700; font-size: 15px; color: ${c.primary}; border-top: 2px solid ${c.primary}; padding-top: 8px; }
  .sig img { max-height: 70px; max-width: 220px; display: inline-block; }
  .sig .line { border-top: 1px solid ${c.text}; display: inline-block; min-width: 200px; padding-top: 4px; margin-top: 6px; }
  .sig .placeholder { display: inline-block; height: 60px; }
  .stamp { position: absolute; top: 120px; right: 40px; transform: rotate(-14deg); border: 3px solid #b91c1c; color: #b91c1c; font-weight: 800; font-size: 28px; padding: 4px 14px; opacity: .55; letter-spacing: .1em; }
  .foot { color: ${c.muted}; font-size: 11px; border-top: 1px solid ${c.border}; padding-top: 10px; }
  .words { font-style: italic; }
  .hash { font-family: ${INVOICE_FONTS.find((f) => f.id === 'MONO')!.stack}; font-size: 10px; color: ${c.muted}; }
  @media print { .inv { padding: 0; max-width: none; } }
`;
  const themes: Record<InvoiceTheme, string> = {
    CLASSIC: `
  .inv { border-top: 6px solid ${c.primary}; }
  table.items { border: 1px solid ${c.border}; }
  table.items td, table.items th { border-right: 1px solid ${c.border}; }`,
    MODERN: `
  .band { background: ${c.primary}; color: #fff; margin: -28px -32px 22px; padding: 24px 32px; }
  .band .seller, .band h1, .band h3, .band .muted, .band .sub { color: #fff !important; }
  .band .muted { opacity: .85; }
  table.items th { background: ${c.primary}; color: #fff; border-bottom: 0; }
  table.items th:first-child { border-top-left-radius: 6px; } table.items th:last-child { border-top-right-radius: 6px; }
  table.items tr:nth-child(even) td { background: ${c.surface}; }
  .totals tr.grand td { background: ${c.surface}; border-top: 0; }
  @media print { .band { margin: 0 0 22px; } }`,
    MINIMAL: `
  .seller { color: ${c.text}; font-weight: 600; }
  .ttl h1 { font-weight: 300; font-size: 30px; color: ${c.text}; }
  table.items th { background: transparent; color: ${c.muted}; border-bottom: 1px solid ${c.text}; }
  table.items td { border-bottom: 1px solid ${c.surface}; }
  .totals tr.grand td { color: ${c.text}; border-top: 1px solid ${c.text}; }`,
    BOLD: `
  .inv { border-left: 10px solid ${c.accent}; }
  .ttl h1 { font-size: 40px; font-weight: 900; text-transform: uppercase; }
  table.items th { background: ${c.text}; color: ${c.background}; border-bottom: 0; }
  .totals tr.grand td { background: ${c.primary}; color: #fff; border-top: 0; font-size: 17px; padding: 10px 8px; }`,
    ELEGANT: `
  .hdr { flex-direction: column; align-items: center; text-align: center; }
  .seller { font-variant: small-caps; letter-spacing: .08em; font-size: 22px; font-weight: 400; }
  .ttl { border-top: 3px double ${c.border}; border-bottom: 3px double ${c.border}; padding: 8px 0; }
  .ttl h1 { font-variant: small-caps; font-weight: 400; letter-spacing: .12em; color: ${c.accent}; }
  table.items th { background: transparent; color: ${c.accent}; border-bottom: 3px double ${c.border}; font-variant: small-caps; text-transform: none; font-size: 12px; }
  .totals tr.grand td { border-top: 3px double ${c.accent}; color: ${c.accent}; }`,
  };
  return base + themes[l.theme];
}

function sectionText(section: SectionConfig, view: InvoiceView): string {
  if (!section.text.trim()) return '';
  return `<div class="txt">${renderPlaceholders(section.text, view, { plain: true })}</div>`;
}

function heading(section: SectionConfig): string {
  return section.title.trim() ? `<h3>${escapeHtml(section.title)}</h3>` : '';
}

function kvTable(rows: [string, string][]): string {
  const body = rows
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `<tr><td class="k">${escapeHtml(k)}</td><td>${escapeHtml(v).replace(/\n/g, '<br>')}</td></tr>`)
    .join('');
  return body ? `<table class="kv">${body}</table>` : '';
}

const NUMERIC: ColumnKey[] = ['QUANTITY', 'UNIT_PRICE', 'TAX_RATE', 'TAX_AMOUNT', 'AMOUNT', 'LINE_TOTAL'];
const COLUMN_FIELD: Record<ColumnKey, string> = {
  NO: 'no',
  DESCRIPTION: 'description',
  HSN: 'hsn',
  QUANTITY: 'quantity',
  UNIT_PRICE: 'unitPrice',
  TAX_RATE: 'taxRate',
  TAX_AMOUNT: 'taxAmount',
  AMOUNT: 'amount',
  LINE_TOTAL: 'total',
};

function renderSection(section: SectionConfig, view: InvoiceView, layout: LayoutConfig): string {
  const v = view;
  switch (section.key) {
    case 'HEADER': {
      const logo = v.logo ? `<img class="logo" src="${escapeHtml(v.logo)}" alt="Logo">` : '';
      const tax = v.seller.taxId ? `<div>${escapeHtml(v.labels.taxId)}: ${escapeHtml(v.seller.taxId)}</div>` : '';
      const legal =
        v.seller.legalName && v.seller.legalName !== v.seller.name ? `<div class="muted">${escapeHtml(v.seller.legalName)}</div>` : '';
      return `${heading(section)}<div class="hdr">${logo}<div class="who"><div class="seller">${escapeHtml(v.seller.name)}</div>${legal}${tax}${sectionText(section, v)}</div></div>`;
    }
    case 'TITLE': {
      const sub = v.doc.isProForma
        ? '<div class="sub">Not a tax invoice. A tax invoice is issued on supply or on receipt of payment.</div>'
        : section.text.trim() ? `<div class="sub">${renderPlaceholders(section.text, v, { plain: true })}</div>` : '';
      const kind = v.doc.kind === 'Credit note' && !/credit/i.test(v.title) ? 'Credit note' : v.doc.kind === 'Debit note' && !/debit/i.test(v.title) ? 'Debit note' : v.title;
      return `<div class="ttl">${heading(section)}<h1>${escapeHtml(kind)}</h1>${sub}</div>`;
    }
    case 'META': {
      const d = v.doc as Record<string, string>;
      const rows: [string, string][] = [
        [`${d.kind} no.`, d.number!],
        ['Date', d.issueDate!],
        ['Against invoice', d.originalInvoice ?? ''],
        [d.dueLabel ?? 'Due date', d.dueDate!],
        ['Reference', d.reference!],
        ['Place of supply', d.placeOfSupply!],
        ...(d.placeOfSupply ? ([['Reverse charge', d.reverseCharge!]] as [string, string][]) : []),
        ['IRN', d.irn!],
        ['Ack no.', d.ackNo!],
        ['Ack date', d.ackDate!],
      ];
      return `${heading(section)}${kvTable(rows)}${sectionText(section, v)}`;
    }
    case 'PARTIES': {
      const b = v.buyer;
      const lines = [
        `<div><strong>${escapeHtml(b.name)}</strong></div>`,
        b.address ? `<div>${escapeHtml(b.address).replace(/\n/g, '<br>')}</div>` : '',
        b.state ? `<div>State: ${escapeHtml(b.state)}</div>` : '',
        b.taxId ? `<div>${escapeHtml(v.labels.taxId)}: ${escapeHtml(b.taxId)}</div>` : '',
        b.email ? `<div class="muted">${escapeHtml(b.email)}</div>` : '',
        b.phone ? `<div class="muted">${escapeHtml(b.phone)}</div>` : '',
      ].join('');
      return `${heading(section)}${lines}${sectionText(section, v)}`;
    }
    case 'LINES': {
      const cols = (section.columns ?? []).filter((c) => c.visible);
      const head = cols.map((c) => `<th class="${NUMERIC.includes(c.key) ? 'n' : ''}">${escapeHtml(c.label)}</th>`).join('');
      const rows = v.lines
        .map(
          (line) =>
            `<tr>${cols
              .map((c) => `<td class="${NUMERIC.includes(c.key) ? 'n' : ''}">${escapeHtml(line[COLUMN_FIELD[c.key]] ?? '')}</td>`)
              .join('')}</tr>`,
        )
        .join('');
      return `${heading(section)}<table class="items"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>${sectionText(section, v)}`;
    }
    case 'TOTALS': {
      const t = v.totals;
      const rows = [
        `<tr><td>Subtotal</td><td class="n">${escapeHtml(t.subtotal)}</td></tr>`,
        `<tr><td>${escapeHtml(v.labels.tax)}</td><td class="n">${escapeHtml(t.tax)}</td></tr>`,
        v.hasWithholding ? `<tr><td>TCS</td><td class="n">${escapeHtml(t.withholding)}</td></tr>` : '',
        `<tr class="grand"><td>Total (${escapeHtml(String(v.doc.currency))})</td><td class="n">${escapeHtml(t.total)}</td></tr>`,
        t.paid !== formatAmount('0', String(v.doc.currency), layout.numberStyle)
          ? `<tr><td>Received</td><td class="n">${escapeHtml(t.paid)}</td></tr><tr><td><strong>Balance due</strong></td><td class="n"><strong>${escapeHtml(t.due)}</strong></td></tr>`
          : '',
      ].join('');
      return `${heading(section)}<table class="totals">${rows}</table>${sectionText(section, v)}`;
    }
    case 'TAX_SUMMARY': {
      if (!v.taxes.length) return '';
      const gst = v.hasGst;
      const head = gst
        ? '<th>Rate</th><th class="n">Taxable value</th><th class="n">CGST</th><th class="n">SGST/UTGST</th><th class="n">IGST</th><th class="n">Total tax</th>'
        : `<th>Rate</th><th class="n">Taxable value</th><th class="n">${escapeHtml(v.labels.tax)}</th>`;
      const rows = v.taxes
        .map((r) =>
          gst
            ? `<tr><td>${escapeHtml(r.rate!)}</td><td class="n">${escapeHtml(r.taxable!)}</td><td class="n">${escapeHtml(r.cgst!)}</td><td class="n">${escapeHtml(r.sgst!)}</td><td class="n">${escapeHtml(r.igst!)}</td><td class="n">${escapeHtml(r.amount!)}</td></tr>`
            : `<tr><td>${escapeHtml(r.rate!)}</td><td class="n">${escapeHtml(r.taxable!)}</td><td class="n">${escapeHtml(r.amount!)}</td></tr>`,
        )
        .join('');
      return `${heading(section)}<table class="tax"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>${sectionText(section, v)}`;
    }
    case 'AMOUNT_IN_WORDS':
      return `${heading(section)}<div class="words">${escapeHtml(v.amountInWords)}</div>${sectionText(section, v)}`;
    case 'NOTES': {
      const memo = v.doc.memo ? `<div class="txt">${escapeHtml(String(v.doc.memo)).replace(/\n/g, '<br>')}</div>` : '';
      const body = sectionText(section, v) + memo;
      return body ? `${heading(section)}${body}` : '';
    }
    case 'SIGNATURE': {
      const s = v.signature;
      const text = sectionText(section, v);
      const mark = s
        ? `<div><img src="${escapeHtml(s.image)}" alt="Signature of ${escapeHtml(s.name)}"></div><div class="line">${escapeHtml(s.name)}${s.designation ? `, ${escapeHtml(s.designation)}` : ''}</div><div class="muted">E-signed ${escapeHtml(s.signedAt)}</div><div class="hash">Content hash ${escapeHtml(s.hash)}</div>`
        : `<div class="placeholder"></div><div class="line">${escapeHtml(section.title || 'Authorised signatory')}</div>`;
      return `<div class="sig">${text}${mark}</div>`;
    }
    case 'FOOTER': {
      const body = sectionText(section, v);
      return body ? `<div class="foot">${body}</div>` : '';
    }
    default:
      return section.text.trim() ? `${heading(section)}${sectionText(section, v)}` : '';
  }
}

function pageShell(css: string, body: string, title: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${INVOICE_PAGE_CSP}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${css}</style></head><body>${body}</body></html>`;
}

/** Renders a layout template: the page body, grouping HALF sections two to a row. */
export function renderLayoutBody(layout: LayoutConfig, view: InvoiceView): string {
  const parts: string[] = [];
  const visible = layout.sections.filter((s) => s.visible);
  let i = 0;
  const wrap = (s: SectionConfig) => {
    const html = renderSection(s, view, layout);
    return html ? `<div class="sec s-${s.key.toLowerCase()} a-${s.align}">${html}</div>` : '';
  };
  // MODERN puts the header and title in one colour band.
  if (layout.theme === 'MODERN') {
    const band: string[] = [];
    while (i < visible.length && (visible[i]!.key === 'HEADER' || visible[i]!.key === 'TITLE')) band.push(wrap(visible[i++]!));
    if (band.length) parts.push(`<div class="band row">${band.join('')}</div>`);
  }
  while (i < visible.length) {
    const s = visible[i]!;
    const next = visible[i + 1];
    if (s.width === 'HALF' && next && next.width === 'HALF') {
      parts.push(`<div class="row">${wrap(s)}${wrap(next)}</div>`);
      i += 2;
    } else {
      parts.push(wrap(s));
      i += 1;
    }
  }
  const stamp = view.doc.isVoid ? '<div class="stamp">VOID</div>' : view.doc.isDraft ? '<div class="stamp">DRAFT</div>' : '';
  return `<div class="inv theme-${layout.theme.toLowerCase()}">${stamp}${parts.join('')}</div>`;
}

export type TemplateEngine = 'LAYOUT' | 'HTML';

export interface RenderableTemplate {
  engine: TemplateEngine;
  layout: LayoutConfig;
  /** HTML engine only. */
  html?: string | null;
}

/**
 * The full, self-contained HTML page for an invoice. The page allows no script and loads nothing
 * from the network (see INVOICE_PAGE_CSP).
 */
export function renderInvoiceDocument(template: RenderableTemplate, src: InvoicePrintSource): string {
  const view = buildInvoiceView(src, template.layout);
  const pageTitle = `${view.doc.kind} ${view.doc.number}`;
  if (template.engine === 'HTML') {
    const html = template.html ?? '';
    const check = checkHtmlTemplate(html);
    if (!check.ok) throw new InvoiceTemplateError(check.errors[0]!);
    const size = template.layout.pageSize === 'LETTER' ? 'letter' : 'A4';
    const css = `@page { size: ${size}; margin: 14mm; } html, body { margin: 0; background: #fff; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }`;
    return pageShell(css, renderPlaceholders(html, view), pageTitle);
  }
  return pageShell(themeCss(template.layout), renderLayoutBody(template.layout, view), pageTitle);
}

/** A starting point for an HTML template, using the preset's labels and palette. */
export function starterHtml(presetId: string): string {
  const p = getPreset(presetId);
  const c = paletteById(p.paletteId);
  return `<style>
  .page { font-family: Helvetica, Arial, sans-serif; color: ${c.text}; padding: 32px; font-size: 13px; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 4px solid ${c.primary}; padding-bottom: 16px; }
  .top img { max-height: 60px; }
  h1 { color: ${c.primary}; margin: 0; font-size: 28px; }
  .muted { color: ${c.muted}; }
  .cols { display: flex; gap: 32px; margin: 20px 0; }
  .cols > div { flex: 1; }
  table { width: 100%; border-collapse: collapse; }
  th { background: ${c.surface}; color: ${c.primary}; text-align: left; padding: 8px; font-size: 11px; text-transform: uppercase; }
  td { padding: 8px; border-bottom: 1px solid ${c.border}; }
  .n { text-align: right; }
  .total { font-size: 16px; font-weight: bold; color: ${c.primary}; }
  .sig img { max-height: 64px; }
</style>
<div class="page">
  <div class="top">
    <div>
      {{#logo}}<img src="{{logo}}" alt="Logo">{{/logo}}
      <div style="font-size:18px;font-weight:bold">{{seller.name}}</div>
      {{#seller.taxId}}<div>{{labels.taxId}}: {{seller.taxId}}</div>{{/seller.taxId}}
    </div>
    <div style="text-align:right">
      <h1>{{title}}</h1>
      <div>No. {{doc.number}}</div>
      <div class="muted">Date {{doc.issueDate}} · Due {{doc.dueDate}}</div>
      {{#doc.isDraft}}<div style="color:#b91c1c;font-weight:bold">DRAFT</div>{{/doc.isDraft}}
    </div>
  </div>

  <div class="cols">
    <div>
      <div class="muted">Bill to</div>
      <strong>{{buyer.name}}</strong><br>
      {{buyer.address}}<br>
      {{#buyer.taxId}}{{labels.taxId}}: {{buyer.taxId}}{{/buyer.taxId}}
    </div>
    <div>
      {{#doc.reference}}<div>Reference: {{doc.reference}}</div>{{/doc.reference}}
      {{#doc.placeOfSupply}}<div>Place of supply: {{doc.placeOfSupply}}</div>{{/doc.placeOfSupply}}
      {{#doc.irn}}<div class="muted">IRN {{doc.irn}}</div>{{/doc.irn}}
    </div>
  </div>

  <table>
    <thead><tr><th>#</th><th>Description</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">${escapeHtml(p.taxLabel)}</th><th class="n">Amount</th></tr></thead>
    <tbody>
      {{#lines}}<tr><td>{{no}}</td><td>{{description}}</td><td class="n">{{quantity}}</td><td class="n">{{unitPrice}}</td><td class="n">{{taxAmount}}</td><td class="n">{{amount}}</td></tr>{{/lines}}
    </tbody>
  </table>

  <table style="width:45%;margin-left:auto;margin-top:12px">
    <tr><td>Subtotal</td><td class="n">{{totals.subtotal}}</td></tr>
    <tr><td>{{labels.tax}}</td><td class="n">{{totals.tax}}</td></tr>
    <tr class="total"><td>Total {{doc.currency}}</td><td class="n">{{totals.total}}</td></tr>
  </table>
  <p class="muted"><em>{{amountInWords}}</em></p>

  <div class="sig" style="text-align:right;margin-top:32px">
    {{#signature}}<img src="{{image}}" alt="Signature"><div>{{name}}{{#designation}}, {{designation}}{{/designation}}</div><div class="muted">E-signed {{signedAt}}</div>{{/signature}}
    {{^signature}}<div style="height:60px"></div><div>Authorised signatory</div>{{/signature}}
  </div>
</div>
`;
}

// ---------------------------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------------------------

/**
 * The text whose SHA-256 is recorded when an invoice is signed: the facts that make the invoice,
 * in a fixed order. If any of them changes later the hash no longer matches.
 */
export function canonicalInvoiceContent(input: {
  documentId: string;
  orgId: string;
  kind: string;
  number: string | null;
  issueDate: string;
  dueDate: string;
  currency: string;
  contactName: string;
  contactTaxId: string | null;
  lines: { description: string | null; quantity: string; unitPrice: string; taxRate: string; netAmount: string; taxAmount: string }[];
  subtotal: string;
  taxTotal: string;
  total: string;
}): string {
  const n = (v: string) => dec(v).toFixed(6);
  return JSON.stringify([
    'talk2tax-invoice-v1',
    input.orgId,
    input.documentId,
    input.kind,
    input.number ?? '',
    input.issueDate.slice(0, 10),
    input.dueDate.slice(0, 10),
    input.currency,
    input.contactName,
    input.contactTaxId ?? '',
    input.lines.map((l) => [l.description ?? '', n(l.quantity), n(l.unitPrice), n(l.taxRate), n(l.netAmount), n(l.taxAmount)]),
    n(input.subtotal),
    n(input.taxTotal),
    n(input.total),
  ]);
}

export type SignatureKind = 'DRAWN' | 'UPLOADED' | 'TYPED';
export const MAX_SIGNATURE_BYTES = 300_000;
export const MAX_LOGO_BYTES = 500_000;

/** Image type from its first bytes: PNG, JPEG or WebP (SVG is refused: it can carry script). */
export function sniffImageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length > 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
