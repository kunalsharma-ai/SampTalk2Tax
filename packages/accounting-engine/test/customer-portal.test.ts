import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makePortalToken, PORTAL_TOKEN_PATTERN, portalInvoiceState, portalLinkState, portalTokenPrefix } from '../src/customer-portal';

describe('customer portal', () => {
  it('makes tokens in the pattern, all different', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => makePortalToken((n) => randomBytes(n))));
    expect(tokens.size).toBe(200);
    for (const t of tokens) expect(t).toMatch(PORTAL_TOKEN_PATTERN);
    const t = makePortalToken(() => new Uint8Array(64).fill(1));
    expect(t).toBe(`t2tp_${'B'.repeat(40)}`);
    expect(portalTokenPrefix(t)).toBe('BBBBBBBB');
    // Bytes at or above the rejection limit (248) are skipped.
    let call = 0;
    expect(makePortalToken((n) => (call++ === 0 ? new Uint8Array(n).fill(250) : new Uint8Array(n).fill(0)))).toBe(`t2tp_${'A'.repeat(40)}`);
  });

  it('works out link and invoice states', () => {
    const now = new Date('2026-11-10T10:00:00Z');
    expect(portalLinkState({ revokedAt: null, expiresAt: null }, now)).toBe('ACTIVE');
    expect(portalLinkState({ revokedAt: null, expiresAt: new Date('2026-11-10T09:59:59Z') }, now)).toBe('EXPIRED');
    expect(portalLinkState({ revokedAt: new Date('2026-11-01'), expiresAt: null }, now)).toBe('REVOKED');
    expect(portalInvoiceState({ status: 'POSTED', total: '100.00', open: '100.00', dueDate: '2026-11-30' }, '2026-11-10')).toBe('OPEN');
    expect(portalInvoiceState({ status: 'POSTED', total: '100.00', open: '40.00', dueDate: '2026-11-30' }, '2026-11-10')).toBe('PART_PAID');
    expect(portalInvoiceState({ status: 'POSTED', total: '100.00', open: '40.00', dueDate: '2026-11-01' }, '2026-11-10')).toBe('OVERDUE');
    expect(portalInvoiceState({ status: 'POSTED', total: '100.00', open: '0.00', dueDate: '2026-11-01' }, '2026-11-10')).toBe('PAID');
    expect(portalInvoiceState({ status: 'VOID', total: '100.00', open: '0.00', dueDate: null }, '2026-11-10')).toBe('VOID');
  });
});
