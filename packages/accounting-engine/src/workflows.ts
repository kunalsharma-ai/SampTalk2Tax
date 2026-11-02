/**
 * Workflow automations: "when this happens, if these conditions hold, do these things".
 * This module holds the catalogue of triggers and the facts each one offers, the
 * conditions and actions a workflow may use, validation of a workflow definition,
 * condition evaluation, template rendering and the webhook retry schedule.
 *
 * No framework or database code. Money is compared as decimals, never as JS numbers.
 */
import { D, Dec } from './money';

export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [message],
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

// ---------------------------------------------------------------- triggers and facts

export type FactType = 'money' | 'text' | 'enum' | 'date';
export interface FactDef {
  key: string;
  label: string;
  type: FactType;
  /** Allowed values for an enum fact. */
  options?: { value: string; label: string }[];
}

export const WORKFLOW_TRIGGERS = [
  'INVOICE_POSTED',
  'BILL_POSTED',
  'DOCUMENT_VOIDED',
  'RECEIPT_RECORDED',
  'VENDOR_PAYMENT_RECORDED',
  'JOURNAL_POSTED',
  'EXPENSE_CLAIM_SUBMITTED',
  'ALERT_OPENED',
] as const;
export type WorkflowTrigger = (typeof WORKFLOW_TRIGGERS)[number];

export interface TriggerDef {
  key: WorkflowTrigger;
  label: string;
  description: string;
  /** The audit-trail actions this trigger listens to. */
  auditActions: readonly string[];
  facts: FactDef[];
}

const contact = (label: string): FactDef => ({ key: 'contactName', label, type: 'text' });
const SEVERITY: FactDef = {
  key: 'severity',
  label: 'Severity',
  type: 'enum',
  options: [
    { value: 'CRITICAL', label: 'Critical' },
    { value: 'WARNING', label: 'Warning' },
    { value: 'INFO', label: 'Info' },
  ],
};

export const WORKFLOW_TRIGGER_DEFS: readonly TriggerDef[] = [
  {
    key: 'INVOICE_POSTED',
    label: 'An invoice is posted',
    description: 'A sales invoice is posted to the books.',
    auditActions: ['document.posted'],
    facts: [
      { key: 'number', label: 'Invoice number', type: 'text' },
      contact('Customer'),
      { key: 'total', label: 'Total', type: 'money' },
      { key: 'issueDate', label: 'Issue date', type: 'date' },
      { key: 'dueDate', label: 'Due date', type: 'date' },
      { key: 'reference', label: 'Reference', type: 'text' },
    ],
  },
  {
    key: 'BILL_POSTED',
    label: 'A bill is posted',
    description: 'A vendor bill is posted to the books.',
    auditActions: ['document.posted'],
    facts: [
      { key: 'number', label: 'Bill number', type: 'text' },
      contact('Vendor'),
      { key: 'total', label: 'Total', type: 'money' },
      { key: 'issueDate', label: 'Bill date', type: 'date' },
      { key: 'dueDate', label: 'Due date', type: 'date' },
      { key: 'reference', label: 'Vendor invoice number', type: 'text' },
    ],
  },
  {
    key: 'DOCUMENT_VOIDED',
    label: 'An invoice or bill is voided',
    description: 'A posted invoice, credit note, bill or vendor credit is voided.',
    auditActions: ['document.voided'],
    facts: [
      {
        key: 'kind',
        label: 'Kind',
        type: 'enum',
        options: [
          { value: 'INVOICE', label: 'Invoice' },
          { value: 'CREDIT_NOTE', label: 'Credit note' },
          { value: 'BILL', label: 'Bill' },
          { value: 'VENDOR_CREDIT', label: 'Vendor credit' },
        ],
      },
      { key: 'number', label: 'Number', type: 'text' },
      contact('Customer or vendor'),
      { key: 'total', label: 'Total', type: 'money' },
      { key: 'reason', label: 'Reason', type: 'text' },
    ],
  },
  {
    key: 'RECEIPT_RECORDED',
    label: 'A customer payment is received',
    description: 'A receipt from a customer is recorded.',
    auditActions: ['payment.recorded'],
    facts: [{ key: 'number', label: 'Receipt number', type: 'text' }, contact('Customer'), { key: 'amount', label: 'Amount', type: 'money' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'reference', label: 'Reference', type: 'text' }],
  },
  {
    key: 'VENDOR_PAYMENT_RECORDED',
    label: 'A vendor is paid',
    description: 'A payment to a vendor is recorded.',
    auditActions: ['payment.recorded'],
    facts: [{ key: 'number', label: 'Payment number', type: 'text' }, contact('Vendor'), { key: 'amount', label: 'Amount', type: 'money' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'reference', label: 'Reference', type: 'text' }],
  },
  {
    key: 'JOURNAL_POSTED',
    label: 'A manual journal is posted',
    description: 'A journal entry typed in by a person is posted (not those made by invoices, payments or other modules).',
    auditActions: ['journal.posted', 'journal.created_and_posted'],
    facts: [
      { key: 'number', label: 'Entry number', type: 'text' },
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'total', label: 'Total debits', type: 'money' },
      { key: 'memo', label: 'Memo', type: 'text' },
      { key: 'postedBy', label: 'Posted by', type: 'text' },
    ],
  },
  {
    key: 'EXPENSE_CLAIM_SUBMITTED',
    label: 'An expense claim is submitted',
    description: 'An employee submits an expense claim for approval.',
    auditActions: ['expense_claim.submitted'],
    facts: [
      { key: 'number', label: 'Claim number', type: 'text' },
      { key: 'claimant', label: 'Claimant', type: 'text' },
      { key: 'total', label: 'Total', type: 'money' },
      { key: 'title', label: 'Title', type: 'text' },
    ],
  },
  {
    key: 'ALERT_OPENED',
    label: 'An alert opens',
    description: 'The checks raise a new alert, or an alert that had cleared comes back.',
    auditActions: ['alert.opened'],
    facts: [SEVERITY, { key: 'check', label: 'Check', type: 'text' }, { key: 'title', label: 'Title', type: 'text' }, { key: 'amount', label: 'Amount at stake', type: 'money' }],
  },
];

export function triggerDef(key: string): TriggerDef {
  const t = WORKFLOW_TRIGGER_DEFS.find((x) => x.key === key);
  if (!t) throw new WorkflowError(`Unknown trigger "${key}"`);
  return t;
}

// ---------------------------------------------------------------- conditions

export const CONDITION_OPERATORS = {
  money: ['gt', 'gte', 'lt', 'lte', 'eq'],
  text: ['eq', 'neq', 'contains', 'not_contains', 'is_empty', 'not_empty'],
  enum: ['in', 'not_in'],
  date: ['before', 'after', 'eq'],
} as const satisfies Record<FactType, readonly string[]>;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[FactType][number];

export const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  is_empty: 'is empty',
  not_empty: 'is not empty',
  in: 'is one of',
  not_in: 'is not one of',
  before: 'is before',
  after: 'is after',
};

export interface Condition {
  fact: string;
  op: ConditionOperator;
  /** A decimal string for money, text, YYYY-MM-DD for dates, or a list of values for enums. Absent for is_empty and not_empty. */
  value?: string | string[];
}

/** Fact values as loaded for one event. Money is a decimal string; a missing value is null. */
export type Facts = Record<string, string | null>;

const MONEY = /^-?\d{1,18}(\.\d{1,6})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ConditionResult {
  condition: Condition;
  label: string;
  passed: boolean;
  actual: string | null;
}

function describe(c: Condition, f: FactDef): string {
  const v = Array.isArray(c.value) ? c.value.map((x) => f.options?.find((o) => o.value === x)?.label ?? x).join(', ') : (c.value ?? '');
  return `${f.label} ${OPERATOR_LABELS[c.op]}${c.op === 'is_empty' || c.op === 'not_empty' ? '' : ` ${v}`}`;
}

/** Checks every condition (all must pass). Text comparisons ignore case and surrounding spaces. */
export function evaluateConditions(trigger: WorkflowTrigger, conditions: Condition[], facts: Facts): { matched: boolean; results: ConditionResult[] } {
  const t = triggerDef(trigger);
  const results = conditions.map((c): ConditionResult => {
    const f = t.facts.find((x) => x.key === c.fact);
    if (!f) throw new WorkflowError(`"${c.fact}" is not a fact of ${t.label.toLowerCase()}`);
    const actual = facts[c.fact] ?? null;
    let passed = false;
    if (f.type === 'money') {
      if (actual !== null && typeof c.value === 'string') {
        const cmp = new D(actual).comparedTo(new D(c.value));
        passed = { gt: cmp > 0, gte: cmp >= 0, lt: cmp < 0, lte: cmp <= 0, eq: cmp === 0 }[c.op as 'gt'] ?? false;
      }
    } else if (f.type === 'text') {
      const a = (actual ?? '').trim().toLowerCase();
      const v = typeof c.value === 'string' ? c.value.trim().toLowerCase() : '';
      passed = { eq: a === v, neq: a !== v, contains: a.includes(v), not_contains: !a.includes(v), is_empty: a === '', not_empty: a !== '' }[c.op as 'eq'] ?? false;
    } else if (f.type === 'enum') {
      const list = Array.isArray(c.value) ? c.value : [];
      passed = c.op === 'in' ? actual !== null && list.includes(actual) : actual === null || !list.includes(actual);
    } else if (f.type === 'date') {
      if (actual !== null && typeof c.value === 'string') passed = { before: actual < c.value, after: actual > c.value, eq: actual === c.value }[c.op as 'before'] ?? false;
    }
    return { condition: c, label: describe(c, f), passed, actual };
  });
  return { matched: results.every((r) => r.passed), results };
}

// ---------------------------------------------------------------- actions

export const ASSIGNABLE_ROLES = ['OWNER', 'ADMIN', 'ACCOUNTANT', 'APPROVER', 'VIEWER'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export interface CreateTaskAction {
  type: 'CREATE_TASK';
  /** Template: {{fact}} is replaced by the event's value. */
  title: string;
  description?: string;
  assignTo: { role: AssignableRole } | { userId: string };
  /** Due this many days after the event (India time); null for no due date. */
  dueInDays: number | null;
}
export interface WebhookAction {
  type: 'WEBHOOK';
  url: string;
}
export type WorkflowAction = CreateTaskAction | WebhookAction;

export interface WorkflowDefinition {
  trigger: WorkflowTrigger;
  conditions: Condition[];
  actions: WorkflowAction[];
}

export const MAX_CONDITIONS = 10;
export const MAX_ACTIONS = 5;
const PLACEHOLDER = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;

/**
 * Checks a workflow definition and returns it cleaned up (trimmed text, sorted enum
 * values). Throws WorkflowError listing every problem. Webhook addresses must be https
 * unless allowHttp is set (for local development and tests).
 */
export function validateWorkflow(def: WorkflowDefinition, opts: { allowHttp?: boolean } = {}): WorkflowDefinition {
  const issues: string[] = [];
  if (!(WORKFLOW_TRIGGERS as readonly string[]).includes(def.trigger)) throw new WorkflowError(`Unknown trigger "${def.trigger}"`);
  const t = triggerDef(def.trigger);
  if (def.conditions.length > MAX_CONDITIONS) issues.push(`At most ${MAX_CONDITIONS} conditions`);
  const conditions = def.conditions.map((c, i): Condition => {
    const n = `Condition ${i + 1}`;
    const f = t.facts.find((x) => x.key === c.fact);
    if (!f) {
      issues.push(`${n}: "${c.fact}" is not available for ${t.label.toLowerCase()}`);
      return c;
    }
    const ops = CONDITION_OPERATORS[f.type] as readonly string[];
    if (!ops.includes(c.op)) {
      issues.push(`${n}: ${f.label} cannot use "${c.op}"`);
      return c;
    }
    if (f.type === 'money') {
      if (typeof c.value !== 'string' || !MONEY.test(c.value.trim())) issues.push(`${n}: enter an amount for ${f.label.toLowerCase()}`);
      else return { fact: c.fact, op: c.op, value: new D(c.value.trim()).toFixed() };
    } else if (f.type === 'date') {
      if (typeof c.value !== 'string' || !DATE.test(c.value)) issues.push(`${n}: enter a date (YYYY-MM-DD) for ${f.label.toLowerCase()}`);
    } else if (f.type === 'enum') {
      const vals = Array.isArray(c.value) ? [...new Set(c.value)] : [];
      if (!vals.length) issues.push(`${n}: choose at least one ${f.label.toLowerCase()}`);
      const bad = vals.filter((v) => !f.options!.some((o) => o.value === v));
      if (bad.length) issues.push(`${n}: unknown ${f.label.toLowerCase()} ${bad.join(', ')}`);
      return { fact: c.fact, op: c.op, value: f.options!.map((o) => o.value).filter((v) => vals.includes(v)) };
    } else if (c.op !== 'is_empty' && c.op !== 'not_empty') {
      if (typeof c.value !== 'string' || !c.value.trim()) issues.push(`${n}: enter the text to compare ${f.label.toLowerCase()} with`);
      else if (c.value.length > 200) issues.push(`${n}: keep the text under 200 characters`);
      else return { fact: c.fact, op: c.op, value: c.value.trim() };
    } else return { fact: c.fact, op: c.op };
    return c;
  });

  if (!def.actions.length) issues.push('Add at least one action');
  if (def.actions.length > MAX_ACTIONS) issues.push(`At most ${MAX_ACTIONS} actions`);
  const known = new Set(t.facts.map((f) => f.key));
  const placeholders = (s: string, where: string) => {
    for (const m of s.matchAll(PLACEHOLDER)) if (!known.has(m[1])) issues.push(`${where}: {{${m[1]}}} is not available for ${t.label.toLowerCase()}`);
  };
  const actions = def.actions.map((a, i): WorkflowAction => {
    const n = `Action ${i + 1}`;
    if (a.type === 'CREATE_TASK') {
      const title = (a.title ?? '').trim();
      const description = (a.description ?? '').trim();
      if (!title) issues.push(`${n}: give the task a title`);
      if (title.length > 200) issues.push(`${n}: keep the title under 200 characters`);
      if (description.length > 2000) issues.push(`${n}: keep the description under 2,000 characters`);
      placeholders(title, n);
      placeholders(description, n);
      if (!a.assignTo || ('role' in a.assignTo ? !(ASSIGNABLE_ROLES as readonly string[]).includes(a.assignTo.role) : !/^[0-9a-f-]{36}$/i.test(a.assignTo.userId ?? ''))) issues.push(`${n}: choose who the task is for`);
      if (a.dueInDays !== null && (!Number.isInteger(a.dueInDays) || a.dueInDays < 0 || a.dueInDays > 365)) issues.push(`${n}: due in 0 to 365 days, or no due date`);
      return { type: 'CREATE_TASK', title, ...(description ? { description } : {}), assignTo: a.assignTo, dueInDays: a.dueInDays };
    }
    if (a.type === 'WEBHOOK') {
      const url = (a.url ?? '').trim();
      // Parsed by pattern: this package has no URL class (it runs without Node or DOM types).
      const m = /^([a-z][a-z0-9+.-]*):\/\/(?:([^/?#@\s]*)@)?([^/?#@\s:]+)(?::(\d{1,5}))?(?:[/?#]\S*)?$/i.exec(url);
      if (!m) issues.push(`${n}: enter a web address`);
      else {
        const scheme = m[1].toLowerCase();
        if (scheme !== 'https' && !(opts.allowHttp && scheme === 'http')) issues.push(`${n}: the address must start with https://`);
        if (m[2] !== undefined) issues.push(`${n}: put no user name or password in the address`);
        if (url.length > 500) issues.push(`${n}: keep the address under 500 characters`);
      }
      return { type: 'WEBHOOK', url };
    }
    issues.push(`${n}: unknown action`);
    return a;
  });
  if (issues.length) throw new WorkflowError(issues.length === 1 ? issues[0] : `${issues.length} problems in the workflow`, issues);
  return { trigger: def.trigger, conditions, actions };
}

/** Fills {{fact}} placeholders with the event's values; money is shown as given (a decimal string). Unknown or missing values become "—". */
export function renderTemplate(template: string, facts: Facts, format: (key: string, value: string) => string = (_k, v) => v): string {
  return template.replace(PLACEHOLDER, (_m, key: string) => {
    const v = facts[key];
    return v === null || v === undefined || v === '' ? '—' : format(key, v);
  });
}

// ---------------------------------------------------------------- webhook delivery

/** Delay before each retry of a failed webhook, in seconds: 1 min, 5 min, 30 min, 2 h, 6 h. Six attempts in all. */
export const WEBHOOK_RETRY_DELAYS = [60, 300, 1800, 7200, 21600] as const;
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS.length + 1;

/** Whether a failed delivery is worth trying again: network errors, timeouts, 408, 429 and 5xx are; other 4xx answers are not. */
export function webhookRetryable(status: number | null): boolean {
  return status === null || status === 408 || status === 429 || status >= 500;
}

/** When to try again after the given attempt (1-based) failed, or null when there are no attempts left or the failure is final. */
export function nextWebhookAttempt(attempt: number, status: number | null, now: Date): Date | null {
  if (!webhookRetryable(status) || attempt >= WEBHOOK_MAX_ATTEMPTS) return null;
  return new Date(now.getTime() + WEBHOOK_RETRY_DELAYS[attempt - 1] * 1000);
}

/** Total of a list of decimal strings (used for journal totals as a fact). */
export function sumAmounts(values: (string | Dec)[]): string {
  return values.reduce<Dec>((s, v) => s.plus(new D(v)), new D(0)).toFixed();
}
