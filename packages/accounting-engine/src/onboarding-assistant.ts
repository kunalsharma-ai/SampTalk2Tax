/**
 * The onboarding assistant (UX-020 to UX-022): the owner describes the business in their own
 * words, the assistant reads what it can from them (industry, size, and signals such as staff,
 * exports or contracts), and recommends setup steps. Every recommendation is for a person to
 * accept or dismiss; nothing is applied on its own, and activation waits until each one is
 * decided.
 *
 * A reading can come from an AI model or from the word rules here. Either way, each finding must
 * quote the words it rests on, and a quote that is not in the description is dropped, so the
 * assistant never acts on something the owner did not say.
 */
import { ACCOUNTING_FRAMEWORKS, BUSINESS_SIZES, INDUSTRIES, suggestSetup, type AccountingFramework, type AiPreference, type BusinessSize, type Industry } from './setup';

export const DESCRIPTION_MAX_LENGTH = 2000;

/** Things a description can say that change which setup steps help. */
export const BUSINESS_SIGNALS = [
  { key: 'EMPLOYEES', label: 'Has employees on payroll' },
  { key: 'CONTRACTORS', label: 'Pays contractors or professionals' },
  { key: 'FOREIGN_TRADE', label: 'Sells abroad or buys from abroad' },
  { key: 'RECURRING_BILLING', label: 'Bills customers on a schedule' },
  { key: 'PROJECTS', label: 'Works in projects' },
  { key: 'LOCATIONS', label: 'Has more than one branch or location' },
  { key: 'ASSETS', label: 'Owns machinery, vehicles or equipment' },
  { key: 'LOANS', label: 'Has loans or borrowing' },
  { key: 'ONLINE_PAYMENTS', label: 'Takes payments online' },
  { key: 'INVENTORY', label: 'Holds stock' },
  { key: 'LISTED', label: 'Listed, or planning to list' },
] as const;
export type BusinessSignal = (typeof BUSINESS_SIGNALS)[number]['key'];

export interface Finding<T> {
  value: T;
  /** The owner's own words this rests on. */
  quote: string;
}

export interface BusinessReading {
  industry: Finding<Industry> | null;
  size: Finding<BusinessSize> | null;
  signals: Finding<BusinessSignal>[];
}

/** Word rules for each industry, most specific first. */
const INDUSTRY_WORDS: [Industry, RegExp][] = [
  ['SOFTWARE', /\b(?:software|saas|app(?:s|lication)?|it services|web development|developers?|tech(?:nology)? (?:company|startup|firm))\b/i],
  ['HEALTHCARE', /\b(?:clinic|hospital|pharmacy|diagnostic|dental|healthcare|medical)\b/i],
  ['EDUCATION', /\b(?:school|coaching|tuition|training institute|college|edtech|education(?:al)?)\b/i],
  ['HOSPITALITY', /\b(?:restaurant|caf[eé]|hotel|catering|bakery|food (?:business|outlet|delivery)|cloud kitchen)\b/i],
  ['CONSTRUCTION', /\b(?:construction|builders?|contractor for buildings|real estate|interiors?|civil works)\b/i],
  ['LOGISTICS', /\b(?:logistics|transport(?:er|ation)?|freight|courier|trucking|warehousing)\b/i],
  ['MANUFACTURING', /\b(?:manufactur\w*|factory|fabricat\w*|plant|production unit)\b/i],
  ['WHOLESALE', /\b(?:wholesale\w*|distribut(?:or|ion)|trading company|stockist)\b/i],
  ['RETAIL', /\b(?:retail\w*|shops?|stores?|boutique|showroom|e-?commerce|online store)\b/i],
  ['PROFESSIONAL_SERVICES', /\b(?:consult\w*|agency|law firm|chartered accountants?|ca firm|architects?|design studio|marketing services|advisory)\b/i],
];

const SIGNAL_WORDS: [BusinessSignal, RegExp][] = [
  ['EMPLOYEES', /\b(?:employees?|staff|salar(?:y|ies)|payroll|team of \d+|\d+ (?:people|employees|staff))\b/i],
  ['CONTRACTORS', /\b(?:freelancers?|contractors?|consultants we pay|professional fees|sub-?contract\w*)\b/i],
  ['FOREIGN_TRADE', /\b(?:export\w*|import\w*|overseas|abroad|international (?:clients|customers)|foreign (?:clients|customers|currency)|usd|dollars?|euros?)\b/i],
  ['RECURRING_BILLING', /\b(?:subscriptions?|monthly (?:fee|retainer|billing|plan)|retainers?|annual maintenance|amc|recurring)\b/i],
  ['PROJECTS', /\b(?:projects?|client engagements?|sites?)\b/i],
  ['LOCATIONS', /\b(?:branch(?:es)?|outlets|locations|warehouses|offices in|multiple (?:states|cities))\b/i],
  ['ASSETS', /\b(?:machinery|machines|vehicles?|trucks?|equipment|fleet)\b/i],
  ['LOANS', /\b(?:loans?|borrow\w*|overdraft|credit line|term loan|working capital)\b/i],
  ['ONLINE_PAYMENTS', /\b(?:online payments?|payment gateway|upi|card payments?|razorpay|stripe|online store|e-?commerce)\b/i],
  ['INVENTORY', /\b(?:stock|inventory|goods|raw materials?|products we sell)\b/i],
  ['LISTED', /\b(?:listed|ipo|stock exchange|public company)\b/i],
];

/** A head count stated in the description, such as "12 employees" or "team of 40". */
const HEADCOUNT = /\b(?:team of|about|around|nearly|over|with)?\s*(\d{1,6})\s*(?:\+\s*)?(?:people|employees|staff|members|person team|-person)\b|\bteam of (\d{1,6})\b/i;
const SIZE_WORDS: [BusinessSize, RegExp][] = [
  ['MICRO', /\b(?:just me|solo|one-person|sole proprietor\w*|freelancer|tiny|home-based)\b/i],
  ['LARGE', /\b(?:large enterprise|multinational|listed company|conglomerate)\b/i],
];

/** Size band for a head count, matching the bands used in setup and benchmarking. */
export function sizeForHeadcount(n: number): BusinessSize {
  if (n <= 10) return 'MICRO';
  if (n <= 50) return 'SMALL';
  if (n <= 250) return 'MEDIUM';
  return 'LARGE';
}

/** Reads the description with word rules. */
export function readDescription(text: string): BusinessReading {
  const t = text.slice(0, DESCRIPTION_MAX_LENGTH);
  let industry: Finding<Industry> | null = null;
  for (const [key, re] of INDUSTRY_WORDS) {
    const m = t.match(re);
    if (m) {
      industry = { value: key, quote: m[0] };
      break;
    }
  }
  let size: Finding<BusinessSize> | null = null;
  const h = t.match(HEADCOUNT);
  if (h) size = { value: sizeForHeadcount(Number(h[1] ?? h[2])), quote: h[0].trim() };
  else
    for (const [key, re] of SIZE_WORDS) {
      const m = t.match(re);
      if (m) {
        size = { value: key, quote: m[0] };
        break;
      }
    }
  const signals: Finding<BusinessSignal>[] = [];
  for (const [key, re] of SIGNAL_WORDS) {
    const m = t.match(re);
    if (m) signals.push({ value: key, quote: m[0] });
  }
  return { industry, size, signals };
}

const normal = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Checks a reading that came from an AI model against the description: values must be on the
 * lists, and every quote must be words the owner actually wrote. Anything else is dropped, and
 * the reasons are returned so the page can say what was left out.
 */
export function checkReading(description: string, raw: unknown): { reading: BusinessReading; dropped: string[] } {
  const text = normal(description.slice(0, DESCRIPTION_MAX_LENGTH));
  const dropped: string[] = [];
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const finding = <T extends string>(x: unknown, allowed: readonly string[], what: string): Finding<T> | null => {
    if (x == null) return null;
    const f = x as { value?: unknown; quote?: unknown };
    if (typeof f.value !== 'string' || !allowed.includes(f.value)) {
      dropped.push(`${what}: not one of the options`);
      return null;
    }
    if (typeof f.quote !== 'string' || !f.quote.trim() || !text.includes(normal(f.quote))) {
      dropped.push(`${what}: the words it quoted are not in the description`);
      return null;
    }
    return { value: f.value as T, quote: f.quote.trim().slice(0, 200) };
  };
  const industry = finding<Industry>(r.industry, INDUSTRIES.map((i) => i.key), 'Industry');
  const size = finding<BusinessSize>(r.size, BUSINESS_SIZES.map((s) => s.key), 'Size');
  const signals: Finding<BusinessSignal>[] = [];
  for (const s of Array.isArray(r.signals) ? r.signals.slice(0, BUSINESS_SIGNALS.length * 2) : []) {
    const label = BUSINESS_SIGNALS.find((b) => b.key === (s as { value?: unknown })?.value)?.label ?? 'A signal';
    const f = finding<BusinessSignal>(s, BUSINESS_SIGNALS.map((b) => b.key), label);
    if (f && !signals.some((x) => x.value === f.value)) signals.push(f);
  }
  return { reading: { industry, size, signals }, dropped };
}

export type RecommendationKind = 'PROFILE' | 'STEP' | 'NOTE';
export type ProfileField = 'industry' | 'size' | 'framework' | 'aiPreference';

export interface Recommendation {
  /** Stable within a reading, so a decision can name it. */
  id: string;
  kind: RecommendationKind;
  /** PROFILE: the setup field it fills and the value. */
  field: ProfileField | null;
  value: string | null;
  title: string;
  reason: string;
  /** STEP: where to do it, relative to the organisation. */
  link: string | null;
}

const has = (r: BusinessReading, s: BusinessSignal) => r.signals.find((x) => x.value === s);

/**
 * Recommendations from a reading. The profile ones fill the setup fields; the steps point to the
 * pages that fit what the owner said; notes say plainly where Talk2Tax does not cover something.
 */
export function recommendFromReading(countryCode: string, reading: BusinessReading): Recommendation[] {
  const out: Recommendation[] = [];
  const india = countryCode === 'IN';
  const profile = (field: ProfileField, value: string, title: string, reason: string) => out.push({ id: `profile:${field}`, kind: 'PROFILE', field, value, title, reason, link: null });
  const step = (id: string, title: string, reason: string, link: string | null, kind: 'STEP' | 'NOTE' = 'STEP') => out.push({ id: `${kind.toLowerCase()}:${id}`, kind, field: null, value: null, title, reason, link });

  if (reading.industry) profile('industry', reading.industry.value, `Industry: ${INDUSTRIES.find((i) => i.key === reading.industry!.value)!.label}`, `You wrote "${reading.industry.quote}".`);
  if (reading.size) profile('size', reading.size.value, `Business size: ${BUSINESS_SIZES.find((s) => s.key === reading.size!.value)!.label}`, `You wrote "${reading.size.quote}".`);

  const suggestion = suggestSetup(countryCode, { industry: reading.industry?.value ?? null, size: reading.size?.value ?? null });
  const listed = has(reading, 'LISTED');
  const framework: AccountingFramework = listed && india ? 'IND_AS' : suggestion.framework;
  profile(
    'framework',
    framework,
    `Accounting framework: ${ACCOUNTING_FRAMEWORKS.find((f) => f.id === framework)!.name}`,
    listed && india ? `You wrote "${listed.quote}"; listed companies in India report under Ind AS. Confirm with your accountant.` : suggestion.reasons[0]!,
  );
  const ai: AiPreference = suggestion.aiPreference;
  profile('aiPreference', ai, ai === 'PREPARE' ? 'AI agents: prepare work for approval' : 'AI agents: answers and drafts', suggestion.reasons[1]!);

  const sig = (s: BusinessSignal) => has(reading, s);
  let s;
  if ((s = sig('EMPLOYEES'))) step('payroll', 'Set up payroll', `You wrote "${s.quote}". Payroll works out salaries, ${india ? 'PF, ESI, professional tax and TDS on salary' : 'deductions'} and posts them to the books.`, '/settings/payroll');
  if ((s = sig('CONTRACTORS')) && india) step('tds', 'Set up TDS on payments', `You wrote "${s.quote}". Payments to contractors and professionals usually need TDS deducted.`, '/settings/tds-tcs');
  if ((s = sig('FOREIGN_TRADE'))) step('fx', 'Add the currencies you trade in', `You wrote "${s.quote}". Invoices and bills in other currencies need exchange rates.`, '/fx');
  if ((s = sig('RECURRING_BILLING'))) step('contracts', 'Bill recurring work from contracts', `You wrote "${s.quote}". A contract raises the invoice each period on its own schedule.`, '/sales/contracts');
  if ((s = sig('PROJECTS'))) step('projects', 'Track projects with a dimension', `You wrote "${s.quote}". A project dimension shows income and costs by project.`, '/dimensions');
  if ((s = sig('LOCATIONS'))) step('locations', 'Track branches with a dimension', `You wrote "${s.quote}". A location dimension shows results by branch.`, '/dimensions');
  if ((s = sig('ASSETS'))) step('assets', 'Record your fixed assets', `You wrote "${s.quote}". The fixed asset register works out depreciation each period.`, '/fixed-assets');
  if ((s = sig('LOANS'))) step('loans', 'Record your loans', `You wrote "${s.quote}". Loans keep the repayment schedule and split interest from principal.`, '/loans');
  if ((s = sig('ONLINE_PAYMENTS'))) step('gateways', 'Connect a payment gateway', `You wrote "${s.quote}". Customers can pay invoices online and receipts are recorded.`, '/settings/payment-gateways');
  if (india && (reading.size?.value === 'LARGE' || reading.size?.value === 'MEDIUM')) step('e-invoicing', 'Check e-invoicing', 'Businesses above the GST turnover threshold must report B2B invoices to the invoice registration portal. Confirm whether this applies to you.', '/settings/e-invoicing');
  if ((s = sig('INVENTORY'))) step('inventory', 'Stock is not tracked item by item', `You wrote "${s.quote}". Talk2Tax does not keep stock quantities yet; keep them in your current system and post the stock value at each close.`, null, 'NOTE');
  return out;
}
