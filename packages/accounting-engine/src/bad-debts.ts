import { AGEING_BUCKETS, AgeingBucket } from './documents';
import { assertCurrencyPrecision, D, dec, Dec, minorUnits } from './money';

/**
 * Bad debts (AR-026 provisions, AR-027 write-offs). These are the rules the server applies and the
 * web shows.
 *
 * A **provision** (allowance for doubtful debts) is worked out from the receivables ageing as of a
 * date: each open invoice amount, in the functional currency, times the percentage for its ageing
 * bucket (a provision matrix, the simplified expected-credit-loss approach of IFRS 9 / Ind AS 109),
 * or times a percentage set for that invoice when it is doubtful on its own (a specific
 * provision). The books then carry the allowance at that figure: the posting is the difference
 * between it and the allowance account's balance.
 *
 * A **write-off** settles what is left on an invoice the customer will not pay: the receivable goes
 * to the bad-debt expense, or to the allowance when one was made for it.
 */

export const PROVISION_BUCKET_LABEL: Record<AgeingBucket, string> = {
  current: 'Not yet due',
  days1to30: '1-30 days overdue',
  days31to60: '31-60 days overdue',
  days61to90: '61-90 days overdue',
  over90: 'Over 90 days overdue',
};

/** A starting matrix (percent of the open amount); each organisation sets its own from its history. */
export const DEFAULT_PROVISION_RATES: Record<AgeingBucket, string> = { current: '1', days1to30: '3', days31to60: '10', days61to90: '25', over90: '50' };

export class BadDebtError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const PCT = /^\d{1,3}(\.\d{1,4})?$/;

/** Problems with a set of percentages: each from 0 to 100, at most four decimals. */
export function rateIssues(rates: Record<string, string>, labelFor: (k: string) => string = (k) => k): string[] {
  const issues: string[] = [];
  for (const [k, v] of Object.entries(rates)) {
    if (!PCT.test(v) || new D(v).gt(100)) issues.push(`${labelFor(k)}: enter a percentage from 0 to 100`);
  }
  return issues;
}

export interface ProvisionItem {
  bucket: AgeingBucket;
  /** Open amount in the functional currency. */
  open: string;
  /** Percent for this invoice alone (a specific provision); null uses its bucket's rate. */
  specificPercent?: string | null;
}

export interface ProvisionResult {
  buckets: { bucket: AgeingBucket; open: string; rate: string; provision: string; invoices: number }[];
  specific: { open: string; provision: string; invoices: number };
  open: string;
  total: string;
}

/**
 * The allowance the receivables call for: per bucket, the bucket's open amount times its rate
 * (rounded once per bucket), plus each specifically provided invoice at its own percentage.
 */
export function provisionMatrix(items: ProvisionItem[], rates: Record<AgeingBucket, string>, currency: string): ProvisionResult {
  const scale = minorUnits(currency);
  const round = (x: Dec) => x.toDecimalPlaces(scale, D.ROUND_HALF_EVEN);
  const open = Object.fromEntries(AGEING_BUCKETS.map((b) => [b, { open: new D(0), n: 0 }])) as Record<AgeingBucket, { open: Dec; n: number }>;
  let specOpen = new D(0);
  let specProv = new D(0);
  let specN = 0;
  for (const i of items) {
    const amount = dec(i.open);
    if (amount.lte(0)) continue;
    if (i.specificPercent !== null && i.specificPercent !== undefined) {
      specOpen = specOpen.plus(amount);
      specProv = specProv.plus(round(amount.times(i.specificPercent).div(100)));
      specN++;
    } else {
      open[i.bucket].open = open[i.bucket].open.plus(amount);
      open[i.bucket].n++;
    }
  }
  const buckets = AGEING_BUCKETS.map((b) => {
    const provision = round(open[b].open.times(rates[b]).div(100));
    return { bucket: b, open: open[b].open.toFixed(scale), rate: new D(rates[b]).toFixed(), provision: provision.toFixed(scale), invoices: open[b].n };
  });
  const total = buckets.reduce((s, b) => s.plus(b.provision), specProv);
  const allOpen = AGEING_BUCKETS.reduce((s, b) => s.plus(open[b].open), specOpen);
  return { buckets, specific: { open: specOpen.toFixed(scale), provision: specProv.toFixed(scale), invoices: specN }, open: allOpen.toFixed(scale), total: total.toFixed(scale) };
}

/**
 * The posting that brings the allowance from its balance in the books to the figure required:
 * above zero raises it (Dr bad-debt expense, Cr allowance), below zero releases the excess.
 */
export function provisionAdjustment(required: string, carried: string, currency: string): string {
  return dec(required).minus(dec(carried)).toFixed(minorUnits(currency));
}

/** Problems with writing off `amount` of an invoice with `open` left (both in the invoice currency). */
export function writeOffIssues(amount: string, open: string, currency: string): string[] {
  const issues: string[] = [];
  let a: Dec;
  try {
    a = dec(amount);
  } catch {
    return ['The amount is not a number'];
  }
  if (a.lte(0)) issues.push('The amount to write off must be greater than zero');
  try {
    assertCurrencyPrecision(a, currency, 'The amount');
  } catch (e) {
    issues.push((e as Error).message);
  }
  if (a.gt(dec(open))) issues.push(`Only ${dec(open).toFixed(minorUnits(currency))} ${currency} is still due on this invoice`);
  return issues;
}
