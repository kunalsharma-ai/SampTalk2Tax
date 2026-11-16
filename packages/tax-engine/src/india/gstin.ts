import { indiaState } from './states';

/**
 * GSTIN: 15 characters. 2-digit state code, the holder's 10-character PAN,
 * an entity number (1-9, A-Z), "Z" by default, and a check character
 * (base-36 Luhn mod N over the first 14 characters, as published by GSTN).
 *
 * This checks the format and check character only. It cannot tell whether a
 * GSTIN is registered, active or cancelled; that needs the GST portal.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SHAPE = /^(\d{2})([A-Z]{5}\d{4}[A-Z])([1-9A-Z])([A-Z])([0-9A-Z])$/;

export function gstinCheckCharacter(first14: string): string {
  if (!/^[0-9A-Z]{14}$/.test(first14)) throw new Error('Expected the first 14 characters of a GSTIN');
  let total = 0;
  for (let i = 0; i < 14; i++) {
    const product = ALPHABET.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    total += Math.floor(product / 36) + (product % 36);
  }
  return ALPHABET[(36 - (total % 36)) % 36];
}

export interface GstinCheck {
  valid: boolean;
  /** Upper-cased, trimmed input. */
  gstin: string;
  issues: string[];
  stateCode?: string;
  pan?: string;
}

export function checkGstin(input: string): GstinCheck {
  const gstin = input.trim().toUpperCase();
  const issues: string[] = [];
  const m = SHAPE.exec(gstin);
  if (gstin.length !== 15) issues.push('A GSTIN has 15 characters');
  else if (!m) issues.push('A GSTIN is a 2-digit state code, a 10-character PAN, an entity number, a letter (usually Z) and a check character');
  if (m) {
    if (!indiaState(m[1])) issues.push(`${m[1]} is not a GST state code`);
    if (gstinCheckCharacter(gstin.slice(0, 14)) !== gstin[14]) issues.push('The check character does not match; look for a typing mistake');
  }
  return { valid: issues.length === 0, gstin, issues, ...(m ? { stateCode: m[1], pan: m[2] } : {}) };
}
