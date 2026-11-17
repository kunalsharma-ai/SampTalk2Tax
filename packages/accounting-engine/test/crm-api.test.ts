import { describe, expect, it } from 'vitest';
import { crmActionsFor, crmEventFor, CRM_WEBHOOK_EVENT_NAMES, formatApiKey, parseApiKey } from '../src/crm-api';

describe('CRM API keys', () => {
  it('reads the prefix of a well-formed key and nothing else', () => {
    const key = formatApiKey('ab12cd34', 'A'.repeat(20) + 'b1'.repeat(10));
    expect(parseApiKey(key)).toEqual({ prefix: 'ab12cd34' });
    expect(parseApiKey(` ${key} `)).toEqual({ prefix: 'ab12cd34' });
    expect(parseApiKey('t2t_ab12cd34_short')).toBeNull();
    expect(parseApiKey('Bearer t2t_ab12cd34_' + 'x'.repeat(40))).toBeNull();
    expect(() => formatApiKey('AB12CD34', 'x'.repeat(40))).toThrow();
  });
});

describe('CRM webhook events', () => {
  it('maps audit actions to events', () => {
    expect(crmEventFor('crm.deal.won')).toBe('deal.won');
    expect(crmEventFor('crm.deal.reopened')).toBe('deal.stage_changed');
    expect(crmEventFor('contact.created')).toBe('customer.created');
    expect(crmEventFor('journal.posted')).toBeNull();
    expect(crmActionsFor(['deal.stage_changed', 'nonsense'])).toEqual(['crm.deal.stage_changed', 'crm.deal.reopened']);
  });

  it('gives every event at least one action, and every action one event', () => {
    const actions = crmActionsFor(CRM_WEBHOOK_EVENT_NAMES);
    expect(new Set(actions).size).toBe(actions.length);
    for (const e of CRM_WEBHOOK_EVENT_NAMES) expect(crmActionsFor([e]).length).toBeGreaterThan(0);
  });
});
