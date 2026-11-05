import { describe, expect, it } from 'vitest';
import { checkPolicy, describeRule, runPolicyTests, type PolicyRule, type PolicyTest } from '../src';

const bigBills: PolicyRule = {
  name: 'Review large bills',
  trigger: 'BILL_POSTED',
  conditions: [{ fact: 'total', op: 'gt', value: '500000' }],
  actions: [{ type: 'CREATE_TASK', title: 'Review bill {{number}} from {{contactName}}', assignTo: { role: 'APPROVER' }, dueInDays: 2 }],
};
const journals: PolicyRule = {
  name: 'Tell owners about large manual journals',
  trigger: 'JOURNAL_POSTED',
  conditions: [{ fact: 'total', op: 'gte', value: '100000' }],
  actions: [{ type: 'SEND_EMAIL', to: { role: 'OWNER' }, subject: 'Manual journal {{number}} posted', body: '{{postedBy}} posted {{total}}.' }],
};
const tests: PolicyTest[] = [
  { rule: 1, label: 'A ₹6 lakh bill needs review', facts: { total: '600000.00', number: 'B-1' }, expect: 'ACTS' },
  { rule: 1, label: 'Exactly ₹5 lakh does not', facts: { total: '500000.00' }, expect: 'DOES_NOT_ACT' },
  { rule: 2, label: 'A ₹1 lakh journal is reported', facts: { total: '100000.00' }, expect: 'ACTS' },
];

describe('financial policies', () => {
  it('checks rules with the workflow validator and tests against the rule’s facts', () => {
    const ok = checkPolicy({ name: 'Spending control', statement: 'Large bills need review.', rules: [bigBills, journals], tests });
    expect(ok.issues).toEqual([]);
    expect(ok.rules[0]!.conditions[0]).toMatchObject({ fact: 'total', op: 'gt', value: '500000' });

    const bad = checkPolicy({
      name: ' ',
      statement: '',
      rules: [{ ...bigBills, name: '', conditions: [{ fact: 'colour', op: 'eq', value: 'red' }] }],
      tests: [
        { rule: 2, label: 'x', facts: {}, expect: 'ACTS' },
        { rule: 1, label: 'bad amount', facts: { total: 'lots', size: '1' }, expect: 'ACTS' },
      ],
    });
    expect(bad.issues[0]).toBe('Give the policy a name');
    expect(bad.issues).toContain('Write the policy in words');
    expect(bad.issues).toContain('Rule 1: give the rule a name');
    expect(bad.issues.some((i) => i.startsWith('Rule 1: ') && /colour/.test(i))).toBe(true);
    expect(bad.issues).toContain('Test 1: choose a rule from 1 to 1');
    expect(bad.issues).toContain('Test 2: Total must be an amount such as 500000.00');
    expect(bad.issues).toContain('Test 2: "size" is not a fact of a bill is posted');
  });

  it('runs tests and says which pass, with each condition’s actual value', () => {
    const r = runPolicyTests([bigBills, journals], [...tests, { rule: 1, label: 'Wrong expectation', facts: { total: '10.00' }, expect: 'ACTS' }, { rule: 3, label: 'Gone', facts: {}, expect: 'ACTS' }]);
    expect(r.map((x) => [x.index, x.actual, x.passed])).toEqual([
      [1, 'ACTS', true],
      [2, 'DOES_NOT_ACT', true],
      [3, 'ACTS', true],
      [4, 'DOES_NOT_ACT', false],
      [5, null, false],
    ]);
    expect(r[1]!.conditions[0]).toMatchObject({ label: 'Total is more than 500000', passed: false, actual: '500000.00' });
    expect(r[4]!.problem).toBe('The rule it tests no longer exists');
    // A missing fact is empty, so a money condition on it does not hold.
    expect(runPolicyTests([bigBills], [{ rule: 1, label: 'No total', facts: {}, expect: 'DOES_NOT_ACT' }])[0]!.passed).toBe(true);
  });

  it('describes rules in plain words for approval', () => {
    expect(describeRule(bigBills)).toBe('A bill is posted, and total is more than INR 500000.00: give Approvers a task "Review bill {{number}} from {{contactName}}", due in 2 days.');
    expect(describeRule(journals)).toBe('A manual journal is posted, and total debits is at least INR 100000.00: email Owners: "Manual journal {{number}} posted".');
    expect(describeRule({ name: 'Overdue', trigger: 'INVOICE_OVERDUE', triggerParams: { days: 30 }, conditions: [], actions: [{ type: 'SEND_EMAIL', to: { contact: true }, subject: 'Reminder', body: 'Please pay.' }] })).toBe('An invoice is 30 days overdue: email the customer or vendor: "Reminder".');
  });
});
