import { addDays } from './documents';
import { seededRandom } from './fixtures';
import { D } from './money';
import { fiscalYearForDate } from './periods';

/**
 * Demonstration organisations (DEMO-001 to DEMO-020): six made-up companies, each with a
 * deterministic plan of what to post through the ordinary services (customers, vendors,
 * invoices, bills, payments, journals, projects, departments, staff, budgets). Every name is
 * fictitious and carries "(synthetic)"; organisation names carry "(SYNTHETIC DATA)". The
 * figures are generated, not taken from any real business. No framework or database code.
 * Money is decimal strings.
 */

export const DEMO_PROFILE_KEYS = ['IN_CONSULTING', 'US_SERVICES', 'UK_TRADING', 'AE_SUBSIDIARY', 'GLOBAL_MANUFACTURING', 'MARKET_RESEARCH'] as const;
export type DemoProfileKey = (typeof DEMO_PROFILE_KEYS)[number];

/** How many demonstration organisations one person may create. */
export const DEMO_ORGS_PER_PERSON = 3;
/** Months of history a demonstration organisation is given, ending this month. */
export const DEMO_MONTHS = 6;

export interface DemoContact {
  name: string;
  terms: number;
  /** Indian state code (GST place of supply) for Indian profiles. */
  stateCode?: string;
  /** A made-up PAN (starts ZZZ, belongs to no one) for a synthetic GSTIN. */
  pan?: string;
  /** ISO country for a customer abroad: its sales are zero-rated exports. */
  countryCode?: string;
  /** Pays roughly half of each invoice on time, so the ageing shows an overdue balance. */
  slowPayer?: boolean;
  /** Invoiced every other month only. */
  occasional?: boolean;
}

export interface DemoVendor extends DemoContact {
  account: string;
  description: string;
  /** Monthly amount range, in the books' currency (whole units). */
  min: number;
  max: number;
  /** Tax charged on the bill (the profile's standard rate); false for suppliers who charge none. */
  taxed: boolean;
  /** Service accounting code for Indian GST (SAC/HSN). */
  hsn?: string;
}

export interface DemoStaff {
  name: string;
  department: string;
  /** Monthly gross pay, whole units. */
  monthly: number;
  pan?: string;
  woman?: boolean;
}

export interface DemoProfile {
  key: DemoProfileKey;
  title: string;
  summary: string;
  orgName: string;
  legalName: string;
  countryCode: string;
  currency: string;
  fiscalYearStartMonth: number;
  timeZone: string;
  /** Where an Indian profile is registered for GST. */
  stateCode?: string;
  /** The standard sales-tax rate charged on sales and taxed bills. */
  taxRate: { name: string; rate: string } | null;
  /** The zero rate used for exports, where the country has one. */
  zeroRate: { name: string; rate: string } | null;
  revenueAccount: '4100' | '4200';
  /** HSN or SAC on Indian invoices. */
  revenueHsn?: string;
  /** Goods businesses: the share of sales that is cost of goods (moved from inventory). */
  cogsShare?: string;
  capital: number;
  customers: DemoContact[];
  vendors: DemoVendor[];
  /** What is sold to each customer each month. Amount range per unit, whole units. */
  offering: { description: string; quantity: [number, number]; price: [number, number] }[];
  projects: { code: string; name: string; customer: number }[];
  departments: { code: string; name: string }[];
  staff: DemoStaff[];
  /** Overheads paid straight from the bank each month (journals), by account and department. */
  overheads: { account: string; department: string; memo: string; min: number; max: number }[];
  /** Indian profiles run payroll (payslips, statutory dues); elsewhere salaries are journals. */
  payroll: boolean;
}

const LEGAL = 'Synthetic demonstration company — not a real business';

export const DEMO_PROFILES: readonly DemoProfile[] = [
  {
    key: 'IN_CONSULTING',
    title: 'Indian consulting SME',
    summary: 'A Mumbai advisory firm billing retainers and projects with GST, paying a co-working space, freelancers and cloud software, and running payroll for its team.',
    orgName: 'Kestrel Advisory Partners (SYNTHETIC DATA)',
    legalName: LEGAL,
    countryCode: 'IN',
    currency: 'INR',
    fiscalYearStartMonth: 4,
    timeZone: 'Asia/Kolkata',
    stateCode: '27',
    taxRate: { name: 'GST 18%', rate: '18' },
    zeroRate: null,
    revenueAccount: '4200',
    revenueHsn: '998311',
    capital: 2500000,
    customers: [
      { name: 'Sarvam Retail Ventures (synthetic)', terms: 30, stateCode: '27', pan: 'ZZZCS2001Z' },
      { name: 'Indus Valley Logistics (synthetic)', terms: 45, stateCode: '29', pan: 'ZZZCI2002Z', slowPayer: true },
      { name: 'Nilgiri Foods (synthetic)', terms: 30, stateCode: '33', pan: 'ZZZCN2003Z' },
      { name: 'Coromandel Health Trust (synthetic)', terms: 15, stateCode: '27', occasional: true },
    ],
    vendors: [
      { name: 'Workbay Co-working (synthetic)', terms: 7, stateCode: '27', pan: 'ZZZCW2101Z', account: '6200', description: 'Co-working seats', min: 85000, max: 85000, taxed: true, hsn: '997212' },
      {
        name: 'Cirrus Cloud Services (synthetic)',
        terms: 0,
        stateCode: '29',
        pan: 'ZZZCC2102Z',
        account: '6400',
        description: 'Cloud and office software',
        min: 18000,
        max: 26000,
        taxed: true,
        hsn: '997331',
      },
      {
        name: 'Ananya Rao, freelance analyst (synthetic)',
        terms: 15,
        stateCode: '27',
        account: '6600',
        description: 'Freelance research support',
        min: 40000,
        max: 90000,
        taxed: false,
        hsn: '998311',
      },
      {
        name: 'Skyline Travel Desk (synthetic)',
        terms: 30,
        stateCode: '27',
        pan: 'ZZZCT2104Z',
        account: '6700',
        description: 'Client travel bookings',
        min: 15000,
        max: 45000,
        taxed: true,
        hsn: '998555',
      },
    ],
    offering: [{ description: 'Advisory retainer and project work', quantity: [1, 1], price: [180000, 420000] }],
    projects: [
      { code: 'SRV-GTM', name: 'Sarvam go-to-market review (synthetic)', customer: 0 },
      { code: 'IVL-OPS', name: 'Indus Valley operations study (synthetic)', customer: 1 },
      { code: 'NLG-PRC', name: 'Nilgiri pricing project (synthetic)', customer: 2 },
    ],
    departments: [
      { code: 'ADV', name: 'Advisory (synthetic)' },
      { code: 'OPS', name: 'Operations (synthetic)' },
    ],
    staff: [
      { name: 'Ishaan Kapoor (synthetic)', department: 'ADV', monthly: 160000, pan: 'ZZZPK2201Z' },
      { name: 'Meher Sethi (synthetic)', department: 'ADV', monthly: 95000, pan: 'ZZZPS2202Z', woman: true },
      { name: 'Tanvi Kulkarni (synthetic)', department: 'ADV', monthly: 70000, pan: 'ZZZPK2203Z', woman: true },
      { name: 'Farhan Qureshi (synthetic)', department: 'OPS', monthly: 42000, pan: 'ZZZPQ2204Z' },
    ],
    overheads: [
      { account: '6500', department: 'ADV', memo: 'Events and marketing', min: 12000, max: 40000 },
      { account: '6300', department: 'OPS', memo: 'Internet and phones', min: 6000, max: 9000 },
      { account: '6900', department: 'OPS', memo: 'Bank charges', min: 300, max: 900 },
    ],
    payroll: true,
  },
  {
    key: 'US_SERVICES',
    title: 'US professional services company',
    summary: 'A Boston consulting LLC billing project fees in dollars, with contractors, an office lease, software and insurance. Professional services here are not charged sales tax.',
    orgName: 'Juniper Ridge Consulting LLC (SYNTHETIC DATA)',
    legalName: LEGAL,
    countryCode: 'US',
    currency: 'USD',
    fiscalYearStartMonth: 1,
    timeZone: 'America/New_York',
    taxRate: null,
    zeroRate: null,
    revenueAccount: '4200',
    capital: 250000,
    customers: [
      { name: 'Bayside Medical Group (synthetic)', terms: 30 },
      { name: 'Granite Peak Software (synthetic)', terms: 45, slowPayer: true },
      { name: 'Hudson Freight Partners (synthetic)', terms: 30 },
      { name: 'Maple Street Schools (synthetic)', terms: 60, occasional: true },
    ],
    vendors: [
      { name: 'Beacon Street Offices (synthetic)', terms: 0, account: '6200', description: 'Office lease', min: 9500, max: 9500, taxed: false },
      { name: 'Northstar SaaS Tools (synthetic)', terms: 0, account: '6400', description: 'Software subscriptions', min: 1800, max: 2600, taxed: false },
      { name: 'Redwood Contractor Network (synthetic)', terms: 30, account: '5000', description: 'Subcontracted consultants', min: 12000, max: 28000, taxed: false },
      { name: 'Commonwealth Assurance Partners (synthetic)', terms: 30, account: '6600', description: 'Professional liability insurance', min: 1400, max: 1400, taxed: false },
    ],
    offering: [{ description: 'Consulting fees', quantity: [40, 120], price: [175, 260] }],
    projects: [
      { code: 'BMG-EHR', name: 'Bayside records migration (synthetic)', customer: 0 },
      { code: 'GPS-FIN', name: 'Granite Peak finance transformation (synthetic)', customer: 1 },
      { code: 'HFP-NET', name: 'Hudson network design (synthetic)', customer: 2 },
    ],
    departments: [
      { code: 'DEL', name: 'Delivery (synthetic)' },
      { code: 'SAL', name: 'Sales and admin (synthetic)' },
    ],
    staff: [
      { name: 'Avery Collins (synthetic)', department: 'DEL', monthly: 11500 },
      { name: 'Jordan Reyes (synthetic)', department: 'DEL', monthly: 9200 },
      { name: 'Taylor Brooks (synthetic)', department: 'DEL', monthly: 8100 },
      { name: 'Morgan Ellis (synthetic)', department: 'SAL', monthly: 7400 },
    ],
    overheads: [
      { account: '6500', department: 'SAL', memo: 'Marketing and events', min: 1200, max: 4000 },
      { account: '6700', department: 'DEL', memo: 'Client travel', min: 1500, max: 5200 },
      { account: '6900', department: 'SAL', memo: 'Bank fees', min: 40, max: 120 },
    ],
    payroll: false,
  },
  {
    key: 'UK_TRADING',
    title: 'UK trading business',
    summary: 'A Bristol wholesaler buying homeware stock and selling it to shops with 20% VAT, with a warehouse, couriers, stock moving to cost of sales and the VAT return prepared from the books.',
    orgName: 'Harbourside Trading Ltd (SYNTHETIC DATA)',
    legalName: LEGAL,
    countryCode: 'GB',
    currency: 'GBP',
    fiscalYearStartMonth: 4,
    timeZone: 'Europe/London',
    taxRate: { name: 'VAT 20% (standard)', rate: '20' },
    zeroRate: { name: 'VAT 0% (zero-rated)', rate: '0' },
    revenueAccount: '4100',
    cogsShare: '0.58',
    capital: 180000,
    customers: [
      { name: 'Cotswold Home Stores (synthetic)', terms: 30 },
      { name: 'Severn Gift Co. (synthetic)', terms: 30, slowPayer: true },
      { name: 'Penrose Interiors (synthetic)', terms: 14 },
      { name: 'Lisbon Casa Lda, Portugal (synthetic)', terms: 30, countryCode: 'PT', occasional: true },
    ],
    vendors: [
      { name: 'Avon Wholesale Supplies (synthetic)', terms: 30, account: '1300', description: 'Homeware stock', min: 26000, max: 38000, taxed: true },
      { name: 'Quayside Couriers (synthetic)', terms: 14, account: '5000', description: 'Outbound deliveries', min: 1800, max: 3200, taxed: true },
      { name: 'Temple Meads Warehousing (synthetic)', terms: 0, account: '6200', description: 'Warehouse rent', min: 4200, max: 4200, taxed: true },
    ],
    offering: [
      { description: 'Ceramic tableware (cases)', quantity: [20, 60], price: [140, 190] },
      { description: 'Glassware (cases)', quantity: [10, 40], price: [90, 130] },
    ],
    projects: [
      { code: 'CHS-RNG', name: 'Cotswold spring range (synthetic)', customer: 0 },
      { code: 'PNR-FIT', name: 'Penrose shop fit-out supply (synthetic)', customer: 2 },
    ],
    departments: [
      { code: 'WHS', name: 'Warehouse (synthetic)' },
      { code: 'SLS', name: 'Sales (synthetic)' },
    ],
    staff: [
      { name: 'Oliver Hughes (synthetic)', department: 'SLS', monthly: 3900 },
      { name: 'Amelia Price (synthetic)', department: 'SLS', monthly: 3300 },
      { name: 'Harry Doyle (synthetic)', department: 'WHS', monthly: 2500 },
    ],
    overheads: [
      { account: '6300', department: 'WHS', memo: 'Warehouse energy', min: 600, max: 1100 },
      { account: '6500', department: 'SLS', memo: 'Trade marketing', min: 300, max: 1500 },
      { account: '6900', department: 'SLS', memo: 'Card and bank fees', min: 60, max: 180 },
    ],
    payroll: false,
  },
  {
    key: 'AE_SUBSIDIARY',
    title: 'UAE multinational subsidiary',
    summary: 'The Dubai subsidiary of a made-up UK group, selling regional services with 5% VAT and paying its parent a monthly management fee, with the VAT 201 prepared from the books.',
    orgName: 'Falconcrest Gulf FZ-LLC (SYNTHETIC DATA)',
    legalName: LEGAL,
    countryCode: 'AE',
    currency: 'AED',
    fiscalYearStartMonth: 1,
    timeZone: 'Asia/Dubai',
    taxRate: { name: 'VAT 5%', rate: '5' },
    zeroRate: { name: 'VAT 0% (zero-rated)', rate: '0' },
    revenueAccount: '4200',
    capital: 900000,
    customers: [
      { name: 'Al Noor Hospitality (synthetic)', terms: 30 },
      { name: 'Creekside Developments (synthetic)', terms: 60, slowPayer: true },
      { name: 'Oasis Retail Holdings (synthetic)', terms: 30 },
      { name: 'Muscat Marine Services, Oman (synthetic)', terms: 45, countryCode: 'OM', occasional: true },
    ],
    vendors: [
      { name: 'Falconcrest Group plc, UK parent (synthetic)', terms: 30, countryCode: 'GB', account: '6600', description: 'Group management fee', min: 60000, max: 60000, taxed: false },
      { name: 'Marina Business Centre (synthetic)', terms: 0, account: '6200', description: 'Office rent', min: 32000, max: 32000, taxed: true },
      { name: 'Desert Link IT Services (synthetic)', terms: 30, account: '6400', description: 'IT support and licences', min: 7000, max: 11000, taxed: true },
    ],
    offering: [{ description: 'Facilities consulting services', quantity: [1, 1], price: [90000, 240000] }],
    projects: [
      { code: 'ANH-FM', name: 'Al Noor facilities review (synthetic)', customer: 0 },
      { code: 'CRK-PMO', name: 'Creekside project office (synthetic)', customer: 1 },
    ],
    departments: [
      { code: 'SVC', name: 'Services (synthetic)' },
      { code: 'ADM', name: 'Administration (synthetic)' },
    ],
    staff: [
      { name: 'Omar Haddad (synthetic)', department: 'SVC', monthly: 42000 },
      { name: 'Leila Mansour (synthetic)', department: 'SVC', monthly: 31000 },
      { name: 'Ravi Menon (synthetic)', department: 'ADM', monthly: 18000 },
    ],
    overheads: [
      { account: '6700', department: 'SVC', memo: 'Regional travel', min: 6000, max: 18000 },
      { account: '6300', department: 'ADM', memo: 'Utilities and telecom', min: 2500, max: 4200 },
      { account: '6900', department: 'ADM', memo: 'Bank charges', min: 150, max: 400 },
    ],
    payroll: false,
  },
  {
    key: 'GLOBAL_MANUFACTURING',
    title: 'Global manufacturing group',
    summary:
      'A German precision-parts maker selling at home with 19% VAT and exporting to customers in the US, France and Japan tax-free, buying steel and components, with production, sales and admin departments.',
    orgName: 'Brennholz Precision Group GmbH (SYNTHETIC DATA)',
    legalName: LEGAL,
    countryCode: 'DE',
    currency: 'EUR',
    fiscalYearStartMonth: 1,
    timeZone: 'Europe/Berlin',
    taxRate: { name: 'USt 19% (standard)', rate: '19' },
    zeroRate: { name: 'USt 0%', rate: '0' },
    revenueAccount: '4100',
    cogsShare: '0.62',
    capital: 1500000,
    customers: [
      { name: 'Rheinwerk Maschinenbau (synthetic)', terms: 30 },
      { name: 'Great Lakes Robotics Inc., USA (synthetic)', terms: 60, countryCode: 'US', slowPayer: true },
      { name: 'Atelier Lyonnais SAS, France (synthetic)', terms: 45, countryCode: 'FR' },
      { name: 'Kansai Precision KK, Japan (synthetic)', terms: 60, countryCode: 'JP', occasional: true },
    ],
    vendors: [
      { name: 'Ruhrstahl Rohmaterial (synthetic)', terms: 30, account: '1300', description: 'Steel bar and sheet', min: 140000, max: 210000, taxed: true },
      { name: 'Schwaben Komponenten (synthetic)', terms: 30, account: '1300', description: 'Bearings and fasteners', min: 30000, max: 52000, taxed: true },
      { name: 'Elbe Spedition (synthetic)', terms: 14, account: '5000', description: 'Freight and export logistics', min: 9000, max: 16000, taxed: true },
      { name: 'Gewerbepark Leasing (synthetic)', terms: 0, account: '6200', description: 'Plant lease', min: 28000, max: 28000, taxed: true },
    ],
    offering: [
      { description: 'Precision shafts', quantity: [400, 1200], price: [95, 140] },
      { description: 'Machined housings', quantity: [150, 500], price: [210, 320] },
    ],
    projects: [
      { code: 'RW-LINE', name: 'Rheinwerk line retrofit (synthetic)', customer: 0 },
      { code: 'GLR-ARM', name: 'Great Lakes robot arm parts (synthetic)', customer: 1 },
      { code: 'KP-PILOT', name: 'Kansai pilot order (synthetic)', customer: 3 },
    ],
    departments: [
      { code: 'PRD', name: 'Production (synthetic)' },
      { code: 'SLS', name: 'Sales (synthetic)' },
      { code: 'ADM', name: 'Administration (synthetic)' },
    ],
    staff: [
      { name: 'Lukas Brandt (synthetic)', department: 'PRD', monthly: 5200 },
      { name: 'Sophie Wagner (synthetic)', department: 'PRD', monthly: 4600 },
      { name: 'Jonas Becker (synthetic)', department: 'PRD', monthly: 4300 },
      { name: 'Clara Neumann (synthetic)', department: 'SLS', monthly: 5600 },
      { name: 'Felix Hartmann (synthetic)', department: 'ADM', monthly: 4800 },
    ],
    overheads: [
      { account: '6300', department: 'PRD', memo: 'Plant energy', min: 9000, max: 16000 },
      { account: '6700', department: 'SLS', memo: 'Customer visits abroad', min: 2000, max: 7500 },
      { account: '6900', department: 'ADM', memo: 'Bank and FX charges', min: 120, max: 450 },
    ],
    payroll: false,
  },
  {
    key: 'MARKET_RESEARCH',
    title: 'Market research agency',
    summary: 'A Bengaluru research agency running surveys and focus groups for brands, with GST, respondent incentives and field partners as cost of sales, survey software and a payroll team.',
    orgName: 'Lumen Insights Research (SYNTHETIC DATA)',
    legalName: LEGAL,
    countryCode: 'IN',
    currency: 'INR',
    fiscalYearStartMonth: 4,
    timeZone: 'Asia/Kolkata',
    stateCode: '29',
    taxRate: { name: 'GST 18%', rate: '18' },
    zeroRate: null,
    revenueAccount: '4200',
    revenueHsn: '998371',
    capital: 2000000,
    customers: [
      { name: 'Brightleaf Consumer Brands (synthetic)', terms: 30, stateCode: '27', pan: 'ZZZCB2301Z' },
      { name: 'Tarang Telecom (synthetic)', terms: 45, stateCode: '29', pan: 'ZZZCT2302Z', slowPayer: true },
      { name: 'Kaveri Home Appliances (synthetic)', terms: 30, stateCode: '33', pan: 'ZZZCK2303Z' },
      { name: 'Northgate Media Labs, Singapore (synthetic)', terms: 30, countryCode: 'SG', occasional: true },
    ],
    vendors: [
      {
        name: 'PanelHive Respondent Rewards (synthetic)',
        terms: 15,
        stateCode: '29',
        pan: 'ZZZCP2401Z',
        account: '5000',
        description: 'Respondent incentives',
        min: 60000,
        max: 140000,
        taxed: true,
        hsn: '998599',
      },
      {
        name: 'FieldForce Data Collection (synthetic)',
        terms: 30,
        stateCode: '07',
        pan: 'ZZZCF2402Z',
        account: '5000',
        description: 'Field interviews and recruitment',
        min: 80000,
        max: 190000,
        taxed: true,
        hsn: '998371',
      },
      {
        name: 'QueryPoint Survey Software (synthetic)',
        terms: 0,
        stateCode: '29',
        pan: 'ZZZCQ2403Z',
        account: '6400',
        description: 'Survey platform licence',
        min: 28000,
        max: 28000,
        taxed: true,
        hsn: '997331',
      },
      {
        name: 'Indiranagar Studios (synthetic)',
        terms: 7,
        stateCode: '29',
        pan: 'ZZZCI2404Z',
        account: '6200',
        description: 'Office and focus-group studio rent',
        min: 120000,
        max: 120000,
        taxed: true,
        hsn: '997212',
      },
    ],
    offering: [{ description: 'Market research study', quantity: [1, 1], price: [220000, 680000] }],
    projects: [
      { code: 'BLF-UA', name: 'Brightleaf usage and attitude study (synthetic)', customer: 0 },
      { code: 'TRG-NPS', name: 'Tarang customer satisfaction tracker (synthetic)', customer: 1 },
      { code: 'KVR-CON', name: 'Kaveri concept test (synthetic)', customer: 2 },
      { code: 'NGM-MED', name: 'Northgate media habits survey (synthetic)', customer: 3 },
    ],
    departments: [
      { code: 'RES', name: 'Research (synthetic)' },
      { code: 'FLD', name: 'Field operations (synthetic)' },
      { code: 'ADM', name: 'Administration (synthetic)' },
    ],
    staff: [
      { name: 'Nandini Iyer (synthetic)', department: 'RES', monthly: 140000, pan: 'ZZZPI2501Z', woman: true },
      { name: 'Aditya Rao (synthetic)', department: 'RES', monthly: 85000, pan: 'ZZZPR2502Z' },
      { name: 'Pooja Hegde (synthetic)', department: 'FLD', monthly: 52000, pan: 'ZZZPH2503Z', woman: true },
      { name: 'Vikram Shetty (synthetic)', department: 'ADM', monthly: 38000, pan: 'ZZZPS2504Z' },
    ],
    overheads: [
      { account: '6700', department: 'FLD', memo: 'Field travel', min: 15000, max: 55000 },
      { account: '6300', department: 'ADM', memo: 'Internet and phones', min: 7000, max: 11000 },
      { account: '6900', department: 'ADM', memo: 'Bank charges', min: 300, max: 900 },
    ],
    payroll: true,
  },
];

export function demoProfile(key: string): DemoProfile | null {
  return DEMO_PROFILES.find((p) => p.key === key) ?? null;
}

// ------------------------------------------------------------------ the synthetic label (DEMO-020, DEMO-021)

const SYNTHETIC = /\(synthetic\b[^)]*\)/i;
const SYNTHETIC_ORG = /\(SYNTHETIC DATA\)$/;

/** Whether a record's name says it is synthetic. */
export function isSyntheticName(name: string): boolean {
  return SYNTHETIC.test(name) || SYNTHETIC_ORG.test(name);
}

/** Every name in a profile that does not say it is synthetic. An empty list means the profile may be used. */
export function demoLabelIssues(p: DemoProfile): string[] {
  const issues: string[] = [];
  if (!SYNTHETIC_ORG.test(p.orgName)) issues.push(`Organisation "${p.orgName}" must end with (SYNTHETIC DATA)`);
  if (p.legalName !== LEGAL) issues.push('The legal name must say it is a synthetic demonstration company');
  const named: [string, string][] = [
    ...p.customers.map((c) => ['Customer', c.name] as [string, string]),
    ...p.vendors.map((v) => ['Vendor', v.name] as [string, string]),
    ...p.projects.map((x) => ['Project', x.name] as [string, string]),
    ...p.departments.map((x) => ['Department', x.name] as [string, string]),
    ...p.staff.map((s) => ['Employee', s.name] as [string, string]),
  ];
  for (const [kind, name] of named) if (!SYNTHETIC.test(name)) issues.push(`${kind} "${name}" must say (synthetic)`);
  for (const c of [...p.customers, ...p.vendors]) if (c.pan && !c.pan.startsWith('ZZZ')) issues.push(`"${c.name}" must use a made-up PAN starting ZZZ`);
  for (const s of p.staff) if (s.pan && !s.pan.startsWith('ZZZ')) issues.push(`"${s.name}" must use a made-up PAN starting ZZZ`);
  return issues;
}

// ------------------------------------------------------------------ the plan

export interface DemoInvoicePlan {
  month: string;
  date: string;
  customer: number;
  project: string | null;
  reference: string;
  lines: { description: string; quantity: string; unitPrice: string }[];
  /** Exports abroad are zero-rated where the country has a zero rate, untaxed otherwise. */
  abroad: boolean;
  /** How much of the total the customer has paid, and when. */
  settle: 'FULL' | 'PART' | 'OPEN';
  settleOn: string | null;
}

export interface DemoBillPlan {
  month: string;
  date: string;
  vendor: number;
  account: string;
  description: string;
  amount: string;
  reference: string;
  settle: 'FULL' | 'OPEN';
  settleOn: string | null;
}

export interface DemoJournalPlan {
  date: string;
  memo: string;
  lines: { account: string; department: string | null; debit?: string; credit?: string }[];
}

export interface DemoPlan {
  profile: DemoProfileKey;
  /** The months covered, oldest first, ending with today's month. */
  months: string[];
  /** Fiscal years the books need, oldest first. */
  fiscalYears: number[];
  openingDate: string;
  invoices: DemoInvoicePlan[];
  bills: DemoBillPlan[];
  journals: DemoJournalPlan[];
  /** Payroll months (Indian profiles): every month before today's. */
  payrollMonths: string[];
  /** The current fiscal year's budget by account: twelve months of the plan's run rate with growth, rounded to 1,000. */
  budget: { fiscalYear: number; growth: string; lines: { account: string; annual: string }[] };
}

const pad = (n: number) => String(n).padStart(2, '0');

function monthsBack(today: string, count: number): string[] {
  const y = +today.slice(0, 4);
  const m = +today.slice(5, 7);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

/**
 * What to post for a profile, as of a date: the same profile, date and seed always give the same
 * plan. Dates never pass today; a document is settled on its due date if that has come, so the
 * latest ones are still open and one slow payer leaves an overdue balance.
 */
export function demoPlan(p: DemoProfile, opts: { today: string; months?: number; seed?: number }): DemoPlan {
  const { today } = opts;
  const months = monthsBack(today, opts.months ?? DEMO_MONTHS);
  const rand = seededRandom(opts.seed ?? 20261128);
  const whole = (min: number, max: number) => Math.round(min + rand() * (max - min)); // not money: whole units drawn, converted to decimals below
  const money = (min: number, max: number) => new D(whole(min, max)).toFixed(2);
  const day = (ym: string, d: number) => {
    const iso = `${ym}-${pad(d)}`;
    return iso > today ? today : iso;
  };
  const settle = (date: string, terms: number) => {
    const due = addDays(date, terms);
    return due <= today ? due : null;
  };
  const openingDate = `${months[0]}-01`;
  const invoices: DemoInvoicePlan[] = [];
  const bills: DemoBillPlan[] = [];
  const journals: DemoJournalPlan[] = [];
  journals.push({
    date: openingDate,
    memo: 'Share capital paid in (synthetic)',
    lines: [
      { account: '1120', department: null, debit: new D(p.capital).toFixed(2) },
      { account: '3100', department: null, credit: new D(p.capital).toFixed(2) },
    ],
  });
  months.forEach((ym, mi) => {
    const tag = ym.replace('-', '');
    // Bills first in the month, so goods are bought before they are sold.
    p.vendors.forEach((v, vi) => {
      const date = day(ym, 2 + vi);
      const settleOn = settle(date, v.terms);
      bills.push({
        month: ym,
        date,
        vendor: vi,
        account: v.account,
        description: `${v.description} (synthetic)`,
        amount: money(v.min, v.max),
        reference: `SYN-${tag}-B${vi + 1}`,
        settle: settleOn ? 'FULL' : 'OPEN',
        settleOn,
      });
    });
    const monthInvoices: DemoInvoicePlan[] = [];
    p.customers.forEach((c, ci) => {
      if (c.occasional && mi % 2 === 1) return;
      const date = day(ym, 8 + ci * 4);
      const lines = p.offering.map((o) => ({ description: `${o.description} (synthetic)`, quantity: String(whole(o.quantity[0], o.quantity[1])), unitPrice: money(o.price[0], o.price[1]) }));
      const project = p.projects.find((x) => x.customer === ci)?.code ?? null;
      const settleOn = settle(date, c.terms);
      const plan: DemoInvoicePlan = {
        month: ym,
        date,
        customer: ci,
        project,
        reference: `SYN-${tag}-C${ci + 1}`,
        lines,
        abroad: !!c.countryCode,
        settle: settleOn ? (c.slowPayer ? 'PART' : 'FULL') : 'OPEN',
        settleOn,
      };
      monthInvoices.push(plan);
    });
    invoices.push(...monthInvoices);
    if (p.cogsShare) {
      const sold = monthInvoices.reduce((s, i) => s.plus(i.lines.reduce((t, l) => t.plus(new D(l.quantity).times(l.unitPrice)), new D(0))), new D(0));
      const cost = sold.times(p.cogsShare).toDecimalPlaces(2);
      if (cost.gt(0))
        journals.push({
          date: day(ym, 27),
          memo: `Cost of goods sold ${ym} (synthetic)`,
          lines: [
            { account: '5000', department: null, debit: cost.toFixed(2) },
            { account: '1300', department: null, credit: cost.toFixed(2) },
          ],
        });
    }
    const overheads = p.overheads.map((o) => ({ account: o.account, department: o.department, debit: money(o.min, o.max) }));
    const oTotal = overheads.reduce((s, l) => s.plus(l.debit), new D(0));
    journals.push({ date: day(ym, 26), memo: `Overheads paid ${ym} (synthetic)`, lines: [...overheads, { account: '1120', department: null, credit: oTotal.toFixed(2) }] });
    if (!p.payroll && `${ym}-28` <= today) {
      const byDept = new Map<string, InstanceType<typeof D>>();
      for (const s of p.staff) byDept.set(s.department, (byDept.get(s.department) ?? new D(0)).plus(s.monthly));
      const lines = [...byDept.entries()].map(([department, x]) => ({ account: '6100', department, debit: x.toFixed(2) }));
      const total = lines.reduce((s, l) => s.plus(l.debit), new D(0));
      journals.push({ date: `${ym}-28`, memo: `Salaries ${ym} (synthetic)`, lines: [...lines, { account: '1120', department: null, credit: total.toFixed(2) }] });
    }
  });
  const fiscalYears = [...new Set([openingDate, today].map((d) => fiscalYearForDate(d, p.fiscalYearStartMonth)))].sort((a, b) => a - b);
  const payrollMonths = p.payroll ? months.filter((m) => m < today.slice(0, 7)) : [];
  return {
    profile: p.key,
    months,
    fiscalYears,
    openingDate,
    invoices,
    bills,
    journals,
    payrollMonths,
    budget: demoBudget(p, months, invoices, bills, journals, fiscalYearForDate(today, p.fiscalYearStartMonth)),
  };
}

/** Twelve months of the plan's average month, 8% higher, rounded to the nearest 1,000. */
function demoBudget(p: DemoProfile, months: string[], invoices: DemoInvoicePlan[], bills: DemoBillPlan[], journals: DemoJournalPlan[], fiscalYear: number): DemoPlan['budget'] {
  const growth = '1.08';
  const totals = new Map<string, InstanceType<typeof D>>();
  const add = (account: string, x: string | InstanceType<typeof D>) => totals.set(account, (totals.get(account) ?? new D(0)).plus(x));
  for (const i of invoices) for (const l of i.lines) add(p.revenueAccount, new D(l.quantity).times(l.unitPrice));
  for (const b of bills) if (/^[56]/.test(b.account)) add(b.account, b.amount);
  for (const j of journals) for (const l of j.lines) if (l.debit && /^[56]/.test(l.account)) add(l.account, l.debit);
  if (p.payroll) add('6100', new D(p.staff.reduce((s, x) => s + x.monthly, 0)).times(months.length)); // not money: whole-unit sum of the profile's pay
  const lines = [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([account, total]) => ({ account, annual: total.dividedBy(months.length).times(12).times(growth).dividedBy(1000).toDecimalPlaces(0).times(1000).toFixed(2) }));
  return { fiscalYear, growth: '8', lines };
}
