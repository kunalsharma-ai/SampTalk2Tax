import { Decimal128 } from 'mongodb';

/**
 * Money and quantities are decimal strings in the application ("1234.50") and Decimal128 in
 * MongoDB. JavaScript numbers are never accepted for a decimal field: a float would already
 * have lost precision before it reached us.
 */

/** Up to 28 integer digits and 12 decimal places: wider than any amount the ledger stores. */
const DECIMAL_STRING = /^-?\d{1,28}(\.\d{1,12})?$/;

export class DecimalFieldError extends Error {
  constructor(path: string, value: unknown) {
    super(`Field "${path}" must be a decimal string such as "1250.00", got ${describe(value)}`);
    this.name = 'DecimalFieldError';
  }
}

function describe(value: unknown): string {
  if (typeof value === 'number') return `the number ${value} (numbers are refused for money)`;
  if (typeof value === 'string') return `"${value}"`;
  return value === null ? 'null' : typeof value;
}

export function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_STRING.test(value);
}

/** Converts a decimal string to Decimal128, refusing anything else. */
export function toDecimal128(value: unknown, path = 'value'): Decimal128 {
  if (value instanceof Decimal128) {
    decimalToString(value); // refuses NaN and Infinity
    return value;
  }
  if (!isDecimalString(value)) throw new DecimalFieldError(path, value);
  return Decimal128.fromString(value);
}

/** Short alias for building aggregation stages and filters by hand. */
export const dec = (value: string): Decimal128 => toDecimal128(value);

/**
 * Decimal128 to a plain decimal string. MongoDB arithmetic can return exponent notation
 * ("1.2E+3", "0E-10"); this always returns positional notation, keeping the scale.
 */
export function decimalToString(value: Decimal128): string {
  const raw = value.toString();
  if (/^-?(NaN|Inf)/i.test(raw)) throw new Error(`Decimal128 value ${raw} is not a number`);
  const m = /^(-?)(\d+)(?:\.(\d+))?E([+-]\d+)$/i.exec(raw);
  if (!m) return raw.startsWith('-') && !/[1-9]/.test(raw) ? raw.slice(1) : raw; // no negative zero
  const [, sign, intPart, fracPart = '', expText] = m;
  const exp = Number(expText);
  let digits = intPart + fracPart;
  let point = intPart.length + exp;
  if (point <= 0) {
    digits = '0'.repeat(1 - point) + digits;
    point = 1;
  } else if (point > digits.length) {
    digits = digits + '0'.repeat(point - digits.length);
  }
  let whole = digits.slice(0, point).replace(/^0+(?=\d)/, '');
  const frac = digits.slice(point);
  if (whole === '') whole = '0';
  const text = frac ? `${whole}.${frac}` : whole;
  return sign && /[1-9]/.test(text) ? `-${text}` : text;
}

/** Recursively turns every Decimal128 in a value read from MongoDB into a decimal string. */
export function decodeDecimals<T>(value: T): T {
  if (value instanceof Decimal128) return decimalToString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => decodeDecimals(v)) as unknown as T;
  if (value && typeof value === 'object' && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = decodeDecimals(v);
    return out as T;
  }
  return value;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
