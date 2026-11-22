import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMUNICATION_POLICY, externalEmailDecision } from '../src/communication-policy';

const base = { source: 'COLLECTION_REMINDER' as const, recipients: ['accounts@lotus.example'], optedOut: new Map<string, string>(), policy: DEFAULT_COMMUNICATION_POLICY, aiDrafted: false, approvedByPerson: false, toContact: true };

describe('external communication policy', () => {
  it('lets an ordinary message go', () => {
    expect(externalEmailDecision(base)).toEqual({ allowed: true, code: null, reason: null });
  });

  it('never emails a contact who opted out, whatever the source, ignoring case and spaces', () => {
    const optedOut = new Map([['Accounts@Lotus.example', 'Lotus Retail']]);
    for (const source of ['COLLECTION_REMINDER', 'AUTOMATION', 'SCHEDULED_REPORT', 'OTHER'] as const) {
      expect(externalEmailDecision({ ...base, source, recipients: [' accounts@lotus.EXAMPLE ', 'other@x.example'], optedOut, approvedByPerson: true })).toEqual({ allowed: false, code: 'OPTED_OUT', reason: 'Lotus Retail has opted out of email' });
    }
    expect(externalEmailDecision({ ...base, recipients: ['a@x.example', 'b@y.example'], optedOut: new Map([['a@x.example', 'Alpha'], ['b@y.example', 'Beta']]) }).reason).toBe('Alpha, Beta have opted out of email');
  });

  it('sends an AI draft only after a person approved it', () => {
    expect(externalEmailDecision({ ...base, aiDrafted: true })).toMatchObject({ allowed: false, code: 'NEEDS_APPROVAL' });
    expect(externalEmailDecision({ ...base, aiDrafted: true, approvedByPerson: true }).allowed).toBe(true);
  });

  it('follows the policy for automations to customers and vendors, not to members', () => {
    const policy = { automationsToContacts: 'BLOCKED' as const };
    expect(externalEmailDecision({ ...base, source: 'AUTOMATION', policy })).toMatchObject({ allowed: false, code: 'AUTOMATIONS_BLOCKED' });
    expect(externalEmailDecision({ ...base, source: 'AUTOMATION', policy, toContact: false }).allowed).toBe(true);
    expect(externalEmailDecision({ ...base, source: 'COLLECTION_REMINDER', policy, approvedByPerson: true }).allowed).toBe(true);
  });
});
