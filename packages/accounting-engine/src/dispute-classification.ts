import { DISPUTE_REASON_LABEL, DISPUTE_REASONS, type DisputeReason } from './disputes';
import { daysBetween } from './documents';
import { D } from './money';
import { formatDateText } from './workflows';

/**
 * Invoice dispute classification (AR-037): the likely reason for a customer's dispute, from what
 * they said and the invoice itself. Rule-based and explained: each reason scores the phrases found
 * in the description (a telling phrase counts 2, a word 1), and two facts add 2 each: another
 * invoice to the same customer for the same total within 45 days (billed twice), and a disputed
 * amount equal to the invoice's tax (tax). The highest score is the suggestion; nothing found means
 * Other. Confidence is high at 3 or more with a lead of 2, medium at 2 or with a lead, else low.
 */

export type DisputeClassConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

type Rule = { phrases: string[]; words: string[] };
const RULES: Record<Exclude<DisputeReason, 'OTHER'>, Rule> = {
  PRICE: {
    phrases: ['agreed price', 'agreed rate', 'price difference', 'rate difference', 'wrong price', 'wrong rate', 'higher rate', 'higher price', 'as per quotation', 'as per quote', 'as per po', 'as per order', 'discount not', 'not the agreed', 'overcharged', 'over charged', 'price list'],
    words: ['price', 'prices', 'rate', 'rates', 'discount', 'quotation', 'quote', 'quoted', 'costlier', 'expensive', 'tariff', 'overcharge', 'markup'],
  },
  QUANTITY: {
    phrases: ['short supply', 'short delivered', 'short shipped', 'less quantity', 'fewer than', 'only received', 'extra units', 'more than ordered', 'quantity billed', 'billed for more', 'units missing', 'pieces missing', 'boxes missing'],
    words: ['quantity', 'qty', 'short', 'shortage', 'fewer', 'pieces', 'pcs', 'units', 'count', 'cartons', 'boxes', 'excess'],
  },
  QUALITY: {
    phrases: ['not working', 'poor quality', 'bad quality', 'arrived damaged', 'received damaged', 'not as described', 'not up to', 'below standard', 'did not work', 'does not work', 'stopped working', 'wrong item', 'wrong product', 'wrong model'],
    words: ['damaged', 'damage', 'broken', 'defective', 'defect', 'faulty', 'quality', 'leaking', 'leak', 'scratched', 'torn', 'expired', 'rejected', 'returned', 'spoiled', 'unusable'],
  },
  NOT_RECEIVED: {
    phrases: ['not received', 'never received', 'not delivered', 'never delivered', 'did not receive', 'didn t receive', 'have not received', 'haven t received', 'yet to receive', 'not arrived', 'never arrived', 'no delivery', 'service not provided', 'work not done', 'not completed'],
    words: ['undelivered', 'missing', 'lost', 'pending delivery', 'delivery'],
  },
  DUPLICATE: {
    phrases: ['billed twice', 'invoiced twice', 'charged twice', 'double billed', 'double billing', 'double charged', 'duplicate invoice', 'same invoice', 'already billed', 'already invoiced', 'billed again', 'already paid'],
    words: ['duplicate', 'twice', 'double', 'repeated', 'again'],
  },
  TAX: {
    phrases: ['wrong gst', 'gst rate', 'tax rate', 'igst instead', 'cgst and sgst', 'should be igst', 'should be cgst', 'gstin wrong', 'wrong gstin', 'place of supply', 'tds deducted', 'reverse charge', 'hsn code', 'sac code', 'tax not applicable', 'exempt from'],
    words: ['gst', 'igst', 'cgst', 'sgst', 'utgst', 'tax', 'taxes', 'gstin', 'tds', 'cess', 'vat', 'hsn', 'exempt', 'exemption'],
  },
};

export interface DisputeClassInput {
  description: string;
  /** The amount in dispute and the invoice's tax, in the invoice currency. */
  amount?: string | null;
  invoiceTax?: string | null;
  invoice?: { number: string | null; issueDate: string; total: string } | null;
  /** The customer's other invoices (not void), to spot one billed twice. */
  others?: { id: string; number: string | null; issueDate: string; total: string }[];
}

export interface DisputeClassification {
  reason: DisputeReason;
  label: string;
  confidence: DisputeClassConfidence;
  /** Why, in the order found: phrases quoted, then facts. */
  because: string[];
  scores: { reason: DisputeReason; score: number }[];
}

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** The likely reason for a dispute, with what it is based on. */
export function classifyDispute(input: DisputeClassInput): DisputeClassification {
  const text = norm(input.description);
  const score = new Map<DisputeReason, number>(DISPUTE_REASONS.map((r) => [r, 0]));
  const because = new Map<DisputeReason, string[]>(DISPUTE_REASONS.map((r) => [r, []]));
  for (const [reason, rule] of Object.entries(RULES) as [Exclude<DisputeReason, 'OTHER'>, Rule][]) {
    let rest = text;
    for (const p of rule.phrases) {
      const k = ` ${p} `;
      if (!rest.includes(k)) continue;
      score.set(reason, score.get(reason)! + 2);
      because.get(reason)!.push(`"${p}"`);
      rest = rest.split(k).join(' ');
    }
    for (const w of rule.words) {
      if (!rest.includes(` ${w} `)) continue;
      score.set(reason, score.get(reason)! + 1);
      because.get(reason)!.push(`"${w}"`);
    }
  }
  if (input.invoice && input.others?.length) {
    const twin = input.others.find((o) => new D(o.total).eq(input.invoice!.total) && Math.abs(daysBetween(o.issueDate, input.invoice!.issueDate)) <= 45);
    if (twin) {
      score.set('DUPLICATE', score.get('DUPLICATE')! + 2);
      because.get('DUPLICATE')!.push(`${twin.number ?? 'another invoice'} of ${formatDateText(twin.issueDate)} is for the same total`);
    }
  }
  if (input.amount && input.invoiceTax && new D(input.invoiceTax).gt(0) && new D(input.amount).eq(input.invoiceTax)) {
    score.set('TAX', score.get('TAX')! + 2);
    because.get('TAX')!.push("the amount in dispute is the invoice's tax");
  }
  const ranked = DISPUTE_REASONS.map((reason) => ({ reason, score: score.get(reason)! })).sort((a, b) => b.score - a.score || DISPUTE_REASONS.indexOf(a.reason) - DISPUTE_REASONS.indexOf(b.reason));
  const [top, next] = ranked as [(typeof ranked)[number], (typeof ranked)[number]];
  if (top.score === 0) return { reason: 'OTHER', label: DISPUTE_REASON_LABEL.OTHER, confidence: 'LOW', because: [], scores: ranked };
  const lead = top.score - next.score; // not money: scores
  const confidence: DisputeClassConfidence = top.score >= 3 && lead >= 2 ? 'HIGH' : top.score >= 2 && lead >= 1 ? 'MEDIUM' : 'LOW';
  return { reason: top.reason, label: DISPUTE_REASON_LABEL[top.reason], confidence, because: because.get(top.reason)!, scores: ranked };
}
