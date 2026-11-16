'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, CardHeader, Field, Input, Select, Textarea } from '@talk2tax/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { BacktestResults, TestResults } from '@/components/policies/test-results';
import { ActionCard, blankCondition, ConditionRow, defaultParams, TriggerSettings } from '@/components/workflows/editor';
import { api } from '@/lib/api';
import type { AiDraft, AiStatus, Backtest, CheckResult, PolicyCatalogue, PolicyDetail, PolicyRule, PolicyTest } from '@/lib/policies';
import type { Action, TriggerDef } from '@/lib/workflows';

interface Draft {
  name: string;
  statement: string;
  rules: PolicyRule[];
  tests: PolicyTest[];
  note: string;
}
type Turn = { role: 'user' | 'assistant'; text: string };

const cleanRules = (rules: PolicyRule[]) =>
  rules.map((r) => ({
    name: r.name,
    trigger: r.trigger,
    triggerParams: r.triggerParams ?? {},
    conditions: r.conditions.map((c) => (c.op === 'is_empty' || c.op === 'not_empty' ? { fact: c.fact, op: c.op } : c)),
    actions: r.actions.map((a) => (a.type === 'CREATE_TASK' ? { ...a, description: a.description || undefined } : a)),
  }));
const cleanTests = (tests: PolicyTest[]) => tests.map((t) => ({ ...t, facts: Object.fromEntries(Object.entries(t.facts).filter(([, v]) => v !== '' && v !== null)) }));

/**
 * Writes a policy: the policy in words, the rules that enforce it (the workflow builder's
 * trigger, conditions and actions) and test cases. Tests run on the server without saving, and
 * the rules can be back-tested on the last 90 days of events. The AI can draft rules and tests
 * from the words; people check and save them.
 */
export function PolicyEditor({ orgId, catalogue, policy, ai, canDraft }: { orgId: string; catalogue: PolicyCatalogue; policy?: PolicyDetail; ai: AiStatus | undefined; canDraft: boolean }) {
  const router = useRouter();
  const qc = useQueryClient();
  const firstTrigger = catalogue.triggers.find((t) => t.key === 'BILL_POSTED') ?? catalogue.triggers[0]!;
  const blankRule = (): PolicyRule => ({ name: '', trigger: firstTrigger.key, triggerParams: defaultParams(firstTrigger.key), conditions: [blankCondition(firstTrigger)], actions: [{ type: 'CREATE_TASK', title: '', assignTo: { role: 'APPROVER' }, dueInDays: 2 }] });
  const [d, setD] = useState<Draft>(() =>
    policy
      ? { name: policy.name, statement: policy.statement, rules: policy.rules.map(({ description: _d, ...r }) => ({ ...r, triggerParams: r.triggerParams ?? {} })), tests: policy.tests, note: '' }
      : { name: '', statement: '', rules: [blankRule()], tests: [], note: '' },
  );
  const set = (patch: Partial<Draft>) => setD((p) => ({ ...p, ...patch }));
  const setRule = (i: number, r: PolicyRule) => set({ rules: d.rules.map((x, j) => (j === i ? r : x)) });
  const setTest = (i: number, t: PolicyTest) => set({ tests: d.tests.map((x, j) => (j === i ? t : x)) });
  const body = () => ({ name: d.name, statement: d.statement, rules: cleanRules(d.rules), tests: cleanTests(d.tests) });

  const check = useMutation({ mutationFn: () => api<CheckResult>(`/v1/orgs/${orgId}/policies/check`, { method: 'POST', body: body() }) });
  const backtest = useMutation({ mutationFn: () => api<Backtest>(`/v1/orgs/${orgId}/policies/backtest`, { method: 'POST', body: { rules: cleanRules(d.rules) } }) });
  const save = useMutation({
    mutationFn: () =>
      policy
        ? api<PolicyDetail>(`/v1/orgs/${orgId}/policies/${policy.id}`, { method: 'PUT', body: { ...body(), baseVersion: policy.version, note: d.note || null } })
        : api<PolicyDetail>(`/v1/orgs/${orgId}/policies`, { method: 'POST', body: { ...body(), note: d.note || null } }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ['policies', orgId] });
      qc.setQueryData(['policy', orgId, p.id], p);
      router.push(`/orgs/${orgId}/governance/policies/${p.id}`);
    },
  });

  // Drafting with the AI: the words, then answers to its questions.
  const [conversation, setConversation] = useState<Turn[]>([]);
  const [answer, setAnswer] = useState('');
  const [proposal, setProposal] = useState<AiDraft | null>(null);
  const draft = useMutation({
    mutationFn: (turns: Turn[]) => api<AiDraft>(`/v1/orgs/${orgId}/policies/ai-draft`, { method: 'POST', body: { statement: d.statement, conversation: turns } }),
    onSuccess: (p, turns) => {
      setProposal(p);
      setConversation([...turns, { role: 'assistant', text: `${p.summary}${p.questions.length ? `\n\nQuestions:\n${p.questions.map((q) => `- ${q}`).join('\n')}` : ''}` }]);
      setAnswer('');
    },
  });
  const useDraft = () => {
    if (!proposal) return;
    set({ name: d.name || proposal.name, rules: proposal.rules.map((r) => ({ ...r, triggerParams: r.triggerParams ?? {}, conditions: r.conditions ?? [], actions: r.actions ?? [] })), tests: proposal.tests });
    check.reset();
    backtest.reset();
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Card>
        <CardHeader title="The policy in words" description="What the business has decided, as people would say it. The rules below put it into practice." />
        <div className="grid gap-4 p-5">
          <Field label="Policy name">{(p) => <Input {...p} value={d.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} placeholder="Spending control" />}</Field>
          <Field label="Policy">
            {(p) => <Textarea {...p} rows={3} value={d.statement} maxLength={4000} onChange={(e) => set({ statement: e.target.value })} placeholder="Bills over ₹5 lakh need an approver's review within two days." />}
          </Field>
          {canDraft ? (
            <div className="rounded-[var(--t2t-radius-md)] border border-line p-4" role="region" aria-label="Draft with AI">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">Draft the rules with AI</p>
                  <p className="text-xs text-fg-muted">The AI proposes rules and tests from the policy in words and asks about anything unclear. Nothing is saved until you save the policy, and it still needs an approver.</p>
                </div>
                <Button type="button" variant="secondary" size="sm" disabled={!ai?.available || !d.statement.trim()} loading={draft.isPending && conversation.length === 0} onClick={() => draft.mutate([])}>
                  {proposal ? 'Start again' : 'Draft with AI'}
                </Button>
              </div>
              {ai && !ai.available ? <p className="mt-2 text-xs text-fg-muted">{ai.reason}</p> : null}
              <ErrorAlert title="The AI could not draft the policy" error={draft.error} />
              {proposal ? (
                <div className="mt-3 flex flex-col gap-3" data-testid="ai-proposal">
                  <p className="text-sm">{proposal.summary}</p>
                  <ol className="list-inside list-decimal text-sm">
                    {proposal.rules.map((r, i) => (
                      <li key={i}>
                        <span className="font-medium">{r.name}:</span> {proposal.descriptions[i] ?? 'cannot be described; see the problems below'}
                      </li>
                    ))}
                  </ol>
                  <p className="text-xs text-fg-muted">
                    {proposal.tests.length} test{proposal.tests.length === 1 ? '' : 's'} proposed
                    {proposal.testResults.length ? `, ${proposal.testResults.filter((t) => t.passed).length} passing` : ''}.
                  </p>
                  {proposal.issues.length ? (
                    <Alert tone="warning" title="Problems in the draft">
                      <ul className="list-inside list-disc">{proposal.issues.map((i) => <li key={i}>{i}</li>)}</ul>
                    </Alert>
                  ) : null}
                  {proposal.questions.length ? (
                    <div>
                      <p className="text-sm font-medium">The AI asks</p>
                      <ul className="list-inside list-disc text-sm">{proposal.questions.map((q) => <li key={q}>{q}</li>)}</ul>
                      <div className="mt-2 flex flex-col gap-2 md:flex-row">
                        <Input aria-label="Your answer" value={answer} maxLength={4000} onChange={(e) => setAnswer(e.target.value)} placeholder="Answer, then ask the AI to revise the draft" />
                        <Button type="button" variant="secondary" size="sm" disabled={!answer.trim()} loading={draft.isPending && conversation.length > 0} onClick={() => draft.mutate([...conversation, { role: 'user', text: answer.trim() }])}>
                          Revise the draft
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  <div>
                    <Button type="button" size="sm" onClick={useDraft}>
                      Use this draft
                    </Button>
                    <span className="ml-2 text-xs text-fg-muted">Replaces the rules and tests below.</span>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </Card>

      {d.rules.map((r, i) => (
        <RuleCard key={i} index={i} r={r} catalogue={catalogue} onChange={(x) => setRule(i, x)} onRemove={d.rules.length > 1 ? () => set({ rules: d.rules.filter((_, j) => j !== i), tests: d.tests.filter((t) => t.rule !== i + 1).map((t) => (t.rule > i + 1 ? { ...t, rule: t.rule - 1 } : t)) }) : undefined} />
      ))}
      <div>
        <Button type="button" variant="secondary" size="sm" disabled={d.rules.length >= catalogue.policyLimits.rules} onClick={() => set({ rules: [...d.rules, blankRule()] })}>
          Add a rule
        </Button>
      </div>

      <Card>
        <CardHeader title="Tests" description="Made-up cases and whether a rule should act on them. Facts you leave empty count as empty. A policy can only be approved when every test passes." />
        <div className="flex flex-col gap-3 p-5">
          {d.tests.map((t, i) => (
            <TestRow key={i} index={i} t={t} rules={d.rules} catalogue={catalogue} onChange={(x) => setTest(i, x)} onRemove={() => set({ tests: d.tests.filter((_, j) => j !== i) })} />
          ))}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={d.tests.length >= catalogue.policyLimits.tests} onClick={() => set({ tests: [...d.tests, { rule: 1, label: '', facts: {}, expect: 'ACTS' }] })}>
              Add a test
            </Button>
            <Button type="button" variant="secondary" size="sm" loading={check.isPending} onClick={() => check.mutate()}>
              Run the tests
            </Button>
            <Button type="button" variant="secondary" size="sm" loading={backtest.isPending} onClick={() => backtest.mutate()}>
              Back-test on the last {catalogue.policyLimits.backtestDays} days
            </Button>
          </div>
        </div>
        <ErrorAlert title="Could not run the tests" error={check.error} />
        {check.data ? (
          <div className="border-t border-line pt-4" role="region" aria-label="Check">
            {check.data.issues.length ? (
              <div className="px-5 pb-3">
                <Alert tone="warning" title="Fix before saving">
                  <ul className="list-inside list-disc">{check.data.issues.map((i) => <li key={i}>{i}</li>)}</ul>
                </Alert>
              </div>
            ) : null}
            <ol className="list-inside list-decimal px-5 pb-3 text-sm">
              {check.data.descriptions.map((x, i) => (x ? <li key={i}>{x}</li> : null))}
            </ol>
            <TestResults results={check.data.testResults} />
          </div>
        ) : null}
        <ErrorAlert title="Could not back-test the rules" error={backtest.error} />
        {backtest.data ? <BacktestResults b={backtest.data} ruleNames={d.rules.map((r) => r.name)} /> : null}
      </Card>

      <Card>
        <div className="p-5">
          <Field label={policy ? 'What changed (optional)' : 'Note (optional)'} hint="Kept with this version of the policy.">
            {(p) => <Input {...p} value={d.note} maxLength={500} onChange={(e) => set({ note: e.target.value })} />}
          </Field>
        </div>
      </Card>

      <ErrorAlert title="The policy was not saved" error={save.error} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={save.isPending}>
          {policy ? 'Save as a new version' : 'Save policy'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.push(policy ? `/orgs/${orgId}/governance/policies/${policy.id}` : `/orgs/${orgId}/governance/policies`)}>
          Cancel
        </Button>
        <p className="text-sm text-fg-muted">{policy?.status === 'ACTIVE' ? `Version ${policy.activeVersion} keeps running until someone approves the new version.` : 'Saved policies wait for approval by someone else before their rules run.'}</p>
      </div>
    </form>
  );
}

function RuleCard({ index, r, catalogue, onChange, onRemove }: { index: number; r: PolicyRule; catalogue: PolicyCatalogue; onChange: (r: PolicyRule) => void; onRemove?: () => void }) {
  const t = catalogue.triggers.find((x) => x.key === r.trigger) ?? catalogue.triggers[0]!;
  const n = `Rule ${index + 1}`;
  const placeholders = t.facts.map((f) => `{{${f.key}}}`).join(' ');
  return (
    <Card>
      <fieldset aria-label={n}>
        <CardHeader title={`${n}${r.name ? `: ${r.name}` : ''}`} description="When something happens, and only if every condition holds, do these things." actions={onRemove ? <Button type="button" variant="ghost" size="sm" onClick={onRemove}>Remove rule</Button> : undefined} />
        <div className="flex flex-col gap-4 p-5">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={`${n} name`}>{(p) => <Input {...p} value={r.name} maxLength={100} onChange={(e) => onChange({ ...r, name: e.target.value })} placeholder="Review large bills" />}</Field>
            <Field label={`${n} trigger`} hint={t.description}>
              {(p) => (
                <Select
                  {...p}
                  value={r.trigger}
                  onChange={(e) => {
                    const next = catalogue.triggers.find((x) => x.key === e.target.value)!;
                    const actions = r.actions.map((a): Action => (a.type === 'SEND_EMAIL' && 'contact' in a.to && !next.emailsContact ? { ...a, to: { role: 'OWNER' } } : a));
                    onChange({ ...r, trigger: next.key, triggerParams: defaultParams(next.key), conditions: [], actions });
                  }}
                >
                  <optgroup label="When something is recorded">
                    {catalogue.triggers.filter((x) => x.kind === 'event').map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                  </optgroup>
                  <optgroup label="On a schedule or a date">
                    {catalogue.triggers.filter((x) => x.kind === 'schedule').map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                  </optgroup>
                </Select>
              )}
            </Field>
          </div>
          <TriggerSettings trigger={r.trigger} params={r.triggerParams} catalogue={catalogue} onChange={(triggerParams) => onChange({ ...r, triggerParams })} />
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">Only if</p>
            {r.conditions.map((c, i) => (
              <ConditionRow key={i} index={i} c={c} t={t} catalogue={catalogue} onChange={(x) => onChange({ ...r, conditions: r.conditions.map((y, j) => (j === i ? x : y)) })} onRemove={() => onChange({ ...r, conditions: r.conditions.filter((_, j) => j !== i) })} />
            ))}
            <div>
              <Button type="button" variant="secondary" size="sm" disabled={r.conditions.length >= catalogue.limits.conditions} onClick={() => onChange({ ...r, conditions: [...r.conditions, blankCondition(t)] })}>
                Add a condition
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">Do</p>
            <p className="text-xs text-fg-muted">Policy tasks and emails go to roles (or the customer or vendor), so they keep working when people change. {placeholders} are replaced by the values when it runs.</p>
            {r.actions.map((a, i) => (
              <ActionCard key={i} index={i} a={a} t={t} catalogue={catalogue} onChange={(x) => onChange({ ...r, actions: r.actions.map((y, j) => (j === i ? x : y)) })} onRemove={() => onChange({ ...r, actions: r.actions.filter((_, j) => j !== i) })} />
            ))}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" size="sm" disabled={r.actions.length >= catalogue.limits.actions} onClick={() => onChange({ ...r, actions: [...r.actions, { type: 'CREATE_TASK', title: '', assignTo: { role: 'APPROVER' }, dueInDays: 2 }] })}>
                Add a task
              </Button>
              <Button type="button" variant="secondary" size="sm" disabled={r.actions.length >= catalogue.limits.actions} onClick={() => onChange({ ...r, actions: [...r.actions, { type: 'SEND_EMAIL', to: t.emailsContact ? { contact: true } : { role: 'OWNER' }, subject: '', body: '' }] })}>
                Add an email
              </Button>
              <Button type="button" variant="secondary" size="sm" disabled={r.actions.length >= catalogue.limits.actions} onClick={() => onChange({ ...r, actions: [...r.actions, { type: 'WEBHOOK', url: '' }] })}>
                Add a webhook
              </Button>
            </div>
          </div>
        </div>
      </fieldset>
    </Card>
  );
}

/** A test: which rule, a label, values for the facts its conditions look at, and whether it should act. */
function TestRow({ index, t, rules, catalogue, onChange, onRemove }: { index: number; t: PolicyTest; rules: PolicyRule[]; catalogue: PolicyCatalogue; onChange: (t: PolicyTest) => void; onRemove: () => void }) {
  const rule = rules[t.rule - 1];
  const trig: TriggerDef | undefined = rule ? catalogue.triggers.find((x) => x.key === rule.trigger) : undefined;
  const keys = [...new Set([...(rule?.conditions.map((c) => c.fact) ?? []), ...Object.keys(t.facts)])];
  const facts = trig ? keys.map((k) => trig.facts.find((f) => f.key === k)).filter((f) => !!f) : [];
  const n = `Test ${index + 1}`;
  return (
    <fieldset className="grid gap-3 rounded-[var(--t2t-radius-md)] border border-line p-3" aria-label={n}>
      <div className="grid gap-3 md:grid-cols-[1fr_2fr_1fr_auto]">
        <Select aria-label={`${n} rule`} value={String(t.rule)} onChange={(e) => onChange({ ...t, rule: Number(e.target.value), facts: {} })}>
          {rules.map((r, i) => <option key={i} value={i + 1}>Rule {i + 1}{r.name ? `: ${r.name}` : ''}</option>)}
        </Select>
        <Input aria-label={`${n} label`} value={t.label} maxLength={200} onChange={(e) => onChange({ ...t, label: e.target.value })} placeholder="A ₹6 lakh bill needs review" />
        <Select aria-label={`${n} expected`} value={t.expect} onChange={(e) => onChange({ ...t, expect: e.target.value as PolicyTest['expect'] })}>
          <option value="ACTS">The rule acts</option>
          <option value="DOES_NOT_ACT">The rule does not act</option>
        </Select>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>
      {facts.length ? (
        <div className="grid gap-3 md:grid-cols-3">
          {facts.map((f) =>
            f.type === 'enum' ? (
              <Field key={f.key} label={`${n} ${f.label.toLowerCase()}`}>
                {(p) => (
                  <Select {...p} value={t.facts[f.key] ?? ''} onChange={(e) => onChange({ ...t, facts: { ...t.facts, [f.key]: e.target.value } })}>
                    <option value="">(empty)</option>
                    {f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                )}
              </Field>
            ) : (
              <Field key={f.key} label={`${n} ${f.label.toLowerCase()}`}>
                {(p) => <Input {...p} type={f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'money' ? 'decimal' : undefined} placeholder={f.type === 'money' ? '500000.00' : ''} value={t.facts[f.key] ?? ''} onChange={(e) => onChange({ ...t, facts: { ...t.facts, [f.key]: e.target.value } })} />}
              </Field>
            ),
          )}
        </div>
      ) : (
        <p className="text-xs text-fg-muted">This rule has no conditions, so it acts on every event.</p>
      )}
    </fieldset>
  );
}
