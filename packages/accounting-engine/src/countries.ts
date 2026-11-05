/**
 * Country modules: what Talk2Tax supports for each country, at what level, what it does not do,
 * and where its rules come from. The directive forbids claiming compliance without a verified,
 * maintained module, so every country says plainly what level it is at:
 *
 * - FULL: the country's tax engine is built and tested here (India). Still not a substitute for
 *   professional advice; reviews outstanding are listed in its limitations.
 * - STARTER: accounting works, and standard sales-tax rates can be added as ordinary tax rates
 *   to start with. There are no returns, filings, e-invoicing, payroll or rule checks, and the
 *   rates must be confirmed by the organisation before use.
 * - ACCOUNTING_ONLY: accounting works; the country's sales tax is not modelled at all (for
 *   example United States sales tax, which is set by states and local areas).
 *
 * Rates are the standard national rates as published by each tax authority, checked when the
 * module was last reviewed (`reviewedOn`). They change; the organisation must confirm them.
 */

export const MODULE_LEVELS = ['FULL', 'STARTER', 'ACCOUNTING_ONLY'] as const;
export type ModuleLevel = (typeof MODULE_LEVELS)[number];

export const CAPABILITY_KEYS = ['ACCOUNTING', 'SALES_TAX_RATES', 'SALES_TAX_RETURNS', 'WITHHOLDING', 'E_INVOICING', 'TRANSPORT_DOCUMENTS', 'PAYROLL', 'COMPLIANCE_CALENDAR', 'INVOICE_PRESET'] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  ACCOUNTING: 'Double-entry accounting, reports and planning',
  SALES_TAX_RATES: 'Sales tax rates',
  SALES_TAX_RETURNS: 'Sales tax returns',
  WITHHOLDING: 'Tax withheld at source',
  E_INVOICING: 'Electronic invoicing',
  TRANSPORT_DOCUMENTS: 'Transport documents',
  PAYROLL: 'Payroll calculations',
  COMPLIANCE_CALENDAR: 'Filing and payment calendar',
  INVOICE_PRESET: 'Invoice layout for the country',
};

export type CapabilityStatus = 'SUPPORTED' | 'PARTLY' | 'STARTER' | 'NOT_SUPPORTED';
export interface Capability {
  key: CapabilityKey;
  status: CapabilityStatus;
  /** What exactly is covered, or why not. */
  note: string;
}

export interface StarterRate {
  /** Unique within the country; also the name the tax rate is created with. */
  name: string;
  /** Percent, as a decimal string. */
  rate: string;
  note: string;
}

export interface CountryModule {
  code: string;
  name: string;
  currency: string;
  /** Usual first month of the financial year (1-12); the organisation can choose another. */
  fiscalYearStartMonth: number;
  level: ModuleLevel;
  /** The sales tax, as the country names it. */
  salesTaxName: string | null;
  /** The tax number's name, such as GSTIN or VAT number. */
  taxIdName: string | null;
  summary: string;
  capabilities: Capability[];
  starterRates: StarterRate[];
  limitations: string[];
  sources: { title: string; url: string }[];
  /** When the rules and rates in this module were last checked (YYYY-MM-DD). */
  reviewedOn: string;
}

const accounting: Capability = { key: 'ACCOUNTING', status: 'SUPPORTED', note: 'Ledger, sales, purchases, banking, reports, budgets, forecasts and the planning tools work in any country and currency.' };
const none = (key: CapabilityKey, note: string): Capability => ({ key, status: 'NOT_SUPPORTED', note });
const starterCaps = (tax: string, extra: Capability[] = []): Capability[] => [
  accounting,
  { key: 'SALES_TAX_RATES', status: 'STARTER', note: `Standard ${tax} rates can be added as ordinary tax rates on invoices and bills, posting to Output Tax Payable and Input Tax Receivable. No rules about which rate applies are checked.` },
  none('SALES_TAX_RETURNS', `No ${tax} return is prepared or filed.`),
  none('WITHHOLDING', 'Not modelled.'),
  none('E_INVOICING', 'Not connected to any national e-invoicing system.'),
  none('TRANSPORT_DOCUMENTS', 'Not modelled.'),
  none('PAYROLL', 'No payroll calculations for this country.'),
  none('COMPLIANCE_CALENDAR', 'No filing or payment due dates are generated.'),
  ...extra,
];

export const COUNTRY_MODULES: readonly CountryModule[] = Object.freeze([
  {
    code: 'IN',
    name: 'India',
    currency: 'INR',
    fiscalYearStartMonth: 4,
    level: 'FULL',
    salesTaxName: 'GST',
    taxIdName: 'GSTIN',
    summary: 'Built and tested here: GST with returns, TDS and TCS, payroll, e-invoicing, e-way bills and the compliance calendar.',
    capabilities: [
      accounting,
      { key: 'SALES_TAX_RATES', status: 'SUPPORTED', note: 'GST rates with CGST, SGST and IGST by place of supply, reverse charge, nil-rated, exempt and non-GST supplies.' },
      { key: 'SALES_TAX_RETURNS', status: 'SUPPORTED', note: 'GSTR-1 and GSTR-3B prepared from the books, with JSON for the GST portal; filing on the portal is done by you.' },
      { key: 'WITHHOLDING', status: 'SUPPORTED', note: 'TDS and TCS by section, thresholds and PAN rules, deposits and certificates data.' },
      { key: 'E_INVOICING', status: 'PARTLY', note: 'IRN requests through a GSP; works once your GSP credentials are added under Integrations.' },
      { key: 'TRANSPORT_DOCUMENTS', status: 'PARTLY', note: 'E-way bills through a GSP; works once your GSP credentials are added under Integrations.' },
      { key: 'PAYROLL', status: 'PARTLY', note: 'Salary, PF, ESI, professional tax and TDS on salary; not yet reviewed by a payroll professional.' },
      { key: 'COMPLIANCE_CALENDAR', status: 'SUPPORTED', note: 'GST, TDS, PF, ESI and advance tax due dates from your settings.' },
      { key: 'INVOICE_PRESET', status: 'SUPPORTED', note: 'Tax invoice layout with GSTIN, place of supply and HSN/SAC.' },
    ],
    starterRates: [],
    limitations: [
      'Payroll rules are not yet reviewed by a payroll professional; Maharashtra professional tax slabs come from a secondary source.',
      'E-invoicing and e-way bills need your own GSP account; until it is added they are prepared but not sent.',
      'Returns are prepared, not filed: filing on the GST and TRACES portals is done by you.',
      'Not professional tax advice. Rules change; check notifications and circulars that affect you.',
    ],
    sources: [
      { title: 'GST Council and CBIC: GST rates and notifications', url: 'https://cbic-gst.gov.in' },
      { title: 'GST portal: returns and e-invoice schema', url: 'https://www.gst.gov.in' },
      { title: 'Income Tax Department: TDS and TCS', url: 'https://www.incometax.gov.in' },
      { title: 'EPFO and ESIC: contribution rules', url: 'https://www.epfindia.gov.in' },
    ],
    reviewedOn: '2026-11-02',
  },
  {
    code: 'AE',
    name: 'United Arab Emirates',
    currency: 'AED',
    fiscalYearStartMonth: 1,
    level: 'STARTER',
    salesTaxName: 'VAT',
    taxIdName: 'TRN',
    summary: 'Accounting, a UAE tax invoice layout, and starter VAT rates. No VAT return or e-invoicing.',
    capabilities: starterCaps('VAT', [{ key: 'INVOICE_PRESET', status: 'SUPPORTED', note: 'Tax invoice layout with TRN.' }]),
    starterRates: [
      { name: 'VAT 5%', rate: '5', note: 'Standard rate.' },
      { name: 'VAT 0% (zero-rated)', rate: '0', note: 'Zero-rated supplies such as exports; which supplies qualify is not checked.' },
    ],
    limitations: ['No VAT return, reverse charge, designated zones or excise tax.', 'Corporate tax is not modelled.', 'Not connected to the UAE e-invoicing programme.'],
    sources: [{ title: 'Federal Tax Authority: VAT', url: 'https://tax.gov.ae' }],
    reviewedOn: '2026-11-05',
  },
  {
    code: 'GB',
    name: 'United Kingdom',
    currency: 'GBP',
    fiscalYearStartMonth: 4,
    level: 'STARTER',
    salesTaxName: 'VAT',
    taxIdName: 'VAT number',
    summary: 'Accounting, a UK VAT invoice layout, and starter VAT rates. No VAT return or Making Tax Digital submission.',
    capabilities: starterCaps('VAT', [{ key: 'INVOICE_PRESET', status: 'SUPPORTED', note: 'VAT invoice layout with VAT number.' }]),
    starterRates: [
      { name: 'VAT 20% (standard)', rate: '20', note: 'Standard rate.' },
      { name: 'VAT 5% (reduced)', rate: '5', note: 'Reduced rate for some goods and services; which ones qualify is not checked.' },
      { name: 'VAT 0% (zero-rated)', rate: '0', note: 'Zero-rated goods and services; which ones qualify is not checked.' },
    ],
    limitations: ['No VAT return or Making Tax Digital submission.', 'No flat-rate, cash or margin schemes, and no domestic reverse charge.', 'No PAYE payroll.'],
    sources: [{ title: 'GOV.UK: VAT rates', url: 'https://www.gov.uk/vat-rates' }],
    reviewedOn: '2026-11-05',
  },
  {
    code: 'SG',
    name: 'Singapore',
    currency: 'SGD',
    fiscalYearStartMonth: 1,
    level: 'STARTER',
    salesTaxName: 'GST',
    taxIdName: 'GST registration number',
    summary: 'Accounting, a Singapore GST tax invoice layout, and starter GST rates. No GST return or InvoiceNow.',
    capabilities: starterCaps('GST', [{ key: 'INVOICE_PRESET', status: 'SUPPORTED', note: 'GST tax invoice layout with GST registration number.' }]),
    starterRates: [
      { name: 'GST 9% (standard)', rate: '9', note: 'Standard rate.' },
      { name: 'GST 0% (zero-rated)', rate: '0', note: 'Zero-rated supplies such as exports; which supplies qualify is not checked.' },
    ],
    limitations: ['No GST F5 return, reverse charge or InvoiceNow (Peppol).', 'No CPF payroll.'],
    sources: [{ title: 'IRAS: GST rate', url: 'https://www.iras.gov.sg/taxes/goods-services-tax-(gst)' }],
    reviewedOn: '2026-11-05',
  },
  {
    code: 'AU',
    name: 'Australia',
    currency: 'AUD',
    fiscalYearStartMonth: 7,
    level: 'STARTER',
    salesTaxName: 'GST',
    taxIdName: 'ABN',
    summary: 'Accounting, an Australian tax invoice layout, and starter GST rates. No BAS or Single Touch Payroll.',
    capabilities: starterCaps('GST', [{ key: 'INVOICE_PRESET', status: 'SUPPORTED', note: 'Tax invoice layout with ABN.' }]),
    starterRates: [
      { name: 'GST 10%', rate: '10', note: 'Standard rate.' },
      { name: 'GST-free 0%', rate: '0', note: 'GST-free supplies; which ones qualify is not checked.' },
    ],
    limitations: ['No BAS, PAYG withholding or Single Touch Payroll.', 'No Peppol e-invoicing.'],
    sources: [{ title: 'Australian Taxation Office: GST', url: 'https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst' }],
    reviewedOn: '2026-11-05',
  },
  {
    code: 'DE',
    name: 'Germany',
    currency: 'EUR',
    fiscalYearStartMonth: 1,
    level: 'STARTER',
    salesTaxName: 'VAT (Umsatzsteuer)',
    taxIdName: 'USt-IdNr.',
    summary: 'Accounting, an EU VAT invoice layout, and starter VAT rates. No VAT return, ELSTER or XRechnung.',
    capabilities: starterCaps('VAT', [{ key: 'INVOICE_PRESET', status: 'PARTLY', note: 'Generic EU VAT invoice layout; not checked against German invoice requirements.' }]),
    starterRates: [
      { name: 'USt 19% (standard)', rate: '19', note: 'Standard rate.' },
      { name: 'USt 7% (reduced)', rate: '7', note: 'Reduced rate for some goods and services; which ones qualify is not checked.' },
      { name: 'USt 0%', rate: '0', note: 'Tax-free or reverse-charge supplies; which ones qualify is not checked.' },
    ],
    limitations: ['No VAT return (UStVA) or ELSTER submission.', 'No EU reverse charge, OSS or recapitulative statement.', 'No XRechnung or ZUGFeRD e-invoices.', 'No German payroll.'],
    sources: [{ title: 'Bundesministerium der Finanzen: Umsatzsteuer', url: 'https://www.bundesfinanzministerium.de' }],
    reviewedOn: '2026-11-05',
  },
  {
    code: 'CA',
    name: 'Canada',
    currency: 'CAD',
    fiscalYearStartMonth: 1,
    level: 'STARTER',
    salesTaxName: 'GST',
    taxIdName: 'Business number',
    summary: 'Accounting and the federal GST rate only. Provincial HST, PST and QST are not modelled.',
    capabilities: starterCaps('GST', [none('INVOICE_PRESET', 'Use the generic invoice layout.')]),
    starterRates: [
      { name: 'GST 5% (federal)', rate: '5', note: 'Federal GST only. Provinces with HST, PST or QST need their own rates, which are not provided.' },
      { name: 'GST 0% (zero-rated)', rate: '0', note: 'Zero-rated supplies; which ones qualify is not checked.' },
    ],
    limitations: ['Federal GST only: provincial HST, PST and QST are not modelled.', 'No GST/HST return.', 'No Canadian payroll.'],
    sources: [{ title: 'Canada Revenue Agency: GST/HST rates', url: 'https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate.html' }],
    reviewedOn: '2026-11-05',
  },
  {
    code: 'US',
    name: 'United States',
    currency: 'USD',
    fiscalYearStartMonth: 1,
    level: 'ACCOUNTING_ONLY',
    salesTaxName: 'Sales tax',
    taxIdName: 'EIN',
    summary: 'Accounting and a US invoice layout. Sales tax is set by states and local areas and is not modelled; no rates are suggested.',
    capabilities: [
      accounting,
      none('SALES_TAX_RATES', 'Sales tax depends on the state, county and city, and on nexus; no rates are suggested. You can add your own tax rates.'),
      none('SALES_TAX_RETURNS', 'No sales tax returns.'),
      none('WITHHOLDING', 'No 1099 or backup withholding.'),
      none('E_INVOICING', 'Not applicable.'),
      none('TRANSPORT_DOCUMENTS', 'Not modelled.'),
      none('PAYROLL', 'No US payroll.'),
      none('COMPLIANCE_CALENDAR', 'No filing or payment due dates are generated.'),
      { key: 'INVOICE_PRESET', status: 'SUPPORTED', note: 'US invoice layout.' },
    ],
    starterRates: [],
    limitations: ['Sales tax, use tax and nexus are not modelled.', 'No federal or state payroll, 1099s or income tax.'],
    sources: [{ title: 'IRS: small business and self-employed', url: 'https://www.irs.gov/businesses/small-businesses-self-employed' }],
    reviewedOn: '2026-11-05',
  },
] as CountryModule[]);

/** A country without a module of its own: accounting only. */
export function genericModule(code: string): CountryModule {
  return {
    code,
    name: code,
    currency: '',
    fiscalYearStartMonth: 1,
    level: 'ACCOUNTING_ONLY',
    salesTaxName: null,
    taxIdName: null,
    summary: 'No country module yet: accounting works, and you can add your own tax rates. Nothing about this country’s tax rules is checked.',
    capabilities: [accounting, ...CAPABILITY_KEYS.filter((k) => k !== 'ACCOUNTING').map((k) => none(k, 'No country module yet.'))],
    starterRates: [],
    limitations: ['No country module: no tax rules, returns, payroll or due dates for this country.'],
    sources: [],
    reviewedOn: '',
  };
}

export function countryModule(code: string): CountryModule {
  return COUNTRY_MODULES.find((m) => m.code === code) ?? genericModule(code);
}

/** Whether a capability is usable in this country (fully or partly), for showing or hiding its pages. */
export function countrySupports(code: string, key: CapabilityKey): boolean {
  const c = countryModule(code).capabilities.find((x) => x.key === key);
  return !!c && (c.status === 'SUPPORTED' || c.status === 'PARTLY');
}

/**
 * Which starter rates to create: those not already present by name. Returns the ones to add and
 * the ones skipped, with why.
 */
export function plannedStarterRates(code: string, existingNames: readonly string[], chosen?: readonly string[]) {
  const m = countryModule(code);
  if (m.level !== 'STARTER') return { add: [] as StarterRate[], skipped: [] as { name: string; reason: string }[], refused: m.level === 'FULL' ? `${m.name} has its own tax engine; set up ${m.salesTaxName} in its settings instead.` : `${m.name} has no starter rates.` };
  const have = new Set(existingNames.map((n) => n.trim().toLowerCase()));
  const pick = chosen ? m.starterRates.filter((r) => chosen.includes(r.name)) : m.starterRates;
  const unknown = (chosen ?? []).filter((c) => !m.starterRates.some((r) => r.name === c));
  const add: StarterRate[] = [];
  const skipped: { name: string; reason: string }[] = unknown.map((name) => ({ name, reason: 'Not a starter rate for this country' }));
  for (const r of pick) (have.has(r.name.toLowerCase()) ? skipped.push({ name: r.name, reason: 'A tax rate with this name already exists' }) : add.push(r));
  return { add, skipped, refused: null as string | null };
}
