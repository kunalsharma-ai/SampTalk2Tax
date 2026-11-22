import { contractPeriod, type BillingTiming, type ContractFrequency, type ContractPeriod } from './contracts';
import { D } from './money';

/**
 * Contract-to-invoice matching (AR-041). Invoices raised by hand to a customer who has a
 * contract are matched to the contract they most likely bill: the same customer and currency,
 * the contract's lines (same income account, similar description), the period total, and an
 * issue date inside the contract's term. For the best match it works out which period the
 * invoice falls in and whether the contract has billed it already (billed twice), will bill it
 * next (count the invoice as that period so it is not billed again), or has earlier periods
 * still to bill; and where the invoice's prices differ from the contract's. Every figure comes
 * from the books; nothing changes until a person links or dismisses a match.
 */

export interface ContractMatchLine {
  description: string | null;
  accountId: string;
  quantity: string;
  unitPrice: string;
}

export interface MatchContract {
  id: string;
  ref: string;
  title: string;
  contactId: string;
  currency: string;
  start: string;
  end: string | null;
  frequency: ContractFrequency;
  timing: BillingTiming;
  billingDay: number | null;
  /** The next period the contract will bill or skip. */
  nextNo: number;
  /** Per period, before tax. */
  subtotal: string;
  lines: ContractMatchLine[];
  /** Periods already billed or skipped: period number → the invoice that billed it (null when skipped, or when that invoice was voided). */
  periods: Map<number, { status: 'BILLED' | 'SKIPPED'; documentId: string | null; documentNumber: string | null }>;
}

export interface MatchInvoice {
  id: string;
  number: string;
  contactId: string;
  currency: string;
  issueDate: string;
  subtotal: string;
  lines: ContractMatchLine[];
}

export type MatchConfidence = 'HIGH' | 'MEDIUM';
export type PeriodState = 'NEXT' | 'ALREADY_BILLED' | 'BILLING_VOIDED' | 'SKIPPED' | 'EARLIER_UNBILLED' | 'OUTSIDE_TERM';

export interface PriceDifference {
  description: string;
  billed: { quantity: string; unitPrice: string; amount: string };
  contract: { quantity: string; unitPrice: string; amount: string };
  /** Billed minus the contract's amount: negative is under-billed. */
  difference: string;
}

export interface ContractMatch {
  invoice: { id: string; number: string; issueDate: string; subtotal: string; currency: string };
  contract: { id: string; ref: string; title: string };
  score: number; // not money
  confidence: MatchConfidence;
  reasons: string[];
  period: { no: number; start: string; end: string; part: boolean } | null;
  periodState: PeriodState;
  /** The invoice that already billed the period, for ALREADY_BILLED. */
  billedBy: { id: string; number: string | null } | null;
  differences: PriceDifference[];
  /** Contract lines the invoice does not bill. */
  missingLines: string[];
  /** Billed minus the contract's period total, before tax (null for a part period, which is prorated). */
  totalDifference: string | null;
  /** Whether a person can count the invoice as the contract's next period. */
  canLink: boolean;
  /** What the person should do next, in a sentence. */
  advice: string;
}

/** The lowest score shown: below it a match is too weak to suggest. */
export const MIN_MATCH_SCORE = 50; // not money
const HIGH_SCORE = 80; // not money

const STOP = new Set(['the', 'and', 'for', 'of', 'to', 'a', 'an', 'in', 'on', 'with', 'per', 'fee', 'fees', 'charges', 'charge']);
const words = (s: string | null) => new Set((s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)));

/** How alike two line descriptions are, from 0 to 1 (shared words over all words). */
export function descriptionSimilarity(a: string | null, b: string | null): number {
  const x = words(a);
  const y = words(b);
  if (!x.size && !y.size) return 1; // not money
  if (!x.size || !y.size) return 0; // not money
  let shared = 0; // not money
  for (const w of x) if (y.has(w)) shared++; // not money
  return shared / (x.size + y.size - shared); // not money
}

const amount = (l: ContractMatchLine) => new D(l.quantity).mul(l.unitPrice);
const label = (l: ContractMatchLine, i: number) => l.description?.trim() || `Line ${i + 1}`;

/** The contract period whose dates contain `date`, or null when the date is outside the term. */
export function periodContaining(c: Pick<MatchContract, 'start' | 'end' | 'frequency' | 'timing' | 'billingDay'>, date: string): ContractPeriod | null {
  if (date < c.start || (c.end && date > c.end)) return null;
  for (let n = 1; n <= 1200; n++) {
    const p = contractPeriod(c.start, c.frequency, n, c.timing, { billingDay: c.billingDay, end: c.end });
    if (p.start > date) return null;
    if (date <= p.end) return p;
  }
  return null;
}

/** Pairs each contract line with the invoice line most like it (same account, closest description). */
function pairLines(c: MatchContract, inv: MatchInvoice) {
  const used = new Set<number>();
  return c.lines.map((cl) => {
    let best = -1; // not money
    let bestSim = -1; // not money
    inv.lines.forEach((il, i) => {
      if (used.has(i) || il.accountId !== cl.accountId) return;
      const sim = descriptionSimilarity(cl.description, il.description); // not money
      if (sim > bestSim) {
        bestSim = sim;
        best = i;
      }
    });
    if (best < 0 || (bestSim < 0.34 && c.lines.length > 1)) return { cl, il: null as ContractMatchLine | null };
    used.add(best);
    return { cl, il: inv.lines[best]! };
  });
}

function score(c: MatchContract, inv: MatchInvoice) {
  const reasons: string[] = [];
  const pairs = pairLines(c, inv);
  const matched = pairs.filter((p) => p.il).length; // not money
  if (!matched) return null;
  const coverage = matched / c.lines.length; // not money
  let s = Math.round(coverage * 55); // not money
  reasons.push(matched === c.lines.length ? `Bills every line of ${c.ref} (${matched} of ${c.lines.length})` : `Bills ${matched} of the ${c.lines.length} lines of ${c.ref}`);
  if (new D(inv.subtotal).eq(c.subtotal)) {
    s += 25;
    reasons.push('The total before tax is the contract\'s period total');
  } else if (pairs.every((p) => !p.il || new D(p.il.unitPrice).eq(p.cl.unitPrice))) {
    s += 15;
    reasons.push('The prices are the contract\'s');
  }
  const inTerm = periodContaining(c, inv.issueDate) !== null;
  if (inTerm) {
    s += 20;
    reasons.push('Dated within the contract\'s term');
  }
  return { score: Math.min(100, s), reasons, pairs, inTerm };
}

/**
 * The best contract match for each invoice, strongest first. Only invoices to a customer with a
 * contract in the same currency are considered; a match below MIN_MATCH_SCORE is left out.
 */
export function matchInvoicesToContracts(input: { contracts: MatchContract[]; invoices: MatchInvoice[]; scale?: number }): ContractMatch[] {
  const scale = input.scale ?? 2;
  const out: ContractMatch[] = [];
  for (const inv of input.invoices) {
    let best: { c: MatchContract; r: NonNullable<ReturnType<typeof score>> } | null = null;
    for (const c of input.contracts) {
      if (c.contactId !== inv.contactId || c.currency !== inv.currency || !c.lines.length) continue;
      const r = score(c, inv);
      if (r && r.score >= MIN_MATCH_SCORE && (!best || r.score > best.r.score)) best = { c, r };
    }
    if (!best) continue;
    const { c, r } = best;
    const p = periodContaining(c, inv.issueDate);
    let state: PeriodState;
    let billedBy: ContractMatch['billedBy'] = null;
    if (!p) state = 'OUTSIDE_TERM';
    else if (p.no < c.nextNo) {
      const done = c.periods.get(p.no);
      if (done?.status === 'BILLED' && done.documentId) {
        state = 'ALREADY_BILLED';
        billedBy = { id: done.documentId, number: done.documentNumber };
      } else if (done?.status === 'SKIPPED') state = 'SKIPPED';
      else state = 'BILLING_VOIDED';
    } else if (p.no === c.nextNo) state = 'NEXT';
    else state = 'EARLIER_UNBILLED';

    const part = !!p?.part;
    const differences: PriceDifference[] = [];
    if (!part) {
      r.pairs.forEach(({ cl, il }, i) => {
        if (!il) return;
        const billed = amount(il);
        const agreed = amount(cl);
        if (billed.eq(agreed)) return;
        differences.push({
          description: label(cl, i),
          billed: { quantity: new D(il.quantity).toFixed(), unitPrice: new D(il.unitPrice).toFixed(scale), amount: billed.toFixed(scale) },
          contract: { quantity: new D(cl.quantity).toFixed(), unitPrice: new D(cl.unitPrice).toFixed(scale), amount: agreed.toFixed(scale) },
          difference: billed.minus(agreed).toFixed(scale),
        });
      });
    }
    const missingLines = r.pairs.map((x, i) => (x.il ? null : label(x.cl, i))).filter((x): x is string => x !== null);
    const totalDifference = part ? null : new D(inv.subtotal).minus(c.subtotal).toFixed(scale);
    const advice =
      state === 'NEXT'
        ? `Count it as period ${p!.no} (${p!.start} to ${p!.end}) so ${c.ref} does not bill that period again.`
        : state === 'ALREADY_BILLED'
          ? `${c.ref} already billed period ${p!.no}${billedBy?.number ? ` on ${billedBy.number}` : ''}: the customer may be billed twice. Void one of the invoices, or dismiss this if both are right.`
          : state === 'BILLING_VOIDED'
            ? `The invoice ${c.ref} made for period ${p!.no} was voided. If this invoice replaces it, nothing is billed twice: dismiss this match.`
          : state === 'SKIPPED'
            ? `Period ${p!.no} of ${c.ref} was skipped (the contract was paused). Check the customer should be billed for it.`
            : state === 'EARLIER_UNBILLED'
              ? `${c.ref} has periods before ${p!.start} still to bill: bill those first, then count this invoice as period ${p!.no}.`
              : `Dated outside the term of ${c.ref}. Check whether the contract should be renewed or the invoice dated again.`;
    out.push({
      invoice: { id: inv.id, number: inv.number, issueDate: inv.issueDate, subtotal: new D(inv.subtotal).toFixed(scale), currency: inv.currency },
      contract: { id: c.id, ref: c.ref, title: c.title },
      score: r.score,
      confidence: r.score >= HIGH_SCORE ? 'HIGH' : 'MEDIUM',
      reasons: r.reasons,
      period: p ? { no: p.no, start: p.start, end: p.end, part } : null,
      periodState: state,
      billedBy,
      differences,
      missingLines,
      totalDifference,
      canLink: state === 'NEXT',
      advice,
    });
  }
  const rank: Record<PeriodState, number> = { ALREADY_BILLED: 0, NEXT: 1, EARLIER_UNBILLED: 2, BILLING_VOIDED: 3, SKIPPED: 4, OUTSIDE_TERM: 5 }; // not money
  return out.sort((a, b) => rank[a.periodState] - rank[b.periodState] || b.score - a.score || a.invoice.issueDate.localeCompare(b.invoice.issueDate));
}
