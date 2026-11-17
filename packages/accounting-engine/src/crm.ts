import { D } from './money';

/**
 * CRM pipeline rules (CRM slice 1): leads, deals and the pipeline summary. The server applies
 * these and the web shows them, so both sides agree on what each step means.
 *
 * A lead is someone who might buy: NEW, then CONTACTED, then QUALIFIED; or DISQUALIFIED with a
 * reason. A qualified lead is converted once into a customer (a contact) and, optionally, a deal.
 * A converted lead is closed for good.
 *
 * A deal is a sale being worked on for a customer, moving through PROSPECTING, QUALIFICATION,
 * PROPOSAL and NEGOTIATION to WON or LOST. Each open stage has a default win probability that the
 * user may override; WON is 100 and LOST is 0. A closed deal can be reopened, which is recorded.
 */

export const LEAD_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'DISQUALIFIED', 'CONVERTED'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_SOURCES = ['WEBSITE', 'REFERRAL', 'EVENT', 'OUTBOUND', 'PARTNER', 'ADVERTISING', 'OTHER'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const DEAL_STAGES = ['PROSPECTING', 'QUALIFICATION', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'] as const;
export type DealStage = (typeof DEAL_STAGES)[number];
export const OPEN_DEAL_STAGES = ['PROSPECTING', 'QUALIFICATION', 'PROPOSAL', 'NEGOTIATION'] as const satisfies readonly DealStage[];

/** The win probability a deal takes when it enters a stage, unless the user sets another. */
export const DEAL_STAGE_PROBABILITY: Record<DealStage, number> = { PROSPECTING: 10, QUALIFICATION: 25, PROPOSAL: 50, NEGOTIATION: 75, WON: 100, LOST: 0 };

export const DEAL_STAGE_LABEL: Record<DealStage, string> = { PROSPECTING: 'Prospecting', QUALIFICATION: 'Qualification', PROPOSAL: 'Proposal', NEGOTIATION: 'Negotiation', WON: 'Won', LOST: 'Lost' };
export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = { NEW: 'New', CONTACTED: 'Contacted', QUALIFIED: 'Qualified', DISQUALIFIED: 'Disqualified', CONVERTED: 'Converted' };
export const LEAD_SOURCE_LABEL: Record<LeadSource, string> = { WEBSITE: 'Website', REFERRAL: 'Referral', EVENT: 'Event', OUTBOUND: 'Outbound', PARTNER: 'Partner', ADVERTISING: 'Advertising', OTHER: 'Other' };

export class CrmError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const isOpenStage = (s: DealStage) => s !== 'WON' && s !== 'LOST';

/**
 * Whether a lead may move from one status to another. Converting goes through conversion, never
 * a plain status change; a converted lead never moves again; a disqualified lead may be reopened
 * to NEW or CONTACTED.
 */
export function leadTransition(from: LeadStatus, to: LeadStatus, reason?: string | null): void {
  if (from === to) throw new CrmError('LEAD_SAME_STATUS', `The lead is already ${LEAD_STATUS_LABEL[to].toLowerCase()}`);
  if (from === 'CONVERTED') throw new CrmError('LEAD_CONVERTED', 'A converted lead is closed; work on its customer and deal instead');
  if (to === 'CONVERTED') throw new CrmError('LEAD_CONVERT_ONLY', 'Convert a qualified lead to make it a customer');
  if (to === 'DISQUALIFIED' && !reason?.trim()) throw new CrmError('LEAD_REASON_REQUIRED', 'Say why the lead is disqualified');
  if (from === 'DISQUALIFIED' && to === 'QUALIFIED') throw new CrmError('LEAD_REOPEN_FIRST', 'Reopen a disqualified lead as new or contacted before qualifying it');
}

/** A lead is converted only once it is qualified. */
export function leadConvertible(status: LeadStatus): void {
  if (status === 'CONVERTED') throw new CrmError('LEAD_CONVERTED', 'This lead has already been converted');
  if (status !== 'QUALIFIED') throw new CrmError('LEAD_NOT_QUALIFIED', 'Qualify the lead before converting it');
}

/**
 * The probability a deal has after moving to a stage. Moving to an open stage takes that stage's
 * default unless a probability is given; WON and LOST are always 100 and 0. Losing needs a reason.
 */
export function dealStageChange(from: DealStage, to: DealStage, opts: { probability?: number | null; lostReason?: string | null } = {}): { probability: number; closes: boolean; reopens: boolean } {
  if (from === to && opts.probability === undefined) throw new CrmError('DEAL_SAME_STAGE', `The deal is already at ${DEAL_STAGE_LABEL[to].toLowerCase()}`);
  if (to === 'LOST' && !opts.lostReason?.trim()) throw new CrmError('DEAL_REASON_REQUIRED', 'Say why the deal was lost');
  if (!isOpenStage(to) && opts.probability != null && opts.probability !== DEAL_STAGE_PROBABILITY[to]) {
    throw new CrmError('DEAL_PROBABILITY', `A ${DEAL_STAGE_LABEL[to].toLowerCase()} deal has a probability of ${DEAL_STAGE_PROBABILITY[to]}%`);
  }
  const probability = isOpenStage(to) ? (opts.probability ?? DEAL_STAGE_PROBABILITY[to]) : DEAL_STAGE_PROBABILITY[to];
  checkProbability(probability);
  return { probability, closes: isOpenStage(from) && !isOpenStage(to), reopens: !isOpenStage(from) && isOpenStage(to) };
}

export function checkProbability(p: number): void {
  if (!Number.isInteger(p) || p < 0 || p > 100) throw new CrmError('DEAL_PROBABILITY', 'Give the probability as a whole percentage from 0 to 100');
}

/** The value of a deal weighted by its probability, to the currency's decimal places. */
export function weightedValue(amount: string, probability: number, scale: number): string {
  checkProbability(probability);
  return new D(amount).times(probability).div(100).toDecimalPlaces(scale, D.ROUND_HALF_EVEN).toFixed(scale);
}

export interface PipelineDeal {
  stage: DealStage;
  amount: string;
  probability: number;
  ownerId: string | null;
  /** YYYY-MM-DD */
  expectedCloseDate: string;
  /** YYYY-MM-DD, when won or lost. */
  closedOn: string | null;
  /** YYYY-MM-DD, when the deal was created (India time). */
  createdOn: string;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * The pipeline at a glance: open deals by stage with their total and weighted value, overdue
 * deals (expected to close before today and still open), and the win rate, value won and average
 * days to win over a trailing window of closed deals.
 */
export function pipelineSummary(deals: PipelineDeal[], today: string, scale: number, windowDays = 90) {
  const sum = (xs: PipelineDeal[], f: (d: PipelineDeal) => string) => xs.reduce((t, d) => t.plus(f(d)), new D(0)).toFixed(scale);
  const open = deals.filter((d) => isOpenStage(d.stage));
  const stages = OPEN_DEAL_STAGES.map((stage) => {
    const xs = open.filter((d) => d.stage === stage);
    return { stage, count: xs.length, amount: sum(xs, (d) => d.amount), weighted: sum(xs, (d) => weightedValue(d.amount, d.probability, scale)) };
  });
  const since = addDays(today, -windowDays);
  const closed = deals.filter((d) => d.closedOn && d.closedOn > since && d.closedOn <= today);
  const won = closed.filter((d) => d.stage === 'WON');
  const lost = closed.filter((d) => d.stage === 'LOST');
  const overdue = open.filter((d) => d.expectedCloseDate < today);
  return {
    open: { count: open.length, amount: sum(open, (d) => d.amount), weighted: sum(open, (d) => weightedValue(d.amount, d.probability, scale)) },
    stages,
    overdue: { count: overdue.length, amount: sum(overdue, (d) => d.amount) },
    window: {
      days: windowDays,
      won: won.length,
      lost: lost.length,
      wonAmount: sum(won, (d) => d.amount),
      /** Won as a share of closed, as a whole percentage; null with nothing closed. */
      winRate: closed.length ? Math.round((won.length / closed.length) * 100) : null,
      /** Average days from creation to won; null with nothing won. */
      averageDaysToWin: won.length ? Math.round(won.reduce((t, d) => t + daysBetween(d.createdOn, d.closedOn!), 0) / won.length) : null,
    },
  };
}

/** Open deals' weighted value by the month they are expected to close; overdue deals count in this month. */
export function weightedByCloseMonth(deals: PipelineDeal[], today: string, scale: number, months = 6) {
  const first = today.slice(0, 7);
  const keys: string[] = [];
  let y = +first.slice(0, 4);
  let m = +first.slice(5, 7);
  for (let i = 0; i < months; i++) {
    keys.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m === 13) {
      m = 1;
      y += 1;
    }
  }
  const rows = keys.map((month) => ({ month, count: 0, amount: new D(0), weighted: new D(0) }));
  let later = { count: 0, amount: new D(0), weighted: new D(0) };
  for (const d of deals.filter((x) => isOpenStage(x.stage))) {
    const key = d.expectedCloseDate.slice(0, 7) < first ? first : d.expectedCloseDate.slice(0, 7);
    const row = rows.find((r) => r.month === key) ?? later;
    row.count += 1;
    row.amount = row.amount.plus(d.amount);
    row.weighted = row.weighted.plus(weightedValue(d.amount, d.probability, scale));
    if (row === later) later = row;
  }
  const out = (r: { count: number; amount: InstanceType<typeof D>; weighted: InstanceType<typeof D> }) => ({ count: r.count, amount: r.amount.toFixed(scale), weighted: r.weighted.toFixed(scale) });
  return { months: rows.map((r) => ({ month: r.month, ...out(r) })), later: out(later) };
}

/** Normalise an email for matching duplicates: trimmed and lower case. */
export const normalEmail = (e: string | null | undefined) => (e?.trim() ? e.trim().toLowerCase() : null);
