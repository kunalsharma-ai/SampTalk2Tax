/**
 * Customer portal (AR-030). A customer opens a private link to see their invoices, statement and
 * payment links without signing in. The link carries a secret token; only its SHA-256 is stored.
 */

/** t2tp_ followed by 40 letters and digits (about 238 bits). */
export const PORTAL_TOKEN_PATTERN = /^t2tp_[A-Za-z0-9]{40}$/;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Makes a token from random bytes (rejection sampling, so every character is equally likely). */
export function makePortalToken(random: (n: number) => Uint8Array): string {
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < 40) for (const b of random(64)) if (b < limit && out.length < 40) out += ALPHABET[b % ALPHABET.length];
  return `t2tp_${out}`;
}

/** The part of a token shown in lists so a link can be recognised: its first 8 characters after t2tp_. */
export const portalTokenPrefix = (token: string) => token.slice(5, 13);

export const PORTAL_EXPIRY_DAYS = [30, 90, 180, 365] as const;

export type PortalLinkState = 'ACTIVE' | 'EXPIRED' | 'REVOKED';
export function portalLinkState(l: { revokedAt: Date | null; expiresAt: Date | null }, now: Date): PortalLinkState {
  if (l.revokedAt) return 'REVOKED';
  if (l.expiresAt && l.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return 'ACTIVE';
}

/** How an invoice stands for the customer: what they still owe on it, by its own currency. */
export type PortalInvoiceState = 'OPEN' | 'OVERDUE' | 'PART_PAID' | 'PAID' | 'VOID';
export function portalInvoiceState(d: { status: string; total: string; open: string; dueDate: string | null }, today: string): PortalInvoiceState {
  if (d.status === 'VOID') return 'VOID';
  if (Number(d.open) <= 0) return 'PAID';
  if (d.dueDate && d.dueDate < today) return 'OVERDUE';
  return Number(d.open) < Number(d.total) ? 'PART_PAID' : 'OPEN';
}
