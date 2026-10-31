import Decimal from 'decimal.js';

/**
 * All monetary arithmetic goes through this isolated Decimal constructor.
 * Binary floating point is never used for money: inputs are accepted as
 * strings (or Decimals) only, and JS numbers are rejected at the boundary.
 */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
export type Dec = InstanceType<typeof D>;

/** Maximum digits after the decimal point the ledger stores (NUMERIC(24,6)). */
export const LEDGER_SCALE = 6;
/** Exchange rates are stored with NUMERIC(24,10). */
export const RATE_SCALE = 10;

/**
 * ISO 4217 minor units for currencies the platform currently recognises.
 * Unknown currencies are rejected rather than guessed.
 */
export const CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = Object.freeze({
  AED: 2, AUD: 2, BHD: 3, BRL: 2, CAD: 2, CHF: 2, CNY: 2, DKK: 2, EUR: 2, GBP: 2,
  HKD: 2, IDR: 2, INR: 2, JOD: 3, JPY: 0, KRW: 0, KWD: 3, LKR: 2, MXN: 2, MYR: 2,
  NOK: 2, NZD: 2, OMR: 3, PHP: 2, PKR: 2, QAR: 2, SAR: 2, SEK: 2, SGD: 2, THB: 2,
  USD: 2, ZAR: 2, BDT: 2, NPR: 2, KES: 2, NGN: 2, EGP: 2, TRY: 2, PLN: 2, CZK: 2,
});

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function isSupportedCurrency(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(CURRENCY_MINOR_UNITS, code);
}

export function minorUnits(currency: string): number {
  const units = CURRENCY_MINOR_UNITS[currency];
  if (units === undefined) throw new MoneyError(`Unsupported currency: ${currency}`);
  return units;
}

const DECIMAL_STRING = /^-?\d{1,18}(\.\d{1,10})?$/;

/** Parse a decimal string into a Decimal. JS numbers are refused on purpose. */
export function dec(value: string | Dec): Dec {
  if (value instanceof D) return value;
  if (typeof value !== 'string') {
    throw new MoneyError('Monetary values must be passed as decimal strings, never as JS numbers');
  }
  const trimmed = value.trim();
  if (!DECIMAL_STRING.test(trimmed)) throw new MoneyError(`Invalid decimal amount: "${value}"`);
  return new D(trimmed);
}

/** Round to a currency's minor units using banker's rounding (half-even). */
export function roundToCurrency(value: Dec, currency: string): Dec {
  return value.toDecimalPlaces(minorUnits(currency), Decimal.ROUND_HALF_EVEN);
}

/** Validate that an amount has no more precision than the currency allows. */
export function assertCurrencyPrecision(value: Dec, currency: string, label = 'Amount'): void {
  if (value.decimalPlaces() > minorUnits(currency)) {
    throw new MoneyError(`${label} ${value.toFixed()} has more decimal places than ${currency} allows (${minorUnits(currency)})`);
  }
}

export function sum(values: Iterable<Dec>): Dec {
  let total = new D(0);
  for (const v of values) total = total.plus(v);
  return total;
}

/** Canonical string for persistence / API output. */
export function fmt(value: Dec, scale = 2): string {
  return value.toFixed(scale);
}
