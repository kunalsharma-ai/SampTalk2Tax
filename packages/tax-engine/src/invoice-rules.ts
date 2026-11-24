import { D } from '@talk2tax/accounting-engine';

/**
 * Country-specific invoice formats (TAX-039) and electronic invoicing requirements (TAX-040).
 *
 * For each country Talk2Tax keeps a VAT or GST module for, what a sales invoice must show, by the
 * size of the sale (the UK, Germany, Singapore and the UAE allow a simplified invoice for small sales;
 * Australia and Canada ask for more as the sale grows), and when the country requires invoices to be
 * issued or received electronically. Each rule names the provision it comes from and the date the
 * entry was last checked. Countries not listed here are not covered (TAX-042): the page says so
 * rather than guess. Talk2Tax never sends an invoice to a government system or network (TAX-027).
 */

export type InvoiceRequirementKey =
  | 'TITLE'
  | 'NUMBER'
  | 'ISSUE_DATE'
  | 'SELLER_TAX_NUMBER'
  | 'SELLER_ADDRESS'
  | 'BUYER_NAME'
  | 'BUYER_ADDRESS'
  | 'BUYER_TAX_NUMBER'
  | 'DESCRIPTIONS'
  | 'QUANTITIES'
  | 'TAX_RATES'
  | 'HSN_CODES'
  | 'PLACE_OF_SUPPLY'
  | 'REVERSE_CHARGE_WORDING';

/** When an item is needed only for some invoices. */
export type InvoiceRequirementWhen = 'BUYER_REGISTERED' | 'REVERSE_CHARGE' | 'INTERSTATE';

export const INVOICE_REQUIREMENT_LABEL: Readonly<Record<InvoiceRequirementKey, string>> = {
  TITLE: 'The required document title',
  NUMBER: 'A unique invoice number',
  ISSUE_DATE: 'The date of issue',
  SELLER_TAX_NUMBER: 'Your tax registration number',
  SELLER_ADDRESS: 'Your business address',
  BUYER_NAME: "The customer's name",
  BUYER_ADDRESS: "The customer's address",
  BUYER_TAX_NUMBER: "The customer's tax registration number",
  DESCRIPTIONS: 'A description of each item',
  QUANTITIES: 'The quantity of each item',
  TAX_RATES: 'The tax rate on each item',
  HSN_CODES: 'The HSN or SAC code on each line',
  PLACE_OF_SUPPLY: 'The place of supply',
  REVERSE_CHARGE_WORDING: 'A statement that the reverse charge applies',
};

/** How to put each item right in Talk2Tax. */
export const INVOICE_REQUIREMENT_FIX: Readonly<Record<InvoiceRequirementKey, string>> = {
  TITLE: 'Change the title of the invoice template the invoice prints with (Settings, Invoice templates).',
  NUMBER: 'Post the invoice: Talk2Tax gives it the next number in the sequence.',
  ISSUE_DATE: 'Every invoice has an issue date.',
  SELLER_TAX_NUMBER: 'Add your registration number under the VAT or GST return settings (or the GST registration in India).',
  SELLER_ADDRESS: 'Type your address into the Header section of the invoice template (or the e-invoicing settings in India).',
  BUYER_NAME: "Every contact has a name; check it is the customer's legal or trading name.",
  BUYER_ADDRESS: "Add the customer's address on their contact page.",
  BUYER_TAX_NUMBER: "Add the customer's VAT or GST number on their contact page.",
  DESCRIPTIONS: 'Give every line a description.',
  QUANTITIES: 'Give every line a quantity above zero.',
  TAX_RATES: 'Choose a tax rate on every line (a zero or exempt rate counts).',
  HSN_CODES: 'Add the HSN or SAC code to every line.',
  PLACE_OF_SUPPLY: 'Set the place of supply on the invoice.',
  REVERSE_CHARGE_WORDING: 'Mark the invoice as reverse charge so the wording prints on it.',
};

export interface InvoiceRequirement {
  key: InvoiceRequirementKey;
  when?: InvoiceRequirementWhen;
}

export interface InvoiceFormatTier {
  /** The name of the document at this size, such as Simplified VAT invoice. */
  name: string;
  /** The tier applies when the total including tax is above this amount (or at least it, with fromInclusive). */
  from: string;
  fromInclusive?: boolean;
  /** Only when the customer is registered for the tax (the UAE's full tax invoice). */
  registeredBuyerOnly?: boolean;
  items: InvoiceRequirement[];
}

export interface InvoiceFormatRule {
  country: string;
  countryName: string;
  currency: string;
  /** The words the title must include, compared without case, or null when no title is required. */
  titleWords: string | null;
  /** Lowest tier first; the last tier that applies is used. */
  tiers: InvoiceFormatTier[];
  /** Required items Talk2Tax cannot check from the books, said on the page. */
  alsoRequired: string[];
  source: string;
  checkedOn: string;
}

const CHECKED_ON = '2026-11-24';

const r = (key: InvoiceRequirementKey, when?: InvoiceRequirementWhen): InvoiceRequirement => (when ? { key, when } : { key });

export const INVOICE_FORMAT_RULES: readonly InvoiceFormatRule[] = [
  {
    country: 'IN',
    countryName: 'India',
    currency: 'INR',
    titleWords: 'tax invoice',
    tiers: [
      {
        name: 'Tax invoice',
        from: '0',
        items: [
          r('TITLE'),
          r('NUMBER'),
          r('ISSUE_DATE'),
          r('SELLER_TAX_NUMBER'),
          r('SELLER_ADDRESS'),
          r('BUYER_NAME'),
          r('BUYER_ADDRESS', 'BUYER_REGISTERED'),
          r('BUYER_TAX_NUMBER', 'BUYER_REGISTERED'),
          r('HSN_CODES', 'BUYER_REGISTERED'),
          r('DESCRIPTIONS'),
          r('QUANTITIES'),
          r('TAX_RATES'),
          r('PLACE_OF_SUPPLY', 'INTERSTATE'),
          r('REVERSE_CHARGE_WORDING', 'REVERSE_CHARGE'),
        ],
      },
      {
        name: 'Tax invoice (unregistered customer, Rs 50,000 or more)',
        from: '50000',
        fromInclusive: true,
        items: [
          r('TITLE'),
          r('NUMBER'),
          r('ISSUE_DATE'),
          r('SELLER_TAX_NUMBER'),
          r('SELLER_ADDRESS'),
          r('BUYER_NAME'),
          r('BUYER_ADDRESS'),
          r('BUYER_TAX_NUMBER', 'BUYER_REGISTERED'),
          r('HSN_CODES', 'BUYER_REGISTERED'),
          r('DESCRIPTIONS'),
          r('QUANTITIES'),
          r('TAX_RATES'),
          r('PLACE_OF_SUPPLY'),
          r('REVERSE_CHARGE_WORDING', 'REVERSE_CHARGE'),
        ],
      },
    ],
    alsoRequired: [
      'A serial number of at most 16 characters, unique for the financial year',
      'The signature or digital signature of the supplier (not needed on an e-invoice with an IRN)',
      'The delivery address where it differs from the place of supply',
    ],
    source: 'CGST Rules 2017, rule 46',
    checkedOn: CHECKED_ON,
  },
  {
    country: 'GB',
    countryName: 'the United Kingdom',
    currency: 'GBP',
    titleWords: null,
    tiers: [
      { name: 'Simplified VAT invoice', from: '0', items: [r('SELLER_ADDRESS'), r('SELLER_TAX_NUMBER'), r('ISSUE_DATE'), r('DESCRIPTIONS'), r('TAX_RATES')] },
      {
        name: 'Full VAT invoice',
        from: '250',
        items: [
          r('NUMBER'),
          r('ISSUE_DATE'),
          r('SELLER_ADDRESS'),
          r('SELLER_TAX_NUMBER'),
          r('BUYER_NAME'),
          r('BUYER_ADDRESS'),
          r('DESCRIPTIONS'),
          r('QUANTITIES'),
          r('TAX_RATES'),
          r('REVERSE_CHARGE_WORDING', 'REVERSE_CHARGE'),
        ],
      },
    ],
    alsoRequired: ['The time of supply (tax point) where it differs from the invoice date', 'The total VAT in sterling when the invoice is in another currency (Talk2Tax prints it)'],
    source: 'HMRC VAT Notice 700/21, section 4 (simplified invoices up to £250 including VAT)',
    checkedOn: CHECKED_ON,
  },
  {
    country: 'DE',
    countryName: 'Germany',
    currency: 'EUR',
    titleWords: null,
    tiers: [
      { name: 'Kleinbetragsrechnung (small-amount invoice)', from: '0', items: [r('SELLER_ADDRESS'), r('ISSUE_DATE'), r('DESCRIPTIONS'), r('QUANTITIES'), r('TAX_RATES')] },
      {
        name: 'Rechnung (full invoice)',
        from: '250',
        items: [
          r('NUMBER'),
          r('ISSUE_DATE'),
          r('SELLER_ADDRESS'),
          r('SELLER_TAX_NUMBER'),
          r('BUYER_NAME'),
          r('BUYER_ADDRESS'),
          r('DESCRIPTIONS'),
          r('QUANTITIES'),
          r('TAX_RATES'),
          r('BUYER_TAX_NUMBER', 'REVERSE_CHARGE'),
          r('REVERSE_CHARGE_WORDING', 'REVERSE_CHARGE'),
        ],
      },
    ],
    alsoRequired: ['The date of supply (or the month of supply)', 'Any agreed reduction of the price not already included', 'A note giving the reason where an exemption applies'],
    source: 'UStG §14 Abs. 4 and §14a; UStDV §33 (small-amount invoices up to €250 gross)',
    checkedOn: CHECKED_ON,
  },
  {
    country: 'AE',
    countryName: 'the United Arab Emirates',
    currency: 'AED',
    titleWords: 'tax invoice',
    tiers: [
      { name: 'Simplified tax invoice', from: '0', items: [r('TITLE'), r('NUMBER'), r('ISSUE_DATE'), r('SELLER_ADDRESS'), r('SELLER_TAX_NUMBER'), r('DESCRIPTIONS'), r('TAX_RATES')] },
      {
        name: 'Tax invoice',
        from: '10000',
        registeredBuyerOnly: true,
        items: [
          r('TITLE'),
          r('NUMBER'),
          r('ISSUE_DATE'),
          r('SELLER_ADDRESS'),
          r('SELLER_TAX_NUMBER'),
          r('BUYER_NAME'),
          r('BUYER_ADDRESS'),
          r('BUYER_TAX_NUMBER'),
          r('DESCRIPTIONS'),
          r('QUANTITIES'),
          r('TAX_RATES'),
          r('REVERSE_CHARGE_WORDING', 'REVERSE_CHARGE'),
        ],
      },
    ],
    alsoRequired: ['The date of supply where it differs from the date of issue', 'The tax in AED, with the exchange rate, when the invoice is in another currency (Talk2Tax prints it)'],
    source: 'Federal Decree-Law No. 8 of 2017 on VAT, Executive Regulation Article 59 (simplified tax invoice for unregistered customers or up to AED 10,000)',
    checkedOn: CHECKED_ON,
  },
  {
    country: 'SG',
    countryName: 'Singapore',
    currency: 'SGD',
    titleWords: 'tax invoice',
    tiers: [
      { name: 'Simplified tax invoice', from: '0', items: [r('NUMBER'), r('ISSUE_DATE'), r('SELLER_ADDRESS'), r('SELLER_TAX_NUMBER'), r('DESCRIPTIONS')] },
      {
        name: 'Tax invoice',
        from: '1000',
        items: [r('TITLE'), r('NUMBER'), r('ISSUE_DATE'), r('SELLER_ADDRESS'), r('SELLER_TAX_NUMBER'), r('BUYER_NAME'), r('BUYER_ADDRESS'), r('DESCRIPTIONS'), r('TAX_RATES')],
      },
    ],
    alsoRequired: ['On a simplified tax invoice, the words "Price Payable includes GST"', 'The GST in SGD when the invoice is in another currency (Talk2Tax prints it)'],
    source: 'GST (General) Regulations, regulation 11; IRAS e-Tax Guide "General Guide for Businesses" (simplified tax invoice up to S$1,000)',
    checkedOn: CHECKED_ON,
  },
  {
    country: 'AU',
    countryName: 'Australia',
    currency: 'AUD',
    titleWords: 'tax invoice',
    tiers: [
      { name: 'No tax invoice needed (A$82.50 or less, unless the customer asks)', from: '0', items: [] },
      { name: 'Tax invoice', from: '82.5', items: [r('TITLE'), r('SELLER_TAX_NUMBER'), r('ISSUE_DATE'), r('DESCRIPTIONS'), r('QUANTITIES'), r('TAX_RATES')] },
      {
        name: 'Tax invoice (A$1,000 or more)',
        from: '1000',
        fromInclusive: true,
        items: [r('TITLE'), r('SELLER_TAX_NUMBER'), r('ISSUE_DATE'), r('BUYER_NAME'), r('DESCRIPTIONS'), r('QUANTITIES'), r('TAX_RATES')],
      },
    ],
    alsoRequired: ["The seller's identity (name or business name)", 'The extent to which each sale is taxable, where some items are GST-free'],
    source: 'A New Tax System (Goods and Services Tax) Act 1999, section 29-70; ATO "Tax invoices"',
    checkedOn: CHECKED_ON,
  },
  {
    country: 'CA',
    countryName: 'Canada',
    currency: 'CAD',
    titleWords: null,
    tiers: [
      { name: 'Receipt (under $30)', from: '0', items: [r('ISSUE_DATE')] },
      { name: 'Invoice ($30 to $149.99)', from: '30', fromInclusive: true, items: [r('ISSUE_DATE'), r('SELLER_TAX_NUMBER'), r('TAX_RATES')] },
      { name: 'Invoice ($150 or more)', from: '150', fromInclusive: true, items: [r('ISSUE_DATE'), r('SELLER_TAX_NUMBER'), r('TAX_RATES'), r('BUYER_NAME'), r('DESCRIPTIONS')] },
    ],
    alsoRequired: ["The seller's business or trading name", 'The terms of payment on invoices of $150 or more (Talk2Tax prints the due date)'],
    source: 'Input Tax Credit Information (GST/HST) Regulations, section 3',
    checkedOn: CHECKED_ON,
  },
];

export function invoiceFormatRule(country: string): InvoiceFormatRule | null {
  const code = country.toUpperCase();
  return INVOICE_FORMAT_RULES.find((x) => x.country === code) ?? null;
}

/** One invoice as the books and its template hold it. Amounts in the books' currency. */
export interface InvoiceContentFacts {
  /** Total including tax, in the country's currency. */
  grossLocal: string;
  numbered: boolean;
  title: string;
  sellerTaxNumber: string | null;
  sellerAddress: boolean;
  buyerName: string;
  buyerAddress: boolean;
  buyerTaxNumber: string | null;
  reverseCharge: boolean;
  /** India: the place of supply differs from the supplier's state. */
  interstate: boolean;
  placeOfSupply: string | null;
  lines: { description: string | null; quantity: string; taxRateChosen: boolean; hsnCode: string | null }[];
}

export interface InvoiceContentGap {
  key: InvoiceRequirementKey;
  label: string;
  fix: string;
  /** Line numbers (from 1) for line items. */
  lines?: number[];
}

/** The tier an invoice falls in. */
export function invoiceFormatTier(rule: InvoiceFormatRule, grossLocal: string, buyerRegistered: boolean): InvoiceFormatTier {
  const gross = new D(grossLocal).abs();
  let chosen = rule.tiers[0]!;
  for (const t of rule.tiers) {
    const above = t.fromInclusive ? gross.gte(t.from) : gross.gt(t.from);
    if (above && (!t.registeredBuyerOnly || buyerRegistered)) chosen = t;
  }
  return chosen;
}

/** What a sales invoice is missing under its country's rule. */
export function checkInvoiceContent(rule: InvoiceFormatRule, f: InvoiceContentFacts): { tier: string; required: InvoiceRequirementKey[]; gaps: InvoiceContentGap[] } {
  const buyerRegistered = !!f.buyerTaxNumber?.trim();
  const tier = invoiceFormatTier(rule, f.grossLocal, buyerRegistered);
  const applies = (it: InvoiceRequirement) => !it.when || (it.when === 'BUYER_REGISTERED' ? buyerRegistered : it.when === 'REVERSE_CHARGE' ? f.reverseCharge : f.interstate);
  const required = tier.items.filter(applies).map((it) => it.key);
  const linesWhere = (bad: (l: InvoiceContentFacts['lines'][number]) => boolean) => f.lines.flatMap((l, i) => (bad(l) ? [i + 1] : []));
  const gaps: InvoiceContentGap[] = [];
  const gap = (key: InvoiceRequirementKey, lines?: number[]) => gaps.push({ key, label: INVOICE_REQUIREMENT_LABEL[key], fix: INVOICE_REQUIREMENT_FIX[key], ...(lines ? { lines } : {}) });
  for (const key of required) {
    switch (key) {
      case 'TITLE':
        if (rule.titleWords && !f.title.toLowerCase().includes(rule.titleWords)) gap(key);
        break;
      case 'NUMBER':
        if (!f.numbered) gap(key);
        break;
      case 'ISSUE_DATE':
        break;
      case 'SELLER_TAX_NUMBER':
        if (!f.sellerTaxNumber?.trim()) gap(key);
        break;
      case 'SELLER_ADDRESS':
        if (!f.sellerAddress) gap(key);
        break;
      case 'BUYER_NAME':
        if (!f.buyerName.trim()) gap(key);
        break;
      case 'BUYER_ADDRESS':
        if (!f.buyerAddress) gap(key);
        break;
      case 'BUYER_TAX_NUMBER':
        if (!buyerRegistered) gap(key);
        break;
      case 'DESCRIPTIONS': {
        const bad = linesWhere((l) => !l.description?.trim());
        if (bad.length) gap(key, bad);
        break;
      }
      case 'QUANTITIES': {
        const bad = linesWhere((l) => !new D(l.quantity).gt(0));
        if (bad.length) gap(key, bad);
        break;
      }
      case 'TAX_RATES': {
        const bad = linesWhere((l) => !l.taxRateChosen);
        if (bad.length) gap(key, bad);
        break;
      }
      case 'HSN_CODES': {
        const bad = linesWhere((l) => !l.hsnCode?.trim());
        if (bad.length) gap(key, bad);
        break;
      }
      case 'PLACE_OF_SUPPLY':
        if (!f.placeOfSupply) gap(key);
        break;
      case 'REVERSE_CHARGE_WORDING':
        break;
    }
  }
  return { tier: tier.name, required, gaps };
}

// ---------------------------------------------------------------------------------------------
// Electronic invoicing (TAX-040)
// ---------------------------------------------------------------------------------------------

export type EInvoicingStatus = 'IN_FORCE' | 'PHASING_IN' | 'ANNOUNCED' | 'NOT_REQUIRED';

export interface EInvoicingMilestone {
  from: string;
  /** Who it applies to, in a sentence. */
  who: string;
  what: 'ISSUE' | 'RECEIVE' | 'PILOT';
  /** Applies to businesses whose turnover is above this (or at least it, with minInclusive), in the country's currency. */
  minTurnover?: string;
  minInclusive?: boolean;
  /** Applies to businesses whose turnover is below this. */
  maxTurnover?: string;
  /** Applies only to businesses that newly register for the tax: Talk2Tax cannot tell, so it says to check. */
  newRegistrantsOnly?: boolean;
  /** Applies to government bodies, not to businesses. */
  governmentOnly?: boolean;
}

export interface EInvoicingRule {
  country: string;
  countryName: string;
  currency: string;
  status: EInvoicingStatus;
  summary: string;
  /** The turnover the thresholds test: the financial year, the calendar year before, or none. */
  turnoverBasis: 'FISCAL_YEAR' | 'CALENDAR_YEAR' | null;
  milestones: EInvoicingMilestone[];
  format: string;
  /** How invoices travel: the portal or network. */
  channel: string;
  /** What Talk2Tax does for it today. */
  inTalk2Tax: string;
  source: string;
  checkedOn: string;
}

export const E_INVOICING_RULES: readonly EInvoicingRule[] = [
  {
    country: 'IN',
    countryName: 'India',
    currency: 'INR',
    status: 'IN_FORCE',
    summary:
      'B2B invoices, credit notes and debit notes need an Invoice Reference Number (IRN) from the Invoice Registration Portal when aggregate turnover in any financial year since 2017-18 exceeded Rs 5 crore. From 1 April 2025 businesses with turnover of Rs 10 crore or more must report an invoice within 30 days of its date.',
    turnoverBasis: 'FISCAL_YEAR',
    milestones: [
      { from: '2020-10-01', who: 'Aggregate turnover above Rs 500 crore', what: 'ISSUE', minTurnover: '5000000000' },
      { from: '2021-01-01', who: 'Aggregate turnover above Rs 100 crore', what: 'ISSUE', minTurnover: '1000000000' },
      { from: '2021-04-01', who: 'Aggregate turnover above Rs 50 crore', what: 'ISSUE', minTurnover: '500000000' },
      { from: '2022-04-01', who: 'Aggregate turnover above Rs 20 crore', what: 'ISSUE', minTurnover: '200000000' },
      { from: '2022-10-01', who: 'Aggregate turnover above Rs 10 crore', what: 'ISSUE', minTurnover: '100000000' },
      { from: '2023-08-01', who: 'Aggregate turnover above Rs 5 crore', what: 'ISSUE', minTurnover: '50000000' },
    ],
    format: 'GST INV-01 JSON schema, version 1.1',
    channel: 'Invoice Registration Portal (IRP), directly or through a GST Suvidha Provider',
    inTalk2Tax: 'Builds the IRP payload for each B2B invoice, imports the signed IRN and QR code, and tracks the 30-day and 24-hour cancellation limits (Sales, E-invoicing).',
    source: 'CGST Rules rule 48(4); Notification 10/2023-Central Tax; GSTN advisory of 5 November 2024',
    checkedOn: CHECKED_ON,
  },
  {
    country: 'DE',
    countryName: 'Germany',
    currency: 'EUR',
    status: 'PHASING_IN',
    summary:
      'Every business must be able to receive structured e-invoices for domestic B2B sales from 1 January 2025. Issuing them becomes compulsory from 1 January 2027 for businesses whose turnover in the previous year was above €800,000, and for everyone from 1 January 2028. Until then paper and PDF invoices remain allowed with the customer’s consent.',
    turnoverBasis: 'CALENDAR_YEAR',
    milestones: [
      { from: '2025-01-01', who: 'Every business (domestic B2B)', what: 'RECEIVE' },
      { from: '2027-01-01', who: 'Previous-year turnover above €800,000', what: 'ISSUE', minTurnover: '800000' },
      { from: '2028-01-01', who: 'Every business (domestic B2B)', what: 'ISSUE' },
    ],
    format: 'EN 16931: XRechnung or ZUGFeRD 2.0.1 or later (not ZUGFeRD MINIMUM or BASIC WL)',
    channel: 'No central platform: sent directly, by email or over Peppol',
    inTalk2Tax: 'Not produced yet: Talk2Tax prints PDF and HTML invoices only. XRechnung output is on the roadmap.',
    source: 'Wachstumschancengesetz of 27 March 2024; UStG §14 and §27 Abs. 38; BMF letter of 15 October 2024',
    checkedOn: CHECKED_ON,
  },
  {
    country: 'AE',
    countryName: 'the United Arab Emirates',
    currency: 'AED',
    status: 'PHASING_IN',
    summary:
      'E-invoicing through an Accredited Service Provider starts with a pilot from 1 July 2026. It is compulsory from 1 January 2027 for businesses with revenue of AED 50 million or more (who must appoint a provider by 31 July 2026), from 1 July 2027 for all other businesses (provider by 31 March 2027), and from 1 October 2027 for government bodies.',
    turnoverBasis: 'FISCAL_YEAR',
    milestones: [
      { from: '2026-07-01', who: 'Pilot taxpayers chosen by the Ministry of Finance', what: 'PILOT' },
      { from: '2027-01-01', who: 'Revenue of AED 50 million or more', what: 'ISSUE', minTurnover: '50000000', minInclusive: true },
      { from: '2027-07-01', who: 'Revenue below AED 50 million', what: 'ISSUE', maxTurnover: '50000000' },
      { from: '2027-10-01', who: 'Government entities', what: 'ISSUE', governmentOnly: true },
    ],
    format: 'PINT AE (Peppol International invoice, UAE specialisation)',
    channel: 'An Accredited Service Provider on the five-corner Peppol model, reporting to the Federal Tax Authority',
    inTalk2Tax: 'Not produced yet: Talk2Tax prints the tax invoice only. Your Accredited Service Provider sends the e-invoice.',
    source: 'Ministerial Decisions No. 243 and No. 244 of 2025',
    checkedOn: CHECKED_ON,
  },
  {
    country: 'SG',
    countryName: 'Singapore',
    currency: 'SGD',
    status: 'PHASING_IN',
    summary:
      'GST InvoiceNow: from 1 November 2025 newly incorporated companies that register for GST voluntarily must send invoice data to IRAS through InvoiceNow, and from 1 April 2026 all new voluntary GST registrants. Existing registrants may join voluntarily.',
    turnoverBasis: null,
    milestones: [
      { from: '2025-11-01', who: 'Newly incorporated companies registering for GST voluntarily', what: 'ISSUE', newRegistrantsOnly: true },
      { from: '2026-04-01', who: 'All new voluntary GST registrants', what: 'ISSUE', newRegistrantsOnly: true },
    ],
    format: 'Peppol PINT SG',
    channel: 'An IMDA-accredited InvoiceNow Access Point, which passes the data to IRAS',
    inTalk2Tax: 'Not produced yet: Talk2Tax prints the tax invoice only.',
    source: 'IRAS, GST InvoiceNow Requirement (announced in Budget 2024)',
    checkedOn: CHECKED_ON,
  },
  {
    country: 'GB',
    countryName: 'the United Kingdom',
    currency: 'GBP',
    status: 'ANNOUNCED',
    summary:
      'No e-invoicing requirement today. The government has announced that VAT invoices for B2B and B2G sales must be issued as e-invoices from April 2029; the legislation and the technical standard are still to be published.',
    turnoverBasis: null,
    milestones: [{ from: '2029-04-01', who: 'VAT-registered businesses (B2B and B2G), as announced', what: 'ISSUE' }],
    format: 'To be confirmed',
    channel: 'To be confirmed',
    inTalk2Tax: 'Nothing to do yet: PDF and HTML VAT invoices remain valid.',
    source: 'HM Treasury and HMRC, Budget of 26 November 2025: e-invoicing announcement',
    checkedOn: CHECKED_ON,
  },
  {
    country: 'AU',
    countryName: 'Australia',
    currency: 'AUD',
    status: 'NOT_REQUIRED',
    summary: 'No e-invoicing requirement between businesses. Peppol e-invoicing is voluntary; Commonwealth agencies receive Peppol e-invoices and aim to pay them within five days.',
    turnoverBasis: null,
    milestones: [],
    format: 'Peppol PINT A-NZ (voluntary)',
    channel: 'A Peppol Access Point',
    inTalk2Tax: 'Nothing required: PDF and HTML tax invoices are valid.',
    source: 'ATO, eInvoicing',
    checkedOn: CHECKED_ON,
  },
  {
    country: 'CA',
    countryName: 'Canada',
    currency: 'CAD',
    status: 'NOT_REQUIRED',
    summary: 'No federal or provincial e-invoicing requirement. Paper and electronic invoices are equally valid when they carry the information the input tax credit rules ask for.',
    turnoverBasis: null,
    milestones: [],
    format: 'None required',
    channel: 'None required',
    inTalk2Tax: 'Nothing required: PDF and HTML invoices are valid.',
    source: 'Canada Revenue Agency, GST/HST Memorandum 8.4 (documentary requirements)',
    checkedOn: CHECKED_ON,
  },
];

export function eInvoicingRule(country: string): EInvoicingRule | null {
  const code = country.toUpperCase();
  return E_INVOICING_RULES.find((x) => x.country === code) ?? null;
}

export type MilestoneFit = 'APPLIES' | 'DOES_NOT_APPLY' | 'CHECK';

/** Which milestones fit a business, given its turnover (null when unknown) and today's date. */
export function eInvoicingOutlook(rule: EInvoicingRule, input: { today: string; turnover: string | null }) {
  const turnover = input.turnover === null ? null : new D(input.turnover);
  const milestones = rule.milestones.map((m) => {
    let fit: MilestoneFit;
    let why: string;
    if (m.governmentOnly) {
      fit = 'DOES_NOT_APPLY';
      why = 'Applies to government bodies.';
    } else if (m.what === 'PILOT') {
      fit = 'CHECK';
      why = 'Only taxpayers the authority has chosen for the pilot.';
    } else if (m.newRegistrantsOnly) {
      fit = 'CHECK';
      why = 'Depends on when and how you registered for the tax.';
    } else if (m.minTurnover === undefined && m.maxTurnover === undefined) {
      fit = 'APPLIES';
      why = 'Applies to every business.';
    } else if (turnover === null) {
      fit = 'CHECK';
      why = 'Talk2Tax has no turnover figure to test.';
    } else {
      const aboveMin = m.minTurnover === undefined || (m.minInclusive ? turnover.gte(m.minTurnover) : turnover.gt(m.minTurnover));
      const belowMax = m.maxTurnover === undefined || turnover.lt(m.maxTurnover);
      fit = aboveMin && belowMax ? 'APPLIES' : 'DOES_NOT_APPLY';
      why = fit === 'APPLIES' ? 'Your turnover is within the threshold.' : 'Your turnover is outside the threshold.';
    }
    return { ...m, inForce: m.from <= input.today, fit, why };
  });
  const issuing = milestones.filter((m) => m.what === 'ISSUE' && m.fit === 'APPLIES');
  const current = issuing.filter((m) => m.inForce).sort((a, b) => a.from.localeCompare(b.from))[0] ?? null;
  const next = issuing.filter((m) => !m.inForce).sort((a, b) => a.from.localeCompare(b.from))[0] ?? null;
  const unsure = milestones.some((m) => m.fit === 'CHECK' && m.what !== 'PILOT');
  const receiving = milestones.find((m) => m.what === 'RECEIVE' && m.fit === 'APPLIES' && m.inForce) ?? null;
  const verdict: 'MUST_ISSUE' | 'WILL_HAVE_TO_ISSUE' | 'CHECK' | 'NOT_REQUIRED' = current ? 'MUST_ISSUE' : next ? 'WILL_HAVE_TO_ISSUE' : unsure ? 'CHECK' : 'NOT_REQUIRED';
  const headline =
    verdict === 'MUST_ISSUE'
      ? `You must issue e-invoices now (since ${current!.from}).`
      : verdict === 'WILL_HAVE_TO_ISSUE'
        ? `You will have to issue e-invoices from ${next!.from}.`
        : verdict === 'CHECK'
          ? 'Whether you must issue e-invoices depends on facts Talk2Tax does not hold: check the rules below.'
          : 'You do not have to issue e-invoices under the current rules.';
  return { verdict, headline, mustReceive: !!receiving, since: current?.from ?? null, nextFrom: next?.from ?? null, milestones };
}
