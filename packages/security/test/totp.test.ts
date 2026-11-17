import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hashRecoveryCode, hotp, newRecoveryCodes, newTotpSecret, totpCode, totpStep, totpUri, verifyTotp } from '../src';

// RFC 6238 appendix B uses the ASCII secret "12345678901234567890" and 8 digits; the last six
// digits of each value are the 6-digit code.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 test vectors', () => {
    for (const [t, eight] of RFC_VECTORS) {
      expect(hotp(base32Decode(RFC_SECRET), Math.floor(t / 30), 8)).toBe(eight);
      expect(totpCode(RFC_SECRET, t * 1000)).toBe(eight.slice(2));
    }
  });

  it('matches the RFC 4226 HOTP vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => expect(hotp(Buffer.from('12345678901234567890'), counter)).toBe(code));
  });

  it('round-trips base32 and makes 160-bit secrets', () => {
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
    expect(base32Encode(base32Decode('JBSWY3DPEHPK3PXP'))).toBe('JBSWY3DPEHPK3PXP');
    expect(base32Decode('jbsw y3dp-ehpk 3pxp')).toEqual(base32Decode('JBSWY3DPEHPK3PXP'));
    expect(() => base32Decode('NOT1BASE32')).toThrow();
  });

  it('accepts one step of clock drift either way, not two', () => {
    const at = 1_800_000_000_000;
    const s = newTotpSecret();
    const step = totpStep(at);
    expect(verifyTotp(s, totpCode(s, at), { at })).toBe(step);
    expect(verifyTotp(s, totpCode(s, at - 30_000), { at })).toBe(step - 1);
    expect(verifyTotp(s, totpCode(s, at + 30_000), { at })).toBe(step + 1);
    expect(verifyTotp(s, totpCode(s, at - 60_000), { at })).toBeNull();
    expect(verifyTotp(s, totpCode(s, at + 60_000), { at })).toBeNull();
  });

  it('refuses a code from a step already used, and malformed codes', () => {
    const at = 1_800_000_000_000;
    const s = newTotpSecret();
    const code = totpCode(s, at);
    const step = verifyTotp(s, code, { at })!;
    expect(verifyTotp(s, code, { at, afterStep: step })).toBeNull();
    expect(verifyTotp(s, code, { at, afterStep: step - 1 })).toBe(step);
    expect(verifyTotp(s, '12345', { at })).toBeNull();
    expect(verifyTotp(s, 'abcdef', { at })).toBeNull();
    expect(verifyTotp(s, `${code.slice(0, 3)} ${code.slice(3)}`, { at })).toBe(step);
  });

  it('builds the otpauth URI authenticator apps read', () => {
    const uri = totpUri({ secret: 'JBSWY3DPEHPK3PXP', account: 'asha@example.com', issuer: 'Talk2Tax' });
    expect(uri).toBe('otpauth://totp/Talk2Tax%3Aasha%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Talk2Tax&algorithm=SHA1&digits=6&period=30');
  });

  it('makes distinct recovery codes and hashes them ignoring case and dashes', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(hashRecoveryCode(codes[0]!)).toBe(hashRecoveryCode(codes[0]!.toLowerCase().replace(/-/g, ' ')));
    expect(hashRecoveryCode(codes[0]!)).not.toBe(hashRecoveryCode(codes[1]!));
  });
});
