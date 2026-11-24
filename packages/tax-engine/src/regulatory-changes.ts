import { COUNTRY_MODULES } from '@talk2tax/accounting-engine';
import { INVOICE_FORMAT_RULES } from './invoice-rules';
import { TAX_DOCUMENTS_CHECKED_ON } from './tax-document-reading';
import { US_REPORTING_CHECKED_ON } from './us/information-returns';
import { US_SALES_TAX_CHECKED_ON } from './us/sales-tax';

/**
 * Regulatory change monitoring (TAX-046). Talk2Tax does not watch government websites. Instead it
 * keeps (1) every set of tax rules built into the product with the date its rules were last
 * checked against official sources, so rules that have not been checked for a while are flagged,
 * and (2) a list of known law changes with the date they take effect, so each business sees the
 * changes for its country coming up and can record that it has dealt with them. The business's own
 * scheduled tax rate changes are shown alongside. The list of changes was written from memory on
 * REGULATORY_CHANGES_CHECKED_ON and needs review by a tax adviser; it is not complete.
 */

export const REGULATORY_CHANGES_CHECKED_ON = '2026-11-24';
/** Rules not checked for this many days are flagged for review. */
export const RULES_STALE_AFTER_DAYS = 180;
/** Changes that took effect up to this many days ago still show, so late ones are not missed. */
export const RECENT_CHANGE_DAYS = 120;

export interface RuleSet {
  key: string;
  title: string;
  /** Countries the rules are for; empty for every country. */
  countries: string[];
  checkedOn: string;
  page: string | null;
}

export function ruleSets(): RuleSet[] {
  const modules = COUNTRY_MODULES.map((m) => ({
    key: `country:${m.code}`,
    title: `${m.name} country module (rates, returns and limits)`,
    countries: [m.code],
    checkedOn: m.reviewedOn,
    page: '/settings/country-module',
  }));
  const invoice = INVOICE_FORMAT_RULES.map((r) => ({
    key: `invoice:${r.country}`,
    title: `Invoice requirements (${r.countryName})`,
    countries: [r.country],
    checkedOn: r.checkedOn,
    page: '/tax/invoice-requirements',
  }));
  return [
    ...modules,
    ...invoice,
    { key: 'us-sales-tax', title: 'US sales tax nexus thresholds', countries: ['US'], checkedOn: US_SALES_TAX_CHECKED_ON, page: '/tax/us-sales-tax' },
    { key: 'us-1099', title: 'US 1099 reporting rules', countries: ['US'], checkedOn: US_REPORTING_CHECKED_ON, page: '/tax/us-reporting' },
    { key: 'tax-documents', title: 'Tax document explanations', countries: ['IN', 'US'], checkedOn: TAX_DOCUMENTS_CHECKED_ON, page: '/tax/documents' },
  ];
}

export interface KnownChange {
  key: string;
  country: string;
  effectiveOn: string;
  title: string;
  impact: string;
  /** What Talk2Tax already does about it. */
  inTalk2Tax: string;
  source: string;
}

/** Known changes, newest last. Written from memory; each needs confirming against the official source named. */
export const KNOWN_CHANGES: readonly KnownChange[] = [
  {
    key: 'IN-GST-EINVOICE-30-DAYS-2025',
    country: 'IN',
    effectiveOn: '2025-04-01',
    title: 'E-invoices must be reported within 30 days (turnover ₹10 crore or more)',
    impact: 'Businesses with aggregate turnover of ₹10 crore or more cannot report an invoice to the invoice registration portal more than 30 days after its date.',
    inTalk2Tax: 'E-invoicing shows each invoice still to be reported with its age.',
    source: 'GSTN advisory on time limits for reporting e-invoices',
  },
  {
    key: 'DE-EINVOICE-RECEIVE-2025',
    country: 'DE',
    effectiveOn: '2025-01-01',
    title: 'Every business must be able to receive e-invoices',
    impact: 'Domestic B2B invoices may be sent as structured e-invoices (XRechnung or ZUGFeRD), and every business must be able to receive them.',
    inTalk2Tax: 'Invoice requirements show the German e-invoicing outlook for your turnover.',
    source: 'Wachstumschancengesetz; BMF letter on e-invoicing',
  },
  {
    key: 'US-1099-THRESHOLD-2026',
    country: 'US',
    effectiveOn: '2026-01-01',
    title: '1099-NEC and 1099-MISC threshold rises from $600 to $2,000',
    impact: 'Payments made from 2026 are reported on 1099-NEC or 1099-MISC only when a vendor is paid $2,000 or more in the year, indexed for inflation after 2026.',
    inTalk2Tax: 'US 1099s and state returns uses $2,000 for 2026 payments.',
    source: 'One Big Beautiful Bill Act (Public Law 119-21); IRS instructions for Forms 1099-MISC and 1099-NEC',
  },
  {
    key: 'IN-INCOME-TAX-ACT-2025',
    country: 'IN',
    effectiveOn: '2026-04-01',
    title: 'Income-tax Act, 2025 replaces the Income-tax Act, 1961',
    impact: '"Tax year" replaces "previous year" and "assessment year", and TDS and TCS provisions are renumbered (for example under section 393). Forms and returns change with the new rules.',
    inTalk2Tax: 'Withholding templates for the new sections apply from 1 April 2026; earlier payments keep the old sections.',
    source: 'Income-tax Act, 2025 and the Income-tax Rules made under it',
  },
  {
    key: 'DE-EINVOICE-ISSUE-2027',
    country: 'DE',
    effectiveOn: '2027-01-01',
    title: 'E-invoices required for businesses with turnover above €800,000',
    impact: 'Businesses with prior-year turnover above €800,000 must issue domestic B2B invoices as structured e-invoices.',
    inTalk2Tax: 'Invoice requirements flag the date from your turnover. Talk2Tax does not yet produce XRechnung or ZUGFeRD files.',
    source: 'Wachstumschancengesetz, section 27(38) UStG',
  },
  {
    key: 'DE-EINVOICE-ALL-2028',
    country: 'DE',
    effectiveOn: '2028-01-01',
    title: 'E-invoices required for all domestic B2B invoices',
    impact: 'The transition ends: every business must issue domestic B2B invoices as structured e-invoices.',
    inTalk2Tax: 'Invoice requirements flag the date. Talk2Tax does not yet produce XRechnung or ZUGFeRD files.',
    source: 'Wachstumschancengesetz, section 27(38) UStG',
  },
];

const dayMs = 86_400_000; // not money
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / dayMs); // not money

export interface ScheduledRateChange {
  taxRateId: string;
  name: string;
  from: string;
  to: string;
  effectiveFrom: string;
  reason: string;
}

export interface Acknowledgement {
  changeKey: string;
  note: string | null;
  by: string;
  at: string;
}

/** What a business in `country` should look at today. */
export function regulatoryWatch(input: {
  country: string;
  today: string;
  acknowledgements: Acknowledgement[];
  rateChanges: ScheduledRateChange[];
  rules?: RuleSet[];
  changes?: readonly KnownChange[];
}) {
  const acks = new Map(input.acknowledgements.map((a) => [a.changeKey, a]));
  const rules = (input.rules ?? ruleSets())
    .filter((r) => r.countries.length === 0 || r.countries.includes(input.country))
    .map((r) => {
      const age = daysBetween(r.checkedOn, input.today);
      return { ...r, daysSinceCheck: age, stale: age > RULES_STALE_AFTER_DAYS };
    })
    .sort((a, b) => a.checkedOn.localeCompare(b.checkedOn) || a.title.localeCompare(b.title));
  const changes = (input.changes ?? KNOWN_CHANGES)
    .filter((c) => c.country === input.country)
    .map((c) => {
      const inDays = daysBetween(input.today, c.effectiveOn);
      const ack = acks.get(c.key) ?? null;
      const timing = inDays > 0 ? 'UPCOMING' : inDays >= -RECENT_CHANGE_DAYS ? 'RECENT' : 'IN_FORCE';
      return { ...c, inDays, timing, acknowledgement: ack, status: ack ? 'DEALT_WITH' : timing === 'IN_FORCE' ? 'IN_FORCE' : 'TO_REVIEW' };
    })
    .sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn));
  const rateChanges = input.rateChanges.filter((r) => r.effectiveFrom > input.today).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.name.localeCompare(b.name));
  return {
    checkedOn: REGULATORY_CHANGES_CHECKED_ON,
    staleAfterDays: RULES_STALE_AFTER_DAYS,
    rules,
    changes,
    rateChanges,
    summary: {
      toReview: changes.filter((c) => c.status === 'TO_REVIEW').length,
      upcoming: changes.filter((c) => c.timing === 'UPCOMING').length,
      staleRules: rules.filter((r) => r.stale).length,
      scheduledRateChanges: rateChanges.length,
    },
  };
}

export function knownChange(key: string): KnownChange | null {
  return KNOWN_CHANGES.find((c) => c.key === key) ?? null;
}
