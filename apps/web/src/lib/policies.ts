/** Types and labels for the policy studio. */
import type { Action, Catalogue, Condition, TriggerParams } from './workflows';

export type PolicyStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';
export type Expect = 'ACTS' | 'DOES_NOT_ACT';
export interface PolicyRule {
  name: string;
  trigger: string;
  triggerParams: TriggerParams;
  conditions: Condition[];
  actions: Action[];
}
export interface PolicyTest {
  rule: number;
  label: string;
  facts: Record<string, string | null>;
  expect: Expect;
}
export interface ConditionResult {
  label: string;
  passed: boolean;
  actual: string | null;
}
export interface TestResult {
  index: number;
  rule: number;
  label: string;
  expect: Expect;
  actual: Expect | null;
  passed: boolean;
  conditions: ConditionResult[];
  problem: string | null;
}
export interface PolicyCatalogue extends Catalogue {
  policyLimits: { rules: number; tests: number; backtestDays: number };
}
export interface PolicyView {
  id: string;
  number: string;
  name: string;
  statement: string;
  status: PolicyStatus;
  version: number;
  activeVersion: number | null;
  rules: (PolicyRule & { description: string })[];
  tests: PolicyTest[];
  testResults: TestResult[];
  testsPassing: boolean;
  workflowIds: string[];
  createdById: string;
  updatedById: string;
  approvedById: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  people: Record<string, string>;
}
export interface PolicyDetail extends PolicyView {
  workflows: { rule: number; id: string; name: string | null; enabled: boolean; currentVersion: number | null }[];
  versions: { version: number; event: 'CREATED' | 'EDITED' | 'APPROVED' | 'RETIRED'; name: string; statement: string; rules: PolicyRule[]; tests: PolicyTest[]; note: string | null; createdById: string; createdAt: string }[];
}
export interface CheckResult {
  issues: string[];
  descriptions: (string | null)[];
  testResults: TestResult[];
}
export interface Backtest {
  days: number;
  rules: { rule: number; supported: boolean; note: string | null; checked: number; acted: number; examples: { label: string; at: string; facts: Record<string, string | null> }[] }[];
}
export interface AiStatus {
  configured: boolean;
  model: string | null;
  available: boolean;
  reason: string | null;
}
export interface AiDraft extends CheckResult {
  draftId: string;
  name: string;
  summary: string;
  rules: PolicyRule[];
  tests: PolicyTest[];
  questions: string[];
  model: string;
}

export const STATUS: Record<PolicyStatus, { label: string; tone: 'neutral' | 'positive' | 'warning' | 'negative' }> = {
  DRAFT: { label: 'Waiting for approval', tone: 'warning' },
  ACTIVE: { label: 'Approved and running', tone: 'positive' },
  RETIRED: { label: 'Retired', tone: 'neutral' },
};
export const EVENT: Record<PolicyDetail['versions'][number]['event'], string> = { CREATED: 'Created', EDITED: 'Edited', APPROVED: 'Approved', RETIRED: 'Retired' };
