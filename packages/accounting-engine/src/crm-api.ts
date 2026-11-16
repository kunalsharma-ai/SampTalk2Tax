/**
 * Connecting an external CRM: API key format and scopes, and the CRM events a webhook can
 * receive, each read from one or more audit actions.
 */

export const API_SCOPES = ['crm.read', 'crm.write'] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const API_SCOPE_LABEL: Record<ApiScope, string> = {
  'crm.read': 'Read leads, deals and customers',
  'crm.write': 'Create and update leads and deals, and convert leads',
};

/** `t2t_<prefix of 8>_<secret of 40>`: the prefix finds the key, the whole key is checked by its hash. */
const KEY = /^t2t_([a-z0-9]{8})_([A-Za-z0-9]{40})$/;

export function parseApiKey(raw: string): { prefix: string } | null {
  const m = KEY.exec(raw.trim());
  return m ? { prefix: m[1]! } : null;
}

export function formatApiKey(prefix: string, secret: string): string {
  const key = `t2t_${prefix}_${secret}`;
  if (!KEY.test(key)) throw new Error('An API key needs an 8-character lowercase prefix and a 40-character secret');
  return key;
}

/** The CRM events a webhook can subscribe to, with the audit actions each one is read from. */
export const CRM_WEBHOOK_EVENTS = {
  'lead.created': { label: 'A lead is created', actions: ['crm.lead.created'] },
  'lead.updated': { label: 'A lead\'s details change', actions: ['crm.lead.updated'] },
  'lead.status_changed': { label: 'A lead is contacted, qualified or disqualified', actions: ['crm.lead.status_changed'] },
  'lead.converted': { label: 'A lead becomes a customer', actions: ['crm.lead.converted'] },
  'deal.created': { label: 'A deal is created', actions: ['crm.deal.created'] },
  'deal.updated': { label: 'A deal\'s amount, dates or customer change', actions: ['crm.deal.updated'] },
  'deal.stage_changed': { label: 'A deal moves stage or is reopened', actions: ['crm.deal.stage_changed', 'crm.deal.reopened'] },
  'deal.won': { label: 'A deal is won', actions: ['crm.deal.won'] },
  'deal.lost': { label: 'A deal is lost', actions: ['crm.deal.lost'] },
  'customer.created': { label: 'A customer is created', actions: ['contact.created'] },
  'customer.updated': { label: 'A customer\'s details change', actions: ['contact.updated'] },
} as const;
export type CrmWebhookEvent = keyof typeof CRM_WEBHOOK_EVENTS;
export const CRM_WEBHOOK_EVENT_NAMES = Object.keys(CRM_WEBHOOK_EVENTS) as CrmWebhookEvent[];

/** The event an audit action is sent as, or null when no CRM webhook event covers it. */
export function crmEventFor(action: string): CrmWebhookEvent | null {
  for (const name of CRM_WEBHOOK_EVENT_NAMES) if ((CRM_WEBHOOK_EVENTS[name].actions as readonly string[]).includes(action)) return name;
  return null;
}

/** The audit actions a webhook subscribed to these events has to read. */
export function crmActionsFor(events: readonly string[]): string[] {
  return events.flatMap((e) => (e in CRM_WEBHOOK_EVENTS ? [...CRM_WEBHOOK_EVENTS[e as CrmWebhookEvent].actions] : []));
}
