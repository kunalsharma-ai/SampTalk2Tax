import { describe, expect, it } from 'vitest';
import {
  checkTriggerParams,
  describeTrigger,
  formatAmountText,
  formatDateText,
  dueDateWindow,
  evaluateConditions,
  istDate,
  latestOccurrence,
  nextDeliveryAttempt,
  shiftDate,
  smtpRetryable,
  nextWebhookAttempt,
  renderTemplate,
  sumAmounts,
  triggerDef,
  validateWorkflow,
  WEBHOOK_MAX_ATTEMPTS,
  WorkflowDefinition,
  WorkflowError,
  WORKFLOW_TRIGGER_DEFS,
  WORKFLOW_TRIGGERS,
} from '../src';

const task = { type: 'CREATE_TASK' as const, title: 'Review {{number}} from {{contactName}}', assignTo: { role: 'ACCOUNTANT' as const }, dueInDays: 2 };
const bill = (extra: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({ trigger: 'BILL_POSTED', conditions: [], actions: [task], ...extra });
const issues = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof WorkflowError) return e.issues;
    throw e;
  }
  return [];
};

describe('triggers', () => {
  it('every trigger has a definition with distinct fact keys', () => {
    expect(WORKFLOW_TRIGGER_DEFS.map((t) => t.key)).toEqual([...WORKFLOW_TRIGGERS]);
    for (const t of WORKFLOW_TRIGGER_DEFS) expect(new Set(t.facts.map((f) => f.key)).size).toBe(t.facts.length);
    expect(() => triggerDef('NOPE')).toThrow(WorkflowError);
  });
});

describe('validating a workflow', () => {
  it('cleans up a valid definition', () => {
    const v = validateWorkflow(
      bill({
        conditions: [
          { fact: 'total', op: 'gte', value: ' 100000.50 ' },
          { fact: 'contactName', op: 'contains', value: '  Granite ' },
          { fact: 'reference', op: 'not_empty' },
        ],
        actions: [{ ...task, title: '  Review {{ number }}  ' }, { type: 'WEBHOOK', url: ' https://hooks.example.test/t2t ' }],
      }),
    );
    expect(v.conditions).toEqual([
      { fact: 'total', op: 'gte', value: '100000.5' },
      { fact: 'contactName', op: 'contains', value: 'Granite' },
      { fact: 'reference', op: 'not_empty' },
    ]);
    expect(v.actions).toEqual([{ type: 'CREATE_TASK', title: 'Review {{ number }}', assignTo: { role: 'ACCOUNTANT' }, dueInDays: 2 }, { type: 'WEBHOOK', url: 'https://hooks.example.test/t2t' }]);
  });

  it('lists every problem', () => {
    const found = issues(() =>
      validateWorkflow({
        trigger: 'BILL_POSTED',
        conditions: [
          { fact: 'severity', op: 'in', value: ['CRITICAL'] },
          { fact: 'total', op: 'contains', value: '5' },
          { fact: 'total', op: 'gt', value: '1e5' },
          { fact: 'dueDate', op: 'before', value: '31/12/2026' },
          { fact: 'contactName', op: 'eq', value: '  ' },
        ],
        actions: [
          { type: 'CREATE_TASK', title: ' ', assignTo: { role: 'EMPLOYEE' as never }, dueInDays: 400 },
          { type: 'CREATE_TASK', title: 'Check {{severity}}', assignTo: { userId: 'nope' }, dueInDays: 1.5 },
          { type: 'WEBHOOK', url: 'http://hooks.example.test' },
          { type: 'WEBHOOK', url: 'https://user:pw@hooks.example.test' },
          { type: 'WEBHOOK', url: 'not a url' },
        ],
      }),
    );
    expect(found).toEqual([
      'Condition 1: "severity" is not available for a bill is posted',
      'Condition 2: Total cannot use "contains"',
      'Condition 3: enter an amount for total',
      'Condition 4: enter a date (YYYY-MM-DD) for due date',
      'Condition 5: enter the text to compare vendor with',
      'Action 1: give the task a title',
      'Action 1: choose who the task is for',
      'Action 1: due in 0 to 365 days, or no due date',
      'Action 2: {{severity}} is not available for a bill is posted',
      'Action 2: choose who the task is for',
      'Action 2: due in 0 to 365 days, or no due date',
      'Action 3: the address must start with https://',
      'Action 4: put no user name or password in the address',
      'Action 5: enter a web address',
    ]);
    expect(issues(() => validateWorkflow(bill({ actions: [] })))).toEqual(['Add at least one action']);
    expect(validateWorkflow(bill({ actions: [{ type: 'WEBHOOK', url: 'http://localhost:9/x' }] }), { allowHttp: true }).actions).toHaveLength(1);
  });

  it('keeps enum values in catalogue order and refuses unknown ones', () => {
    const v = validateWorkflow({ trigger: 'ALERT_OPENED', conditions: [{ fact: 'severity', op: 'in', value: ['WARNING', 'CRITICAL', 'WARNING'] }], actions: [task].map((a) => ({ ...a, title: 'Look at {{title}}' })) });
    expect(v.conditions[0].value).toEqual(['CRITICAL', 'WARNING']);
    expect(issues(() => validateWorkflow({ trigger: 'ALERT_OPENED', conditions: [{ fact: 'severity', op: 'in', value: ['HIGH'] }], actions: [{ ...task, title: 'x' }] }))).toEqual(['Condition 1: unknown severity HIGH']);
    expect(issues(() => validateWorkflow({ trigger: 'ALERT_OPENED', conditions: [{ fact: 'severity', op: 'in', value: [] }], actions: [{ ...task, title: 'x' }] }))).toEqual(['Condition 1: choose at least one severity']);
  });
});

describe('evaluating conditions', () => {
  const facts = { number: 'BILL-000012', contactName: 'Granite Supplies', total: '118000.00', issueDate: '2026-11-01', dueDate: '2026-12-01', reference: '' };
  it('compares money as decimals and text without case', () => {
    const r = evaluateConditions(
      'BILL_POSTED',
      [
        { fact: 'total', op: 'gt', value: '117999.999999' },
        { fact: 'total', op: 'lte', value: '118000' },
        { fact: 'contactName', op: 'contains', value: 'GRANITE' },
        { fact: 'reference', op: 'is_empty' },
        { fact: 'dueDate', op: 'after', value: '2026-11-30' },
      ],
      facts,
    );
    expect(r.matched).toBe(true);
    expect(r.results.map((x) => x.label)).toEqual(['Total is more than 117999.999999', 'Total is at most 118000', 'Vendor contains GRANITE', 'Vendor invoice number is empty', 'Due date is after 2026-11-30']);
  });
  it('fails when any condition fails, and on missing values', () => {
    const r = evaluateConditions('BILL_POSTED', [{ fact: 'total', op: 'gte', value: '118000.01' }, { fact: 'contactName', op: 'neq', value: 'granite supplies' }], facts);
    expect(r.matched).toBe(false);
    expect(r.results.map((x) => [x.passed, x.actual])).toEqual([[false, '118000.00'], [false, 'Granite Supplies']]);
    expect(evaluateConditions('ALERT_OPENED', [{ fact: 'amount', op: 'gt', value: '0' }], { amount: null }).matched).toBe(false);
    expect(evaluateConditions('ALERT_OPENED', [{ fact: 'severity', op: 'not_in', value: ['INFO'] }], { severity: 'CRITICAL' }).matched).toBe(true);
    expect(evaluateConditions('BILL_POSTED', [], facts).matched).toBe(true);
  });
});

describe('templates and webhook retries', () => {
  it('fills placeholders, with a dash for missing values', () => {
    expect(renderTemplate('Review {{number}} from {{ contactName }} for {{total}} ({{reference}})', { number: 'B-1', contactName: 'Granite', total: '1000.00', reference: null }, (k, v) => (k === 'total' ? `₹${v}` : v))).toBe('Review B-1 from Granite for ₹1000.00 (—)');
  });
  it('retries network errors, timeouts, 429 and 5xx with growing delays, up to six attempts', () => {
    const now = new Date('2026-11-02T00:00:00Z');
    expect(nextWebhookAttempt(1, null, now)!.toISOString()).toBe('2026-11-02T00:01:00.000Z');
    expect(nextWebhookAttempt(2, 503, now)!.toISOString()).toBe('2026-11-02T00:05:00.000Z');
    expect(nextWebhookAttempt(5, 429, now)!.toISOString()).toBe('2026-11-02T06:00:00.000Z');
    expect(nextWebhookAttempt(WEBHOOK_MAX_ATTEMPTS, 500, now)).toBeNull();
    expect(nextWebhookAttempt(1, 404, now)).toBeNull();
    expect(nextWebhookAttempt(1, 408, now)).not.toBeNull();
  });
  it('sums amounts exactly', () => {
    expect(sumAmounts(['0.10', '0.20', '1000000000000.70'])).toBe('1000000000001');
  });
});

describe('schedule triggers', () => {
  const at = (iso: string) => new Date(iso);
  it('checks schedule settings and keeps only the keys that apply', () => {
    expect(checkTriggerParams('SCHEDULE', { frequency: 'WEEKLY', time: '09:30', weekday: 1, dayOfMonth: 5 })).toEqual({ params: { frequency: 'WEEKLY', time: '09:30', weekday: 1 }, issues: [] });
    expect(checkTriggerParams('SCHEDULE', { frequency: 'MONTHLY', time: '24:00', dayOfMonth: 31 }).issues).toEqual(['Schedule: enter a time as HH:MM (24-hour, India time)', 'Schedule: choose a day of the month from 1 to 28']);
    expect(checkTriggerParams('SCHEDULE', {}).issues).toEqual(['Schedule: choose every day, every week or every month']);
    expect(checkTriggerParams('INVOICE_OVERDUE', { days: 0 }).issues).toHaveLength(1);
    expect(checkTriggerParams('BILL_DUE_SOON', { days: 0 })).toEqual({ params: { days: 0 }, issues: [] });
    expect(checkTriggerParams('BILL_POSTED', { days: 3 } as never)).toEqual({ params: {}, issues: [] });
    expect(issues(() => validateWorkflow({ trigger: 'INVOICE_OVERDUE', triggerParams: { days: 2.5 }, conditions: [], actions: [task] }))).toEqual(['Trigger: an invoice is overdue 1 to 365 days after its due date']);
    expect(validateWorkflow({ trigger: 'INVOICE_OVERDUE', triggerParams: { days: 7 }, conditions: [{ fact: 'balance', op: 'gt', value: '0' }], actions: [task] }).triggerParams).toEqual({ days: 7 });
  });
  it('describes triggers in plain words', () => {
    expect(describeTrigger('SCHEDULE', { frequency: 'WEEKLY', time: '09:00', weekday: 1 })).toBe('Every Monday at 09:00 India time');
    expect(describeTrigger('SCHEDULE', { frequency: 'MONTHLY', time: '18:15', dayOfMonth: 1 })).toBe('Every month on day 1 at 18:15 India time');
    expect(describeTrigger('INVOICE_OVERDUE', { days: 1 })).toBe('An invoice is 1 day overdue');
    expect(describeTrigger('BILL_DUE_SOON', { days: 0 })).toBe('A bill is due today');
    expect(describeTrigger('BILL_POSTED')).toBe('A bill is posted');
  });
  it('finds the latest occurrence in India time', () => {
    // 2026-11-02 is a Monday. 03:00 UTC = 08:30 India time.
    const daily = { frequency: 'DAILY' as const, time: '09:00' };
    expect(latestOccurrence(daily, at('2026-11-02T03:00:00Z'))).toEqual({ at: at('2026-11-01T03:30:00Z'), date: '2026-11-01' });
    expect(latestOccurrence(daily, at('2026-11-02T03:30:00Z'))).toEqual({ at: at('2026-11-02T03:30:00Z'), date: '2026-11-02' });
    // Just after midnight India time is still the previous UTC day.
    expect(latestOccurrence({ frequency: 'DAILY', time: '00:10' }, at('2026-11-01T18:45:00Z')).date).toBe('2026-11-02');
    const monday = { frequency: 'WEEKLY' as const, time: '09:00', weekday: 1 };
    expect(latestOccurrence(monday, at('2026-11-02T03:00:00Z')).date).toBe('2026-10-26');
    expect(latestOccurrence(monday, at('2026-11-02T04:00:00Z')).date).toBe('2026-11-02');
    expect(latestOccurrence({ frequency: 'WEEKLY', time: '09:00', weekday: 7 }, at('2026-11-02T04:00:00Z')).date).toBe('2026-11-01');
    const monthly = { frequency: 'MONTHLY' as const, time: '10:00', dayOfMonth: 5 };
    expect(latestOccurrence(monthly, at('2026-11-02T04:00:00Z'))).toEqual({ at: at('2026-10-05T04:30:00Z'), date: '2026-10-05' });
    expect(latestOccurrence(monthly, at('2026-01-02T04:00:00Z')).date).toBe('2025-12-05');
    expect(latestOccurrence(monthly, at('2026-11-05T04:30:00Z')).date).toBe('2026-11-05');
  });
  it('works out the due dates that reach a date trigger', () => {
    expect(dueDateWindow('INVOICE_OVERDUE', 7, '2026-11-02', '2026-11-04')).toEqual({ from: '2026-10-26', to: '2026-10-28' });
    expect(dueDateWindow('BILL_DUE_SOON', 3, '2026-12-30', '2027-01-01')).toEqual({ from: '2027-01-02', to: '2027-01-04' });
    expect(istDate(at('2026-11-01T18:30:00Z'))).toBe('2026-11-02');
    expect(shiftDate('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('email actions', () => {
  const email = { type: 'SEND_EMAIL' as const, to: { contact: true as const }, subject: ' Reminder: {{number}} ', body: 'Dear {{contactName}}, {{balance}} is still to pay.' };
  it('accepts an email to the customer on an overdue invoice', () => {
    const def = validateWorkflow({ trigger: 'INVOICE_OVERDUE', triggerParams: { days: 3 }, conditions: [], actions: [email] });
    expect(def.actions[0]).toEqual({ ...email, subject: 'Reminder: {{number}}' });
  });
  it('lists every problem', () => {
    expect(issues(() => validateWorkflow({ trigger: 'JOURNAL_POSTED', conditions: [], actions: [{ ...email, subject: 'a\nb {{balance}}', body: '' }] }))).toEqual([
      'Action 1: keep the subject on one line',
      'Action 1: write the email',
      'Action 1: {{balance}} is not available for a manual journal is posted',
      'Action 1: a manual journal is posted has no customer or vendor to email',
    ]);
    expect(issues(() => validateWorkflow(bill({ actions: [{ ...email, body: 'x', subject: 'y', to: { role: 'EMPLOYEE' } as never }] })))).toEqual(['Action 1: choose who the email goes to']);
    expect(validateWorkflow(bill({ actions: [{ ...email, subject: '{{number}}', body: 'Hi', to: { role: 'OWNER' } }] })).actions).toHaveLength(1);
  });
  it('retries temporary SMTP failures only', () => {
    const now = new Date('2026-11-02T00:00:00Z');
    expect(smtpRetryable(null)).toBe(true);
    expect(smtpRetryable(451)).toBe(true);
    expect(smtpRetryable(550)).toBe(false);
    expect(nextDeliveryAttempt(1, true, now)!.toISOString()).toBe('2026-11-02T00:01:00.000Z');
    expect(nextDeliveryAttempt(1, false, now)).toBeNull();
    expect(nextDeliveryAttempt(WEBHOOK_MAX_ATTEMPTS, true, now)).toBeNull();
  });
});

describe('text for emails', () => {
  it('groups amounts the Indian way for rupees and by thousands otherwise', () => {
    expect(formatAmountText('150000.00', 'INR')).toBe('₹1,50,000.00');
    expect(formatAmountText('123456789012.50', 'INR')).toBe('₹1,23,45,67,89,012.50');
    expect(formatAmountText('999.00', 'INR')).toBe('₹999.00');
    expect(formatAmountText('-1234567.5', 'USD')).toBe('USD -1,234,567.5');
    expect(formatDateText('2026-11-02')).toBe('2 Nov 2026');
  });
});
