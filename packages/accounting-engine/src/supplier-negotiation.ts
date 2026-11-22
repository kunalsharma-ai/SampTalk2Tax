/**
 * Supplier negotiation help (AP-033): a brief per vendor that says where the organisation has
 * leverage, worked out from its own books only. Deterministic and explainable: every point says
 * what it was raised on, and every saving is an amount the books can show.
 *
 * Period: the twelve months to today against the twelve before. Amounts are in the functional
 * currency (bill amounts at their own exchange rate). An item is a line's HSN/SAC code when it
 * has one, otherwise its description, lower-cased with spaces and punctuation tidied.
 *
 * Points:
 * - VOLUME (ask): spend up 20% or more on the year before, or the vendor takes 25% or more of all
 *   spend. Ask for a volume discount or a rate card.
 * - PRICE_RISE (ask): an item bought on at least two bills whose latest unit price is 5% or more
 *   above its first one in the period. Saving: what was paid above the first price.
 * - CHEAPER_ELSEWHERE (ask): another vendor's latest price for the same item is 3% or more below
 *   this vendor's latest. Saving: the gap times the quantity bought from this vendor.
 * - GOOD_PAYER (ask): at least 3 bills paid, 90% or more of them by the due date and nothing
 *   overdue. Ask for longer terms (15 days more) or an early-payment discount.
 * - WEAK_PERFORMANCE (ask): the vendor's scorecard grade is C or D (AP-021).
 * - PAYS_LATE (caution): under 70% of at least 3 paid bills paid on time, or bills overdue now:
 *   the vendor will raise it, so settle first.
 * Target saving: per item the larger of its two savings (they overlap), added up.
 */
import { addDays, daysBetween } from './documents';
import { D, type Dec, dec, LEDGER_SCALE, minorUnits, roundToCurrency, sum } from './money';
import type { Grade } from './vendor-performance';

export const NEGOTIATION_VOLUME_GROWTH = 20;
export const NEGOTIATION_LARGE_SHARE = 25;
export const NEGOTIATION_PRICE_RISE = 5;
export const NEGOTIATION_CHEAPER_GAP = 3;
export const NEGOTIATION_GOOD_PAYER = 90;
export const NEGOTIATION_LATE_PAYER = 70;
export const NEGOTIATION_MIN_PAID = 3;
export const NEGOTIATION_EXTRA_TERMS_DAYS = 15;

export const NEGOTIATION_POINTS = ['PRICE_RISE', 'CHEAPER_ELSEWHERE', 'VOLUME', 'GOOD_PAYER', 'WEAK_PERFORMANCE', 'PAYS_LATE'] as const;
export type NegotiationPointCode = (typeof NEGOTIATION_POINTS)[number];
export const NEGOTIATION_POINT_LABEL: Record<NegotiationPointCode, string> = {
  PRICE_RISE: 'Prices went up',
  CHEAPER_ELSEWHERE: 'Cheaper elsewhere',
  VOLUME: 'You buy a lot',
  GOOD_PAYER: 'You pay on time',
  WEAK_PERFORMANCE: 'Weak scorecard',
  PAYS_LATE: 'Settle late bills first',
};

export type PaymentRecord = 'GOOD' | 'FAIR' | 'POOR' | 'NONE';
export const PAYMENT_RECORD_LABEL: Record<PaymentRecord, string> = { GOOD: 'Pays on time', FAIR: 'Mostly on time', POOR: 'Often late', NONE: 'Too few paid bills' };

export interface NegotiationBill {
  id: string;
  issueDate: string;
  dueDate: string;
  exchangeRate: string;
  /** Before tax, in the bill's currency. */
  subtotal: string;
  /** The day the bill was fully paid, or null while anything is still open. */
  paidOn: string | null;
  lines: { description: string | null; hsnCode: string | null; quantity: string; unitPrice: string }[];
}

/** Another vendor's unit price (functional currency) for an item, from a posted bill. */
export interface MarketPrice {
  vendorId: string;
  vendorName: string;
  key: string;
  issueDate: string;
  unitPrice: string;
}

export interface NegotiationInput {
  vendor: { id: string; name: string; paymentTermsDays: number };
  /** This vendor's posted bills in the twelve months to today. */
  bills: NegotiationBill[];
  /** Posted vendor credits in the period, functional currency. */
  credits: string;
  /** This vendor's spend in the twelve months before (bills less credits). */
  previousSpend: string;
  /** All vendors' spend in the period. */
  totalSpend: string;
  market: MarketPrice[];
  grade: Grade | null;
  today: string;
  currency: string;
}

export interface NegotiationItem {
  key: string;
  label: string;
  bills: number;
  quantity: string;
  spend: string;
  firstPrice: string;
  firstDate: string;
  latestPrice: string;
  latestDate: string;
  /** Latest against first, percent to one place (null with one price). */
  priceChange: string | null;
  /** Paid above the first price. */
  extraPaid: string;
  bestOther: { vendorId: string; vendorName: string; unitPrice: string; date: string; gap: string } | null;
  /** What buying this vendor's quantity at the best other price would have saved. */
  cheaperSaving: string;
}

export interface NegotiationPoint {
  code: NegotiationPointCode;
  tone: 'ASK' | 'CAUTION';
  title: string;
  detail: string;
  /** A saving the point can show, functional currency. */
  saving: string | null;
  item: string | null;
}

export interface NegotiationBrief {
  vendor: { id: string; name: string; paymentTermsDays: number };
  spend: { current: string; previous: string; change: string | null; share: string | null; bills: number };
  payments: { record: PaymentRecord; paid: number; onTime: number; onTimePercent: number | null; averageDaysLate: number | null; overdue: number };
  grade: Grade | null;
  items: NegotiationItem[];
  points: NegotiationPoint[];
  targetSaving: string;
}

/** The item a bill line is about: its HSN/SAC code, else its tidied description, else null. */
export function negotiationItemKey(line: { description: string | null; hsnCode: string | null }): string | null {
  const hsn = line.hsnCode?.replace(/\s+/g, '').toUpperCase();
  if (hsn) return `hsn:${hsn}`;
  const d = line.description?.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return d ? `desc:${d}` : null;
}

const pct = (part: Dec, whole: Dec) => part.times(100).div(whole);

function grouped(v: Dec, currency: string): string {
  const s = v.toFixed(minorUnits(currency));
  const [whole, frac] = s.replace('-', '').split('.');
  const g = currency === 'INR' ? whole!.replace(/(\d)(?=(\d\d)+\d$)/g, '$1,') : whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${v.isNegative() ? '-' : ''}${currency} ${g}${frac ? `.${frac}` : ''}`;
}

export function negotiationBrief(input: NegotiationInput): NegotiationBrief {
  const { currency, today } = input;
  const money = (v: Dec) => roundToCurrency(v, currency);
  const s = (v: Dec) => money(v).toFixed(minorUnits(currency));
  const show = (v: Dec) => grouped(money(v), currency);
  const since = addDays(today, -364);
  const bills = input.bills.filter((b) => b.issueDate >= since && b.issueDate <= today);

  // Spend.
  const current = sum(bills.map((b) => money(dec(b.subtotal).times(dec(b.exchangeRate))))).minus(dec(input.credits));
  const previous = dec(input.previousSpend);
  const total = dec(input.totalSpend);
  const change = previous.gt(0) ? pct(current.minus(previous), previous).toDecimalPlaces(1) : null;
  const share = total.gt(0) ? pct(current, total).toDecimalPlaces(1) : null;

  // Payments: bills fully paid, by the due date or not, and bills overdue today.
  const paid = bills.filter((b) => b.paidOn);
  const lateDays = paid.map((b) => Math.max(0, daysBetween(b.dueDate, b.paidOn!))); // not money
  const onTime = lateDays.filter((d) => d === 0).length; // not money
  const overdue = bills.filter((b) => !b.paidOn && b.dueDate < today).length; // not money
  const onTimePercent = paid.length ? Math.round((onTime * 1000) / paid.length) / 10 : null; // not money
  const averageDaysLate = paid.length ? Math.round((lateDays.reduce((a, d) => a + d, 0) * 10) / paid.length) / 10 : null; // not money
  let record: PaymentRecord = 'NONE';
  if (overdue > 0 || (paid.length >= NEGOTIATION_MIN_PAID && onTime * 100 < paid.length * NEGOTIATION_LATE_PAYER)) record = 'POOR';
  else if (paid.length >= NEGOTIATION_MIN_PAID) record = onTime * 100 >= paid.length * NEGOTIATION_GOOD_PAYER ? 'GOOD' : 'FAIR';

  // Items, oldest bill first so the first and latest prices are in date order.
  type Buy = { date: string; billId: string; quantity: Dec; price: Dec; label: string };
  const buys = new Map<string, Buy[]>();
  for (const b of [...bills].sort((x, y) => x.issueDate.localeCompare(y.issueDate) || x.id.localeCompare(y.id))) {
    for (const l of b.lines) {
      const key = negotiationItemKey(l);
      const q = dec(l.quantity);
      if (!key || q.lte(0)) continue;
      const list = buys.get(key) ?? [];
      list.push({ date: b.issueDate, billId: b.id, quantity: q, price: dec(l.unitPrice).times(dec(b.exchangeRate)).toDecimalPlaces(LEDGER_SCALE), label: l.description?.trim() || (l.hsnCode ?? '').trim() });
      buys.set(key, list);
    }
  }
  // Each other vendor's latest price per item.
  const latestOther = new Map<string, Map<string, MarketPrice>>();
  for (const m of input.market) {
    if (m.vendorId === input.vendor.id || m.issueDate < since || m.issueDate > today) continue;
    const byVendor = latestOther.get(m.key) ?? new Map<string, MarketPrice>();
    const was = byVendor.get(m.vendorId);
    if (!was || m.issueDate > was.issueDate) byVendor.set(m.vendorId, m);
    latestOther.set(m.key, byVendor);
  }

  const items: NegotiationItem[] = [];
  const points: NegotiationPoint[] = [];
  const itemSavings: Dec[] = [];
  for (const [key, list] of buys) {
    const first = list[0]!;
    const latest = list[list.length - 1]!;
    const quantity = sum(list.map((b) => b.quantity));
    const spend = money(sum(list.map((b) => b.quantity.times(b.price))));
    const billCount = new Set(list.map((b) => b.billId)).size; // not money
    const priceChange = billCount > 1 && first.price.gt(0) ? pct(latest.price.minus(first.price), first.price).toDecimalPlaces(1) : null;
    const extraPaid = money(sum(list.filter((b) => b.price.gt(first.price)).map((b) => b.price.minus(first.price).times(b.quantity))));
    const others = [...(latestOther.get(key)?.values() ?? [])].sort((a, b) => dec(a.unitPrice).cmp(dec(b.unitPrice)) || a.vendorName.localeCompare(b.vendorName));
    const best = others[0];
    const gap = best && latest.price.gt(0) ? pct(latest.price.minus(dec(best.unitPrice)), latest.price).toDecimalPlaces(1) : null;
    const cheaper = best && gap && gap.gte(NEGOTIATION_CHEAPER_GAP) ? money(latest.price.minus(dec(best.unitPrice)).times(quantity)) : new D(0);
    const label = latest.label || key.replace(/^(hsn|desc):/, '');
    items.push({
      key,
      label,
      bills: billCount,
      quantity: quantity.toFixed(),
      spend: s(spend),
      firstPrice: first.price.toDecimalPlaces(minorUnits(currency)).toFixed(minorUnits(currency)),
      firstDate: first.date,
      latestPrice: latest.price.toDecimalPlaces(minorUnits(currency)).toFixed(minorUnits(currency)),
      latestDate: latest.date,
      priceChange: priceChange?.toFixed(1) ?? null,
      extraPaid: s(extraPaid),
      bestOther: best && gap ? { vendorId: best.vendorId, vendorName: best.vendorName, unitPrice: dec(best.unitPrice).toDecimalPlaces(minorUnits(currency)).toFixed(minorUnits(currency)), date: best.issueDate, gap: gap.toFixed(1) } : null,
      cheaperSaving: s(cheaper),
    });
    const risen = priceChange && priceChange.gte(NEGOTIATION_PRICE_RISE);
    if (risen) {
      points.push({
        code: 'PRICE_RISE',
        tone: 'ASK',
        title: `${label}: price up ${priceChange.toFixed(1)}%`,
        detail: `The unit price went from ${show(first.price)} on ${first.date} to ${show(latest.price)} on ${latest.date}. You paid ${show(extraPaid)} more than the first price would have cost. Ask to go back to ${show(first.price)}, or for the reason and a fixed price for the next year.`,
        saving: s(extraPaid),
        item: key,
      });
    }
    if (cheaper.gt(0) && best && gap) {
      points.push({
        code: 'CHEAPER_ELSEWHERE',
        tone: 'ASK',
        title: `${label}: ${gap.toFixed(1)}% cheaper from ${best.vendorName}`,
        detail: `${best.vendorName} billed ${show(dec(best.unitPrice))} a unit on ${best.issueDate}; this vendor's latest is ${show(latest.price)}. On the ${quantity.toFixed()} units you bought in the year that is ${show(cheaper)}. Ask them to match, or move some of the volume.`,
        saving: s(cheaper),
        item: key,
      });
    }
    itemSavings.push(D.max(risen ? extraPaid : new D(0), cheaper));
  }
  items.sort((a, b) => dec(b.spend).cmp(dec(a.spend)) || a.label.localeCompare(b.label));

  if (current.gt(0) && ((change && change.gte(NEGOTIATION_VOLUME_GROWTH)) || (share && share.gte(NEGOTIATION_LARGE_SHARE)))) {
    const why = [change && change.gte(NEGOTIATION_VOLUME_GROWTH) ? `your spend rose ${change.toFixed(1)}% to ${show(current)} on the year before` : null, share && share.gte(NEGOTIATION_LARGE_SHARE) ? `they take ${share.toFixed(1)}% of everything you buy` : null].filter(Boolean);
    points.push({ code: 'VOLUME', tone: 'ASK', title: 'Ask for a volume discount', detail: `In the last twelve months ${why.join(', and ')}. Ask for a volume discount or a rate card for the coming year.`, saving: null, item: null });
  }
  if (record === 'GOOD') {
    points.push({
      code: 'GOOD_PAYER',
      tone: 'ASK',
      title: 'Ask for better terms',
      detail: `You paid ${onTime} of ${paid.length} bills by the due date and nothing is overdue. Ask for ${input.vendor.paymentTermsDays + NEGOTIATION_EXTRA_TERMS_DAYS} days instead of ${input.vendor.paymentTermsDays}, or for a discount for paying early.`,
      saving: null,
      item: null,
    });
  }
  if (input.grade === 'C' || input.grade === 'D') {
    points.push({ code: 'WEAK_PERFORMANCE', tone: 'ASK', title: `Scorecard grade ${input.grade}`, detail: `Their delivery, quality and billing scored grade ${input.grade} on the vendor scorecard. Use the late or rejected deliveries to ask for a better price, service credits or firmer delivery dates.`, saving: null, item: null });
  }
  if (record === 'POOR') {
    const parts = [paid.length ? `${paid.length - onTime} of ${paid.length} paid bills were paid late` : null, overdue ? `${overdue} ${overdue === 1 ? 'bill is' : 'bills are'} overdue now` : null].filter(Boolean);
    points.push({ code: 'PAYS_LATE', tone: 'CAUTION', title: 'Settle late bills first', detail: `${parts.join(', and ')}. The vendor will raise this, so clear what is overdue before asking for better prices or terms.`, saving: null, item: null });
  }
  const order = (c: NegotiationPointCode) => NEGOTIATION_POINTS.indexOf(c); // not money
  points.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'CAUTION' ? -1 : 1) || dec(b.saving ?? '0').cmp(dec(a.saving ?? '0')) || order(a.code) - order(b.code) || a.title.localeCompare(b.title));

  return {
    vendor: input.vendor,
    spend: { current: s(current), previous: s(previous), change: change?.toFixed(1) ?? null, share: share?.toFixed(1) ?? null, bills: bills.length },
    payments: { record, paid: paid.length, onTime, onTimePercent, averageDaysLate, overdue },
    grade: input.grade,
    items,
    points,
    targetSaving: s(sum(itemSavings)),
  };
}
