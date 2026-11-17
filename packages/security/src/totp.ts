import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226 HOTP), the codes authenticator apps
 * (Google Authenticator, Microsoft Authenticator, 1Password, Authy) show. SHA-1, 6 digits and
 * 30-second steps, because that is what every app supports when it scans a QR code.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** RFC 4648 base32 without padding, as otpauth:// URIs carry it. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Not a base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret (the length RFC 4226 recommends for SHA-1), base32. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The HOTP value for one counter. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(code % 10 ** digits).padStart(digits, '0');
}

/** The time step a moment falls in. */
export function totpStep(at: Date | number = Date.now()): number {
  const ms = typeof at === 'number' ? at : at.getTime();
  return Math.floor(ms / 1000 / TOTP_STEP_SECONDS);
}

export function totpCode(secretBase32: string, at: Date | number = Date.now()): string {
  return hotp(base32Decode(secretBase32), totpStep(at));
}

/**
 * The step a code matches, allowing one step either side for clock drift, or null. A step at or
 * below `afterStep` is refused even if it matches, so a code cannot be used twice.
 */
export function verifyTotp(secretBase32: string, code: string, opts: { at?: Date | number; window?: number; afterStep?: number | null } = {}): number | null {
  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const key = base32Decode(secretBase32);
  const now = totpStep(opts.at ?? Date.now());
  const window = opts.window ?? 1;
  let matched: number | null = null;
  for (let s = now - window; s <= now + window; s++) {
    const expected = Buffer.from(hotp(key, s));
    // Compare every candidate in constant time; keep the latest match.
    if (timingSafeEqual(expected, Buffer.from(digits))) matched = s;
  }
  if (matched === null) return null;
  if (opts.afterStep !== undefined && opts.afterStep !== null && matched <= opts.afterStep) return null;
  return matched;
}

/** The otpauth:// URI an authenticator app reads from a QR code. */
export function totpUri(opts: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.account}`);
  const q = new URLSearchParams({ secret: opts.secret, issuer: opts.issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${q.toString()}`;
}

/** Ten single-use recovery codes like `7KQ4-M2XD-9FHA`, for when the phone is lost. */
export function newRecoveryCodes(count = 10): string[] {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(12);
    const chars = Array.from(bytes, (b) => alphabet[b & 31]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  });
}

/** Recovery codes are kept only as SHA-256 hashes of their normalised form. */
export function normaliseRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(`t2t-recovery:${normaliseRecoveryCode(code)}`).digest('hex');
}
