/**
 * External communication policy (AR-043): whether an email from the organisation to people outside
 * it may go. Rules, in order:
 * 1. A contact who opted out of email is never emailed, however the message was made.
 * 2. A message an AI drafted goes only after a person approved it.
 * 3. Automations may email customers and vendors only when the organisation allows it.
 * Deterministic; the caller records the decision.
 */

export type MessageSource = 'COLLECTION_REMINDER' | 'AUTOMATION' | 'SCHEDULED_REPORT' | 'OTHER';
export type ContactEmailRule = 'ALLOWED' | 'BLOCKED';

export interface CommunicationPolicy {
  /** Automations (workflow emails) to a customer's or vendor's own address. */
  automationsToContacts: ContactEmailRule;
}

export const DEFAULT_COMMUNICATION_POLICY: CommunicationPolicy = { automationsToContacts: 'ALLOWED' };

export type CommunicationRefusal = 'OPTED_OUT' | 'NEEDS_APPROVAL' | 'AUTOMATIONS_BLOCKED';

export interface CommunicationDecision {
  allowed: boolean;
  code: CommunicationRefusal | null;
  /** In words, for the person or the record of the attempt. */
  reason: string | null;
}

const clean = (e: string) => e.trim().toLowerCase();

/**
 * @param optedOut addresses of contacts who opted out of email (any case), with the contact's name.
 * @param toContact whether the message is addressed to a customer or vendor (not to members).
 */
export function externalEmailDecision(input: { source: MessageSource; recipients: string[]; optedOut: Map<string, string>; policy: CommunicationPolicy; aiDrafted: boolean; approvedByPerson: boolean; toContact: boolean }): CommunicationDecision {
  const optedOut = new Map([...input.optedOut].map(([e, n]) => [clean(e), n]));
  const blocked = [...new Set(input.recipients.map(clean))].filter((e) => optedOut.has(e));
  if (blocked.length) {
    const names = [...new Set(blocked.map((e) => optedOut.get(e)!))];
    return { allowed: false, code: 'OPTED_OUT', reason: `${names.join(', ')} ${names.length === 1 ? 'has' : 'have'} opted out of email` };
  }
  if (input.aiDrafted && !input.approvedByPerson) return { allowed: false, code: 'NEEDS_APPROVAL', reason: 'A message drafted by AI goes only after a person approves it' };
  if (input.source === 'AUTOMATION' && input.toContact && input.policy.automationsToContacts === 'BLOCKED') return { allowed: false, code: 'AUTOMATIONS_BLOCKED', reason: 'Your communication policy does not let automations email customers or vendors' };
  return { allowed: true, code: null, reason: null };
}
