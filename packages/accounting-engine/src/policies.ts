/**
 * Financial policies: a policy written in plain words ("bills over ₹5 lakh need an approver's
 * review within two days") together with the rules that enforce it. Each rule is an ordinary
 * workflow definition (trigger, conditions, actions), so an approved policy runs through the
 * workflow runner. Test cases state, for given facts, whether a rule should act; a policy can
 * only be approved when every test passes.
 *
 * No framework or database code.
 */
import { D } from './money';
import {
  describeTrigger,
  evaluateConditions,
  OPERATOR_LABELS,
  triggerDef,
  validateWorkflow,
  WorkflowError,
  type Condition,
  type ConditionResult,
  type Facts,
  type WorkflowAction,
  type WorkflowDefinition,
} from './workflows';

export const MAX_POLICY_RULES = 10;
export const MAX_POLICY_TESTS = 30;

export interface PolicyRule extends WorkflowDefinition {
  /** A short name for the rule, used for its workflow. */
  name: string;
}

export interface PolicyTest {
  /** 1-based position of the rule the test is about. */
  rule: number;
  label: string;
  /** Fact values for the made-up event; missing facts count as empty. */
  facts: Facts;
  expect: 'ACTS' | 'DOES_NOT_ACT';
}

export interface PolicyTestResult {
  index: number;
  rule: number;
  label: string;
  expect: PolicyTest['expect'];
  actual: PolicyTest['expect'] | null;
  passed: boolean;
  conditions: ConditionResult[];
  /** Why the test could not run (a fact the trigger does not have, a bad amount). */
  problem: string | null;
}

const ROLE_NAMES: Record<string, string> = { OWNER: 'Owners', ADMIN: 'Admins', ACCOUNTANT: 'Accountants', APPROVER: 'Approvers', VIEWER: 'Viewers' };
const MONEY = /^-?\d{1,18}(\.\d{1,6})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Checks a policy's rules and tests. Returns the rules cleaned up by the workflow validator,
 * and every problem, each prefixed with the rule or test it is about.
 */
export function checkPolicy(p: { name: string; statement: string; rules: PolicyRule[]; tests: PolicyTest[] }, opts: { allowHttp?: boolean } = {}): { rules: PolicyRule[]; issues: string[] } {
  const issues: string[] = [];
  if (!p.name?.trim()) issues.push('Give the policy a name');
  if (!p.statement?.trim()) issues.push('Write the policy in words');
  if (!p.rules.length) issues.push('Add at least one rule');
  if (p.rules.length > MAX_POLICY_RULES) issues.push(`At most ${MAX_POLICY_RULES} rules in a policy`);
  if (p.tests.length > MAX_POLICY_TESTS) issues.push(`At most ${MAX_POLICY_TESTS} tests in a policy`);
  const rules = p.rules.map((r, i) => {
    if (!r.name?.trim()) issues.push(`Rule ${i + 1}: give the rule a name`);
    else if (r.name.trim().length > 100) issues.push(`Rule ${i + 1}: keep the name under 100 characters`);
    try {
      const def = validateWorkflow({ trigger: r.trigger, triggerParams: r.triggerParams ?? {}, conditions: r.conditions ?? [], actions: r.actions ?? [] }, opts);
      return { name: r.name?.trim() ?? '', ...def };
    } catch (e) {
      if (!(e instanceof WorkflowError)) throw e;
      issues.push(...e.issues.map((x) => `Rule ${i + 1}: ${x}`));
      return r;
    }
  });
  p.tests.forEach((t, i) => {
    const where = `Test ${i + 1}`;
    if (!t.label?.trim()) issues.push(`${where}: describe the test`);
    if (!Number.isInteger(t.rule) || t.rule < 1 || t.rule > p.rules.length) return issues.push(`${where}: choose a rule from 1 to ${p.rules.length}`);
    if (t.expect !== 'ACTS' && t.expect !== 'DOES_NOT_ACT') issues.push(`${where}: say whether the rule should act`);
    issues.push(...factProblems(p.rules[t.rule - 1]!, t.facts).map((x) => `${where}: ${x}`));
  });
  return { rules, issues };
}

function factProblems(rule: PolicyRule, facts: Facts): string[] {
  const out: string[] = [];
  let t;
  try {
    t = triggerDef(rule.trigger);
  } catch {
    return [];
  }
  for (const [k, v] of Object.entries(facts ?? {})) {
    const f = t.facts.find((x) => x.key === k);
    if (!f) out.push(`"${k}" is not a fact of ${t.label.toLowerCase()}`);
    else if (v !== null && v !== '' && f.type === 'money' && !MONEY.test(v)) out.push(`${f.label} must be an amount such as 500000.00`);
    else if (v !== null && v !== '' && f.type === 'date' && !DATE.test(v)) out.push(`${f.label} must be a date written YYYY-MM-DD`);
    else if (v !== null && v !== '' && f.type === 'enum' && !f.options?.some((o) => o.value === v)) out.push(`${f.label} must be one of ${f.options?.map((o) => o.label).join(', ')}`);
  }
  return out;
}

/** Runs every test against its rule's conditions. */
export function runPolicyTests(rules: readonly PolicyRule[], tests: readonly PolicyTest[]): PolicyTestResult[] {
  return tests.map((t, i) => {
    const base = { index: i + 1, rule: t.rule, label: t.label, expect: t.expect };
    const rule = rules[t.rule - 1];
    if (!rule) return { ...base, actual: null, passed: false, conditions: [], problem: 'The rule it tests no longer exists' };
    const bad = factProblems(rule, t.facts);
    if (bad.length) return { ...base, actual: null, passed: false, conditions: [], problem: bad.join('; ') };
    const facts: Facts = Object.fromEntries(Object.entries(t.facts ?? {}).map(([k, v]) => [k, v === '' ? null : v]));
    try {
      const r = evaluateConditions(rule.trigger, rule.conditions, facts);
      const actual = r.matched ? 'ACTS' : 'DOES_NOT_ACT';
      return { ...base, actual, passed: actual === t.expect, conditions: r.results, problem: null };
    } catch (e) {
      if (!(e instanceof WorkflowError)) throw e;
      return { ...base, actual: null, passed: false, conditions: [], problem: e.message };
    }
  });
}

function conditionWords(trigger: PolicyRule['trigger'], c: Condition, money: (v: string) => string): string {
  const f = triggerDef(trigger).facts.find((x) => x.key === c.fact);
  if (!f) return `${c.fact} ${OPERATOR_LABELS[c.op] ?? c.op} ${String(c.value ?? '')}`;
  const v = Array.isArray(c.value)
    ? c.value.map((x) => f.options?.find((o) => o.value === x)?.label ?? x).join(' or ')
    : f.type === 'money' && typeof c.value === 'string' && MONEY.test(c.value)
      ? money(c.value)
      : (c.value ?? '');
  return `${f.label.toLowerCase()} ${OPERATOR_LABELS[c.op]}${c.op === 'is_empty' || c.op === 'not_empty' ? '' : ` ${v}`}`;
}

function actionWords(a: WorkflowAction): string {
  switch (a.type) {
    case 'CREATE_TASK': {
      const who = 'role' in a.assignTo ? (ROLE_NAMES[a.assignTo.role] ?? a.assignTo.role) : 'one member';
      return `give ${who} a task "${a.title}"${a.dueInDays === null || a.dueInDays === undefined ? '' : a.dueInDays === 0 ? ', due the same day' : `, due in ${a.dueInDays} day${a.dueInDays === 1 ? '' : 's'}`}`;
    }
    case 'SEND_EMAIL': {
      const who = 'role' in a.to ? (ROLE_NAMES[a.to.role] ?? a.to.role) : 'contact' in a.to ? 'the customer or vendor' : 'one member';
      return `email ${who}: "${a.subject}"`;
    }
    case 'WEBHOOK':
      return `send a webhook to ${a.url}`;
  }
}

/** A rule in plain words, for people to check before approving it. */
export function describeRule(rule: PolicyRule, currency = 'INR'): string {
  const money = (v: string) => `${currency} ${new D(v).toFixed(2)}`;
  let when: string;
  try {
    when = describeTrigger(rule.trigger, rule.triggerParams ?? {});
  } catch {
    when = rule.trigger;
  }
  const conds = (rule.conditions ?? []).map((c) => conditionWords(rule.trigger, c, money));
  const acts = (rule.actions ?? []).map(actionWords);
  return `${when.replace(/\.$/, '')}${conds.length ? `, and ${conds.join(' and ')}` : ''}: ${acts.length ? acts.join('; then ') : 'nothing happens'}.`;
}
