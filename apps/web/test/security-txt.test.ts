import { describe, expect, it } from 'vitest';
import { securityTxt } from '../src/lib/security-txt';

/** security.txt (RFC 9116) for researchers and pen testers (SEC-026). */
describe('security.txt', () => {
  const now = new Date('2026-11-19T10:00:00.000Z');

  it('is served only with a usable contact', () => {
    expect(securityTxt({}, 'https://books.example.in', now)).toBeNull();
    expect(securityTxt({ SECURITY_CONTACT: 'someone, ftp://x' }, 'https://books.example.in', now)).toBeNull();
  });

  it('lists contacts, an expiry within a year, the policy and where it lives', () => {
    const t = securityTxt({ SECURITY_CONTACT: 'mailto:security@books.example.in, https://books.example.in/report', SECURITY_POLICY_URL: 'https://books.example.in/security', SECURITY_TXT_EXPIRES_DAYS: '900' }, 'https://books.example.in', now);
    expect(t).toBe(
      ['Contact: mailto:security@books.example.in', 'Contact: https://books.example.in/report', 'Expires: 2027-11-19T10:00:00Z', 'Policy: https://books.example.in/security', 'Preferred-Languages: en, hi', 'Canonical: https://books.example.in/.well-known/security.txt', ''].join('\n'),
    );
    expect(securityTxt({ SECURITY_CONTACT: 'mailto:security@books.example.in' }, 'https://b.example', now)).toContain('Expires: 2027-05-18T10:00:00Z');
  });
});
