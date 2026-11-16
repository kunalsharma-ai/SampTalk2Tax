export type FactType = 'money' | 'text' | 'enum' | 'date';
export interface FactDef {
  key: string;
  label: string;
  type: FactType;
  options?: { value: string; label: string }[];
}
export interface TriggerDef {
  key: string;
  label: string;
  description: string;
  facts: FactDef[];
}
export interface Catalogue {
  triggers: TriggerDef[];
  operators: Record<FactType, { op: string; label: string }[]>;
  roles: { role: string; label: string }[];
  members: { userId: string; name: string; email: string; role: string }[];
  limits: { conditions: number; actions: number; webhookAttempts: number; retryDelaysSeconds: number[] };
  webhooksMustBeHttps: boolean;
}

export interface Condition {
  fact: string;
  op: string;
  value?: string | string[];
}
export type AssignTo = { role: string } | { userId: string };
export type Action = { type: 'CREATE_TASK'; title: string; description?: string; assignTo: AssignTo; dueInDays: number | null } | { type: 'WEBHOOK'; url: string };

export type RunStatus = 'SKIPPED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TEST';
export type ActionStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  version: number;
  trigger: string;
  triggerLabel: string;
  conditions: number;
  actions: ('CREATE_TASK' | 'WEBHOOK')[];
  lastRun: { status: RunStatus; at: string } | null;
  last30Days: { acted: number; skipped: number; failed: number };
}

export interface Attempt {
  at: string;
  status: number | null;
  ok: boolean;
  durationMs: number;
  error: string | null;
  responseSnippet: string | null;
}
export interface Run {
  id: string;
  workflowId: string;
  version: number;
  trigger: string;
  triggerLabel: string;
  status: RunStatus;
  error: string | null;
  eventId: string | null;
  link: { path: string; label: string } | null;
  facts: { key: string; label: string; type: FactType; value: string | null; display: string | null }[];
  conditions: { label: string; passed: boolean; actual: string | null }[];
  actions: {
    position: number;
    type: 'CREATE_TASK' | 'WEBHOOK';
    status: ActionStatus;
    input: { url?: string; title?: string; description?: string | null; assigneeLabel?: string; dueDate?: string | null };
    taskId: string | null;
    attempts: number;
    history: Attempt[];
    nextAttemptAt: string | null;
    error: string | null;
    finishedAt: string | null;
    canRetry: boolean;
  }[];
  testedBy: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface Workflow {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  version: number;
  trigger: string;
  triggerLabel: string;
  conditions: Condition[];
  actions: Action[];
  signingSecret: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  versions: { version: number; trigger: string; note: string | null; createdBy: string | null; createdAt: string }[];
  recentRuns: Run[];
}

export const RUN_STATUS: Record<RunStatus, { label: string; tone: 'neutral' | 'accent' | 'positive' | 'warning' | 'negative' | 'violet' }> = {
  SUCCEEDED: { label: 'Done', tone: 'positive' },
  RUNNING: { label: 'Sending', tone: 'accent' },
  FAILED: { label: 'Failed', tone: 'negative' },
  SKIPPED: { label: 'Conditions not met', tone: 'neutral' },
  TEST: { label: 'Test', tone: 'violet' },
};
export const ACTION_STATUS: Record<ActionStatus, { label: string; tone: 'neutral' | 'accent' | 'positive' | 'warning' | 'negative' | 'violet' }> = {
  SUCCEEDED: { label: 'Done', tone: 'positive' },
  PENDING: { label: 'Waiting to send', tone: 'accent' },
  FAILED: { label: 'Failed', tone: 'negative' },
  SKIPPED: { label: 'Not done (test)', tone: 'neutral' },
};

export function seconds(s: number): string {
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${s / 60} min`;
  return `${s / 3600} h`;
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

/** Plain-language summary of one condition, for the overview. */
export function describeCondition(c: Condition, t: TriggerDef | undefined, cat: Catalogue | undefined): string {
  const f = t?.facts.find((x) => x.key === c.fact);
  const op = f && cat ? cat.operators[f.type].find((o) => o.op === c.op)?.label : c.op;
  const v = Array.isArray(c.value) ? c.value.map((x) => f?.options?.find((o) => o.value === x)?.label ?? x).join(', ') : (c.value ?? '');
  return `${f?.label ?? c.fact} ${op ?? c.op}${c.op === 'is_empty' || c.op === 'not_empty' ? '' : ` ${v}`}`;
}

export function assigneeLabel(a: AssignTo, cat: Catalogue | undefined): string {
  if ('role' in a) return cat?.roles.find((r) => r.role === a.role)?.label ?? a.role;
  return cat?.members.find((m) => m.userId === a.userId)?.name ?? 'A former member';
}
