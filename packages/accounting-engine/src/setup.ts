/**
 * Organisation setup (UX-004 to UX-006, UX-014, UX-017 to UX-019): the business profile asked for
 * at onboarding, the checks that say whether the books are ready to use, and the rule for
 * activating an organisation. Pure: the API gathers the facts, this decides what they mean.
 */
import { BENCHMARK_INDUSTRIES, BENCHMARK_SIZE_BANDS, type BenchmarkIndustry, type BenchmarkSizeBand } from './benchmark';

/** Industry and size use the same lists as peer benchmarking, so one answer serves both. */
export const INDUSTRIES = BENCHMARK_INDUSTRIES;
export type Industry = BenchmarkIndustry;
export const BUSINESS_SIZES = BENCHMARK_SIZE_BANDS;
export type BusinessSize = BenchmarkSizeBand;

/** Accounting frameworks, with the countries they are usually used in (empty: any country). */
export const ACCOUNTING_FRAMEWORKS = [
  { id: 'IND_AS', name: 'Ind AS (Indian Accounting Standards converged with IFRS)', countries: ['IN'] },
  { id: 'INDIAN_GAAP', name: 'Accounting Standards (AS) under the Companies Act, Indian GAAP', countries: ['IN'] },
  { id: 'IFRS', name: 'IFRS', countries: [] },
  { id: 'IFRS_SME', name: 'IFRS for SMEs', countries: [] },
  { id: 'US_GAAP', name: 'US GAAP', countries: ['US'] },
  { id: 'FRS_102', name: 'FRS 102 (UK and Ireland)', countries: ['GB', 'IE'] },
  { id: 'FRS_105', name: 'FRS 105 (UK micro-entities)', countries: ['GB'] },
  { id: 'LOCAL_GAAP', name: 'Another local framework', countries: [] },
] as const;
export type AccountingFramework = (typeof ACCOUNTING_FRAMEWORKS)[number]['id'];

/** How much the AI agents do from the start. Every AI action still needs a person's approval. */
export const AI_PREFERENCES = [
  { id: 'OFF', name: 'Off', what: 'No AI agent runs until you turn one on in the AI control center.' },
  { id: 'ADVISE', name: 'Answers and drafts', what: 'The copilot answers questions and the virtual CFO drafts summaries. Agents that prepare entries, matches or reminders stay off.' },
  { id: 'PREPARE', name: 'Prepare work for approval', what: 'All agents are on: they also prepare bank matches, reminders and close entries, and a person approves each one.' },
] as const;
export type AiPreference = (typeof AI_PREFERENCES)[number]['id'];

/** Which agents a preference turns on, by the agent's action level (0 read-only, 1 drafts, 2 prepares changes). */
export function agentOnFor(preference: AiPreference, level: number): boolean {
  if (preference === 'OFF') return false;
  if (preference === 'ADVISE') return level <= 1;
  return true;
}

export interface SetupProfile {
  industry: Industry | null;
  size: BusinessSize | null;
  framework: AccountingFramework | null;
  aiPreference: AiPreference | null;
}

/**
 * Suggested settings from what the organisation said about itself. Suggestions only: nothing is
 * applied until a person saves them, and the framework is for the organisation's accountant to confirm.
 */
export function suggestSetup(countryCode: string, profile: Pick<SetupProfile, 'industry' | 'size'>): { framework: AccountingFramework; aiPreference: AiPreference; reasons: string[] } {
  const reasons: string[] = [];
  let framework: AccountingFramework;
  if (countryCode === 'IN') {
    framework = profile.size === 'LARGE' ? 'IND_AS' : 'INDIAN_GAAP';
    reasons.push(
      framework === 'IND_AS'
        ? 'Ind AS applies to listed companies and to companies above the net worth thresholds in the Companies (Indian Accounting Standards) Rules; confirm with your accountant.'
        : 'Most smaller Indian companies follow the Accounting Standards (AS); Ind AS applies above set thresholds or when listed. Confirm with your accountant.',
    );
  } else if (countryCode === 'US') {
    framework = 'US_GAAP';
    reasons.push('US businesses usually report under US GAAP.');
  } else if (countryCode === 'GB' || countryCode === 'IE') {
    framework = profile.size === 'MICRO' && countryCode === 'GB' ? 'FRS_105' : 'FRS_102';
    reasons.push(framework === 'FRS_105' ? 'FRS 105 is the simplest framework for UK micro-entities.' : 'FRS 102 is the usual framework for UK and Irish companies that do not use IFRS.');
  } else {
    framework = profile.size === 'LARGE' || profile.size === 'MEDIUM' ? 'IFRS' : 'IFRS_SME';
    reasons.push(framework === 'IFRS' ? 'IFRS is used in most countries for larger businesses.' : 'IFRS for SMEs is a simpler version of IFRS for smaller businesses, where local law allows it.');
  }
  const aiPreference: AiPreference = profile.size === 'MICRO' ? 'PREPARE' : 'ADVISE';
  reasons.push(
    aiPreference === 'PREPARE'
      ? 'Small teams save the most time when agents prepare matches and reminders for them to approve.'
      : 'Larger teams often start with answers and drafts, and turn on more agents once roles and approvals are set.',
  );
  return { framework, aiPreference, reasons };
}

export interface SetupFacts {
  countryCode: string;
  profile: SetupProfile;
  fiscalPeriods: number;
  bankAccounts: number;
  /** India: GST registration saved. Elsewhere: tax rates set up. */
  taxConfigured: boolean;
  openingBalancesPosted: boolean;
  customers: number;
  vendors: number;
  members: number;
  approvalRules: number;
  mailReady: boolean;
}

export type SetupStatus = 'DONE' | 'TODO';

export interface SetupCheck {
  id: string;
  title: string;
  status: SetupStatus;
  /** Required checks must be done before the organisation is activated. */
  required: boolean;
  detail: string;
  /** Where to fix it, relative to the organisation. */
  link: string;
}

/** Each setup step, whether it is done, and whether activation waits for it (UX-018). */
export function setupChecks(f: SetupFacts): SetupCheck[] {
  const india = f.countryCode === 'IN';
  const c = (id: string, title: string, done: boolean, required: boolean, doneText: string, todoText: string, link: string): SetupCheck => ({ id, title, status: done ? 'DONE' : 'TODO', required, detail: done ? doneText : todoText, link });
  const p = f.profile;
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  return [
    c('profile', 'Business profile', !!(p.industry && p.size), true, 'Industry and size are saved.', 'Choose your industry and size, so suggestions fit your business.', '/setup'),
    c('framework', 'Accounting framework', !!p.framework, true, `Reporting under ${ACCOUNTING_FRAMEWORKS.find((x) => x.id === p.framework)?.name ?? p.framework}.`, 'Choose the framework your financial statements follow.', '/setup'),
    c('periods', 'Fiscal year', f.fiscalPeriods > 0, true, `${plural(f.fiscalPeriods, 'period')} open for entries.`, 'Create the fiscal year so entries have a period to post to.', '/periods'),
    c('bank', 'Bank account', f.bankAccounts > 0, true, `${plural(f.bankAccounts, 'bank account')} in the chart.`, 'Add at least one bank account to the chart of accounts.', '/accounts'),
    c('tax', india ? 'GST registration' : 'Tax rates', f.taxConfigured, india, india ? 'GSTIN and state saved.' : 'Tax rates are set up.', india ? 'Save your GSTIN and state so invoices carry the right GST.' : 'Set up the sales tax or VAT rates you charge.', india ? '/settings/gst' : '/settings/tax-rates'),
    c('ai', 'AI preferences', !!p.aiPreference, true, `AI: ${AI_PREFERENCES.find((x) => x.id === p.aiPreference)?.name ?? p.aiPreference}.`, 'Choose how much the AI agents do; each AI action still needs approval.', '/setup'),
    c('opening', 'Opening balances', f.openingBalancesPosted, false, 'Opening balances are posted.', 'Bring in the balances from the day you start, or skip this for a new business.', '/opening-balances'),
    c('contacts', 'Customers and vendors', f.customers + f.vendors > 0, false, `${plural(f.customers, 'customer')} and ${plural(f.vendors, 'vendor')}.`, 'Add or import your customers and vendors.', '/import'),
    c('team', 'Team', f.members > 1, false, `${plural(f.members, 'member')}.`, 'Invite your accountant or team, each with a role.', '/members'),
    c('approvals', 'Approval rules', f.approvalRules > 0, false, `${plural(f.approvalRules, 'approval rule')} on.`, 'Decide which documents need a second person to approve them.', '/settings/approvals'),
    c('email', 'Email', f.mailReady, false, 'Email is ready for invoices and reminders.', 'Add a mail server to send invoices, statements and reminders.', '/settings/integrations'),
  ];
}

/** Whether every required check is done, and which are not (UX-019). */
export function canActivate(checks: SetupCheck[]): { ok: boolean; missing: string[] } {
  const missing = checks.filter((c) => c.required && c.status !== 'DONE').map((c) => c.title);
  return { ok: missing.length === 0, missing };
}
