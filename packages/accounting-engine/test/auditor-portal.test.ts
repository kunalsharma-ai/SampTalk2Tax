import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AUDITOR_PORTAL_TOKEN_PATTERN, auditorPortalTokenPrefix, makeAuditorPortalToken, PORTAL_TOKEN_PATTERN, VENDOR_PORTAL_TOKEN_PATTERN } from '../src';

describe('auditor portal tokens', () => {
  it('makes distinct tokens that only the auditor pattern accepts', () => {
    const a = makeAuditorPortalToken((n) => randomBytes(n));
    const b = makeAuditorPortalToken((n) => randomBytes(n));
    expect(a).toMatch(AUDITOR_PORTAL_TOKEN_PATTERN);
    expect(a).not.toBe(b);
    expect(a).not.toMatch(PORTAL_TOKEN_PATTERN);
    expect(a).not.toMatch(VENDOR_PORTAL_TOKEN_PATTERN);
    expect(auditorPortalTokenPrefix(a)).toBe(a.slice(5, 13));
    expect(auditorPortalTokenPrefix(a)).toHaveLength(8);
  });
});
