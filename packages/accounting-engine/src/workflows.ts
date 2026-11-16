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
  'SCHEDULE',
  'INVOICE_OVERDUE',
  'BILL_DUE_SOON',
] as const;
export type WorkflowTrigger = (typeof WORKFLOW_TRIGGERS)[number];

export interface TriggerDef {
  key: WorkflowTrigger;
  label: string;
  description: string;
  /**
   * event: starts when something is recorded (read from the audit trail).
   * schedule: starts at a time (SCHEDULE), or when a date is reached (INVOICE_OVERDUE, BILL_DUE_SOON).
   */
  kind: 'event' | 'schedule';
  /** The audit-trail actions this trigger listens to (none for schedule triggers). */
  auditActions: readonly string[];
  facts: FactDef[];
  /** Whether an email can go to the customer or vendor the event is about (the contactEmail fact). */
  emailsContact: boolean;
}

const contact = (label: string): FactDef => ({ key: 'contactName', label, type: 'text' });
const contactEmail = (label: string): FactDef => ({ key: 'contactEmail', label: `${label} email`, type: 'text' });
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
    kind: 'event',
    auditActions: ['document.posted'],
    emailsContact: true,
    facts: [
      { key: 'number', label: 'Invoice number', type: 'text' },
      contact('Customer'), contactEmail('Customer'),
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
    kind: 'event',
    auditActions: ['document.posted'],
    emailsContact: true,
    facts: [
      { key: 'number', label: 'Bill number', type: 'text' },
      contact('Vendor'), contactEmail('Vendor'),
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
    kind: 'event',
    auditActions: ['document.voided'],
    emailsContact: false,
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
    kind: 'event',
    auditActions: ['payment.recorded'],
    emailsContact: true,
    facts: [{ key: 'number', label: 'Receipt number', type: 'text' }, contact('Customer'), contactEmail('Customer'), { key: 'amount', label: 'Amount', type: 'money' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'reference', label: 'Reference', type: 'text' }],
  },
  {
    key: 'VENDOR_PAYMENT_RECORDED',
    label: 'A vendor is paid',
    description: 'A payment to a vendor is recorded.',
    kind: 'event',
    auditActions: ['payment.recorded'],
    emailsContact: true,
    facts: [{ key: 'number', label: 'Payment number', type: 'text' }, contact('Vendor'), contactEmail('Vendor'), { key: 'amount', label: 'Amount', type: 'money' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'reference', label: 'Reference', type: 'text' }],
  },
  {
    key: 'JOURNAL_POSTED',
    label: 'A manual journal is posted',
    description: 'A journal entry typed in by a person is posted (not those made by invoices, payments or other modules).',
    kind: 'event',
    auditActions: ['journal.posted', 'journal.created_and_posted'],
    emailsContact: false,
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
    kind: 'event',
    auditActions: ['expense_claim.submitted'],
    emailsContact: false,
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
    kind: 'event',
    auditActions: ['alert.opened'],
    emailsContact: false,
    facts: [SEVERITY, { key: 'check', label: 'Check', type: 'text' }, { key: 'title', label: 'Title', type: 'text' }, { key: 'amount', label: 'Amount at stake', type: 'money' }],
  },
  {
    key: 'SCHEDULE',
    label: 'On a schedule',
    description: 'Every day, every week on a weekday, or every month on a day, at a time (India time).',
    kind: 'schedule',
    auditActions: [],
    emailsContact: false,
    facts: [
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'weekday', label: 'Weekday', type: 'text' },
      { key: 'overdueReceivables', label: 'Overdue receivables', type: 'money' },
      { key: 'overduePayables', label: 'Overdue payables', type: 'money' },
      { key: 'receivablesOutstanding', label: 'Receivables outstanding', type: 'money' },
      { key: 'payablesOutstanding', label: 'Payables outstanding', type: 'money' },
    ],
  },
  {
    key: 'INVOICE_OVERDUE',
    label: 'An invoice is overdue',
    description: 'A posted invoice still has something to pay a number of days after its due date.',
    kind: 'schedule',
    auditActions: [],
    emailsContact: true,
    facts: [
      { key: 'number', label: 'Invoice number', type: 'text' },
      contact('Customer'),
      contactEmail('Customer'),
      { key: 'total', label: 'Total', type: 'money' },
      { key: 'balance', label: 'Still to pay', type: 'money' },
      { key: 'issueDate', label: 'Issue date', type: 'date' },
      { key: 'dueDate', label: 'Due date', type: 'date' },
      { key: 'reference', label: 'Reference', type: 'text' },
    ],
  },
  {
    key: 'BILL_DUE_SOON',
    label: 'A bill is due soon',
    description: 'A posted bill still has something to pay a number of days before its due date.',
    kind: 'schedule',
    auditActions: [],
    emailsContact: true,
    facts: [
      { key: 'number', label: 'Bill number', type: 'text' },
      contact('Vendor'),
      contactEmail('Vendor'),
      { key: 'total', label: 'Total', type: 'money' },
      { key: 'balance', label: 'Still to pay', type: 'money' },
      { key: 'issueDate', label: 'Bill date', type: 'date' },
      { key: 'dueDate', label: 'Due date', type: 'date' },
      { key: 'reference', label: 'Vendor invoice number', type: 'text' },
    ],
  },
];

export function triggerDef(key: string): TriggerDef {
  const t = WORKFLOW_TRIGGER_DEFS.find((x) => x.key === key);
  if (!t) throw new WorkflowError(`Unknown trigger "${key}"`);
  return t;
}

// ---------------------------------------------------------------- trigger settings and schedules

export const SCHEDULE_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/**
 * Settings of a schedule trigger. SCHEDULE: frequency, time (HH:MM, India time), weekday
 * (1 = Monday … 7 = Sunday) for WEEKLY, dayOfMonth (1–28) for MONTHLY.
 * INVOICE_OVERDUE: days after the due date (1–365). BILL_DUE_SOON: days before the due date (0–90).
 * Event triggers take none.
 */
export interface TriggerParams {
  frequency?: ScheduleFrequency;
  time?: string;
  weekday?: number;
  dayOfMonth?: number;
  days?: number;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** Checks a trigger's settings; returns them cleaned (only the keys that apply) and the problems found. */
export function checkTriggerParams(trigger: WorkflowTrigger, raw: TriggerParams | null | undefined): { params: TriggerParams; issues: string[] } {
  const p = raw ?? {};
  const issues: string[] = [];
  if (trigger === 'SCHEDULE') {
    const frequency = p.frequency;
    if (!frequency || !(SCHEDULE_FREQUENCIES as readonly string[]).includes(frequency)) {
      issues.push('Schedule: choose every day, every week or every month');
      return { params: {}, issues };
    }
    const time = (p.time ?? '').trim();
    if (!TIME.test(time)) issues.push('Schedule: enter a time as HH:MM (24-hour, India time)');
    const out: TriggerParams = { frequency, time };
    if (frequency === 'WEEKLY') {
      if (!isInt(p.weekday, 1, 7)) issues.push('Schedule: choose a weekday');
      out.weekday = p.weekday;
    }
    if (frequency === 'MONTHLY') {
      if (!isInt(p.dayOfMonth, 1, 28)) issues.push('Schedule: choose a day of the month from 1 to 28');
      out.dayOfMonth = p.dayOfMonth;
    }
    return { params: out, issues };
  }
  if (trigger === 'INVOICE_OVERDUE') {
    if (!isInt(p.days, 1, 365)) issues.push('Trigger: an invoice is overdue 1 to 365 days after its due date');
    return { params: { days: p.days }, issues };
  }
  if (trigger === 'BILL_DUE_SOON') {
    if (!isInt(p.days, 0, 90)) issues.push('Trigger: a bill is due soon 0 to 90 days before its due date');
    return { params: { days: p.days }, issues };
  }
  return { params: {}, issues };
}

/** Plain-language description of a trigger with its settings. */
export function describeTrigger(trigger: WorkflowTrigger, params: TriggerParams = {}): string {
  if (trigger === 'SCHEDULE') {
    const at = `at ${params.time ?? '??:??'} India time`;
    if (params.frequency === 'DAILY') return `Every day ${at}`;
    if (params.frequency === 'WEEKLY') return `Every ${WEEKDAYS[(params.weekday ?? 1) - 1]} ${at}`;
    return `Every month on day ${params.dayOfMonth ?? '?'} ${at}`;
  }
  const d = params.days ?? 0;
  if (trigger === 'INVOICE_OVERDUE') return `An invoice is ${d} day${d === 1 ? '' : 's'} overdue`;
  if (trigger === 'BILL_DUE_SOON') return d === 0 ? 'A bill is due today' : `A bill is due in ${d} day${d === 1 ? '' : 's'}`;
  return triggerDef(trigger).label;
}

/** The India date (YYYY-MM-DD) of an instant. */
export function istDate(at: Date): string {
  return new Date(at.getTime() + IST_MS).toISOString().slice(0, 10);
}

/** Adds days to a YYYY-MM-DD date. */
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The most recent time a schedule came round at or before now, as an instant and its India
 * date. Times are India time (UTC+05:30, no daylight saving).
 */
export function latestOccurrence(params: TriggerParams, now: Date): { at: Date; date: string } {
  const m = TIME.exec(params.time ?? '');
  if (!m || !params.frequency) throw new WorkflowError('The schedule is not complete');
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  const wall = new Date(now.getTime() + IST_MS); // India wall-clock time, read with UTC getters
  const day = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  const at = (dayStart: number) => dayStart + minutes * 60_000;
  let t: number;
  if (params.frequency === 'DAILY') {
    t = at(day);
    if (t > wall.getTime()) t -= DAY_MS;
  } else if (params.frequency === 'WEEKLY') {
    const dow = ((wall.getUTCDay() + 6) % 7) + 1; // 1 = Monday
    t = at(day - (((dow - (params.weekday ?? 1)) + 7) % 7) * DAY_MS);
    if (t > wall.getTime()) t -= 7 * DAY_MS;
  } else {
    const dom = params.dayOfMonth ?? 1;
    t = at(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), dom));
    if (t > wall.getTime()) t = at(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() - 1, dom));
  }
  return { at: new Date(t - IST_MS), date: new Date(t).toISOString().slice(0, 10) };
}

/**
 * For INVOICE_OVERDUE and BILL_DUE_SOON: the due dates whose documents reach the trigger
 * on India dates from `from` to `to` (inclusive). An invoice N days overdue on day X was
 * due on X − N; a bill due in N days on day X is due on X + N.
 */
export function dueDateWindow(trigger: 'INVOICE_OVERDUE' | 'BILL_DUE_SOON', days: number, from: string, to: string): { from: string; to: string } {
  const shift = trigger === 'INVOICE_OVERDUE' ? -days : days;
  return { from: shiftDate(from, shift), to: shiftDate(to, shift) };
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
/** Who an email goes to: everyone with a role, one member, or the customer or vendor the event is about. */
export type EmailRecipient = { role: AssignableRole } | { userId: string } | { contact: true };
export interface SendEmailAction {
  type: 'SEND_EMAIL';
  to: EmailRecipient;
  /** Templates: {{fact}} is replaced by the event's value. Plain text. */
  subject: string;
  body: string;
}
export type WorkflowAction = CreateTaskAction | WebhookAction | SendEmailAction;
export const WORKFLOW_ACTION_TYPES = ['CREATE_TASK', 'WEBHOOK', 'SEND_EMAIL'] as const;

export interface WorkflowDefinition {
  trigger: WorkflowTrigger;
  /** Settings of a schedule trigger; {} for event triggers. */
  triggerParams?: TriggerParams;
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
  const tp = checkTriggerParams(def.trigger, def.triggerParams);
  issues.push(...tp.issues);
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
    if (a.type === 'SEND_EMAIL') {
      const subject = (a.subject ?? '').trim();
      const body = (a.body ?? '').trim();
      if (!subject) issues.push(`${n}: give the email a subject`);
      if (subject.length > 200) issues.push(`${n}: keep the subject under 200 characters`);
      if (/[\r\n]/.test(subject)) issues.push(`${n}: keep the subject on one line`);
      if (!body) issues.push(`${n}: write the email`);
      if (body.length > 5000) issues.push(`${n}: keep the email under 5,000 characters`);
      placeholders(subject, n);
      placeholders(body, n);
      const to = a.to as Partial<{ role: string; userId: string; contact: boolean }> | undefined;
      if (!to) issues.push(`${n}: choose who the email goes to`);
      else if ('contact' in to) {
        if (to.contact !== true) issues.push(`${n}: choose who the email goes to`);
        else if (!t.emailsContact) issues.push(`${n}: ${t.label.toLowerCase()} has no customer or vendor to email`);
      } else if ('role' in to) {
        if (!(ASSIGNABLE_ROLES as readonly string[]).includes(to.role ?? '')) issues.push(`${n}: choose who the email goes to`);
      } else if (!/^[0-9a-f-]{36}$/i.test(to.userId ?? '')) issues.push(`${n}: choose who the email goes to`);
      return { type: 'SEND_EMAIL', to: a.to, subject, body };
    }
    issues.push(`${n}: unknown action`);
    return a;
  });
  if (issues.length) throw new WorkflowError(issues.length === 1 ? issues[0] : `${issues.length} problems in the workflow`, issues);
  return { trigger: def.trigger, triggerParams: tp.params, conditions, actions };
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

/**
 * Email delivery uses the same retry schedule. An SMTP server's 4xx answer (or no answer) is
 * temporary and tried again; a 5xx answer is final.
 */
export function smtpRetryable(code: number | null): boolean {
  return code === null || (code >= 400 && code < 500);
}

/** When to try a delivery again after the given attempt (1-based) failed; null when it is final or attempts are used up. */
export function nextDeliveryAttempt(attempt: number, retryable: boolean, now: Date): Date | null {
  if (!retryable || attempt >= WEBHOOK_MAX_ATTEMPTS) return null;
  return new Date(now.getTime() + WEBHOOK_RETRY_DELAYS[attempt - 1] * 1000);
}

/**
 * An amount for people to read in an email: grouped digits (Indian grouping for INR, as in
 * ₹1,50,000.00) and the currency. Works on the decimal string, never a floating-point number.
 */
export function formatAmountText(value: string, currency: string): string {
  const neg = value.startsWith('-');
  const [int, frac] = (neg ? value.slice(1) : value).split('.');
  let grouped: string;
  if (currency === 'INR' && int.length > 3) {
    const head = int.slice(0, -3);
    grouped = `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${int.slice(-3)}`;
  } else grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const n = `${neg ? '-' : ''}${grouped}${frac !== undefined ? `.${frac}` : ''}`;
  return currency === 'INR' ? `₹${n}` : `${currency} ${n}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A YYYY-MM-DD date for people to read: 2 Nov 2026. */
export function formatDateText(date: string): string {
  const m = DATE.exec(date) ? date.split('-') : null;
  return m ? `${Number(m[2])} ${MONTHS[Number(m[1]) - 1]} ${m[0]}` : date;
}

/** Total of a list of decimal strings (used for journal totals as a fact). */
export function sumAmounts(values: (string | Dec)[]): string {
  return values.reduce<Dec>((s, v) => s.plus(new D(v)), new D(0)).toFixed();
}
