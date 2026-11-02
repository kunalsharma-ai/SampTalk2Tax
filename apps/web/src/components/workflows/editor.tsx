'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card, CardHeader, Field, Input, Select, Textarea } from '@talk2tax/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { api } from '@/lib/api';
import type { Action, Catalogue, Condition, EmailTo, FactDef, TriggerDef, TriggerParams, Workflow } from '@/lib/workflows';

/** A condition being edited: the value is kept as typed until saving. */
interface Draft {
  name: string;
  description: string;
  trigger: string;
  triggerParams: TriggerParams;
  conditions: Condition[];
  actions: Action[];
  note: string;
}

/** Settings a schedule trigger starts with. */
const defaultParams = (trigger: string): TriggerParams =>
  trigger === 'SCHEDULE' ? { frequency: 'WEEKLY', time: '09:00', weekday: 1 } : trigger === 'INVOICE_OVERDUE' ? { days: 7 } : trigger === 'BILL_DUE_SOON' ? { days: 3 } : {};

const defaultValue = (f: FactDef): Condition['value'] => (f.type === 'enum' ? [] : '');
const blankCondition = (t: TriggerDef): Condition => {
  const f = t.facts.find((x) => x.type === 'money') ?? t.facts[0];
  return { fact: f.key, op: f.type === 'money' ? 'gte' : f.type === 'enum' ? 'in' : f.type === 'date' ? 'before' : 'contains', value: defaultValue(f) };
};

export function WorkflowEditor({ orgId, catalogue, workflow }: { orgId: string; catalogue: Catalogue; workflow?: Workflow }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [d, setD] = useState<Draft>(() =>
    workflow
      ? { name: workflow.name, description: workflow.description ?? '', trigger: workflow.trigger, triggerParams: workflow.triggerParams ?? {}, conditions: workflow.conditions, actions: workflow.actions, note: '' }
      : { name: '', description: '', trigger: catalogue.triggers[0].key, triggerParams: {}, conditions: [], actions: [{ type: 'CREATE_TASK', title: '', assignTo: { role: 'ACCOUNTANT' }, dueInDays: 3 }], note: '' },
  );
  const t = catalogue.triggers.find((x) => x.key === d.trigger)!;
  const set = (patch: Partial<Draft>) => setD((p) => ({ ...p, ...patch }));
  const setCondition = (i: number, c: Condition) => set({ conditions: d.conditions.map((x, j) => (j === i ? c : x)) });
  const setAction = (i: number, a: Action) => set({ actions: d.actions.map((x, j) => (j === i ? a : x)) });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: d.name,
        description: d.description || null,
        trigger: d.trigger,
        triggerParams: d.triggerParams,
        conditions: d.conditions.map((c) => (c.op === 'is_empty' || c.op === 'not_empty' ? { fact: c.fact, op: c.op } : c)),
        actions: d.actions.map((a) => (a.type === 'CREATE_TASK' ? { ...a, description: a.description || undefined } : a)),
      };
      return workflow
        ? api<Workflow>(`/v1/orgs/${orgId}/workflows/${workflow.id}`, { method: 'PUT', body: { ...body, baseVersion: workflow.version, note: d.note || null } })
        : api<Workflow>(`/v1/orgs/${orgId}/workflows`, { method: 'POST', body });
    },
    onSuccess: (w) => {
      void qc.invalidateQueries({ queryKey: ['workflows', orgId] });
      qc.setQueryData(['workflow', orgId, w.id], w);
      router.push(`/orgs/${orgId}/automations/${w.id}`);
    },
  });

  const placeholders = t.facts.map((f) => `{{${f.key}}}`).join(' ');
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Card>
        <CardHeader title="Name" />
        <div className="grid gap-4 p-5 md:grid-cols-2">
          <Field label="Workflow name">{(p) => <Input {...p} value={d.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} placeholder="Check large invoices" />}</Field>
          <Field label="Description (optional)">{(p) => <Input {...p} value={d.description} maxLength={1000} onChange={(e) => set({ description: e.target.value })} />}</Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="1. When" description="What starts this workflow: something recorded in the books, a schedule, or a date an invoice or bill reaches." />
        <div className="flex flex-col gap-4 p-5">
          <Field label="Trigger" hint={t.description}>
            {(p) => (
              <Select
                {...p}
                value={d.trigger}
                onChange={(e) => {
                  // Conditions and placeholders refer to the trigger's facts, so they start again.
                  const next = catalogue.triggers.find((x) => x.key === e.target.value)!;
                  // An email to the customer or vendor needs a trigger that has one.
                  const actions = d.actions.map((a): Action => (a.type === 'SEND_EMAIL' && 'contact' in a.to && !next.emailsContact ? { ...a, to: { role: 'OWNER' } } : a));
                  set({ trigger: next.key, triggerParams: defaultParams(next.key), conditions: [], actions });
                }}
              >
                <optgroup label="When something is recorded">
                  {catalogue.triggers.filter((x) => x.kind === 'event').map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="On a schedule or a date">
                  {catalogue.triggers.filter((x) => x.kind === 'schedule').map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.label}
                    </option>
                  ))}
                </optgroup>
              </Select>
            )}
          </Field>
          <TriggerSettings trigger={d.trigger} params={d.triggerParams} catalogue={catalogue} onChange={(triggerParams) => set({ triggerParams })} />
        </div>
      </Card>

      <Card>
        <CardHeader title="2. Only if" description="Every condition must hold. With no conditions, the workflow acts every time." />
        <div className="flex flex-col gap-3 p-5">
          {d.conditions.map((c, i) => (
            <ConditionRow key={i} index={i} c={c} t={t} catalogue={catalogue} onChange={(x) => setCondition(i, x)} onRemove={() => set({ conditions: d.conditions.filter((_, j) => j !== i) })} />
          ))}
          <div>
            <Button type="button" variant="secondary" size="sm" disabled={d.conditions.length >= catalogue.limits.conditions} onClick={() => set({ conditions: [...d.conditions, blankCondition(t)] })}>
              Add a condition
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="3. Do" description={`Up to ${catalogue.limits.actions} actions, in order. In tasks and emails, ${placeholders} are replaced by the values when it runs.`} />
        <div className="flex flex-col gap-3 p-5">
          {d.actions.map((a, i) => (
            <ActionCard key={i} index={i} a={a} t={t} catalogue={catalogue} onChange={(x) => setAction(i, x)} onRemove={() => set({ actions: d.actions.filter((_, j) => j !== i) })} />
          ))}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={d.actions.length >= catalogue.limits.actions} onClick={() => set({ actions: [...d.actions, { type: 'CREATE_TASK', title: '', assignTo: { role: 'ACCOUNTANT' }, dueInDays: 3 }] })}>
              Add a task
            </Button>
            <Button type="button" variant="secondary" size="sm" disabled={d.actions.length >= catalogue.limits.actions} onClick={() => set({ actions: [...d.actions, { type: 'WEBHOOK', url: '' }] })}>
              Add a webhook
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={d.actions.length >= catalogue.limits.actions}
              onClick={() => set({ actions: [...d.actions, { type: 'SEND_EMAIL', to: t.emailsContact ? { contact: true } : { role: 'OWNER' }, subject: '', body: '' }] })}
            >
              Add an email
            </Button>
          </div>
        </div>
      </Card>

      {workflow ? (
        <Card>
          <div className="p-5">
            <Field label="What changed (optional)" hint="Saved with the new version, so the run log says why it changed.">
              {(p) => <Input {...p} value={d.note} maxLength={500} onChange={(e) => set({ note: e.target.value })} />}
            </Field>
          </div>
        </Card>
      ) : null}

      <ErrorAlert title="The workflow was not saved" error={save.error} />
      <div className="flex items-center gap-3">
        <Button type="submit" loading={save.isPending}>
          {workflow ? 'Save changes' : 'Create workflow'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.push(workflow ? `/orgs/${orgId}/automations/${workflow.id}` : `/orgs/${orgId}/automations`)}>
          Cancel
        </Button>
        {!workflow ? <p className="text-sm text-fg-muted">A new workflow starts off. Test it, then turn it on.</p> : null}
      </div>
    </form>
  );
}

function ConditionRow({ index, c, t, catalogue, onChange, onRemove }: { index: number; c: Condition; t: TriggerDef; catalogue: Catalogue; onChange: (c: Condition) => void; onRemove: () => void }) {
  const f = t.facts.find((x) => x.key === c.fact) ?? t.facts[0];
  const ops = catalogue.operators[f.type];
  const n = `Condition ${index + 1}`;
  return (
    <fieldset className="grid items-start gap-2 rounded-[var(--t2t-radius-md)] border border-line p-3 md:grid-cols-[1fr_1fr_1.4fr_auto]" aria-label={n}>
      <Select aria-label={`${n} fact`} value={f.key} onChange={(e) => {
          const nf = t.facts.find((x) => x.key === e.target.value)!;
          onChange({ fact: nf.key, op: catalogue.operators[nf.type][0].op, value: defaultValue(nf) });
        }}>
        {t.facts.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
      </Select>
      <Select aria-label={`${n} test`} value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value })}>
        {ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
      </Select>
      {c.op === 'is_empty' || c.op === 'not_empty' ? (
        <span />
      ) : f.type === 'enum' ? (
        <div className="flex flex-wrap gap-3 py-1.5" role="group" aria-label={`${n} values`}>
          {f.options!.map((o) => {
            const list = Array.isArray(c.value) ? c.value : [];
            return (
              <label key={o.value} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={list.includes(o.value)} onChange={(e) => onChange({ ...c, value: e.target.checked ? [...list, o.value] : list.filter((v) => v !== o.value) })} />
                {o.label}
              </label>
            );
          })}
        </div>
      ) : (
        <Input aria-label={`${n} value`} type={f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'money' ? 'decimal' : undefined} placeholder={f.type === 'money' ? '100000.00' : ''} value={typeof c.value === 'string' ? c.value : ''} onChange={(e) => onChange({ ...c, value: e.target.value })} />
      )}
      <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
        Remove
      </Button>
    </fieldset>
  );
}

function TriggerSettings({ trigger, params, catalogue, onChange }: { trigger: string; params: TriggerParams; catalogue: Catalogue; onChange: (p: TriggerParams) => void }) {
  if (trigger === 'SCHEDULE') {
    return (
      <div className="grid gap-3 md:grid-cols-3" role="group" aria-label="Schedule">
        <Field label="Repeats">
          {(p) => (
            <Select
              {...p}
              value={params.frequency ?? 'WEEKLY'}
              onChange={(e) => {
                const frequency = e.target.value as TriggerParams['frequency'];
                onChange({ frequency, time: params.time ?? '09:00', ...(frequency === 'WEEKLY' ? { weekday: params.weekday ?? 1 } : {}), ...(frequency === 'MONTHLY' ? { dayOfMonth: params.dayOfMonth ?? 1 } : {}) });
              }}
            >
              <option value="DAILY">Every day</option>
              <option value="WEEKLY">Every week</option>
              <option value="MONTHLY">Every month</option>
            </Select>
          )}
        </Field>
        {params.frequency === 'WEEKLY' ? (
          <Field label="On">
            {(p) => (
              <Select {...p} value={String(params.weekday ?? 1)} onChange={(e) => onChange({ ...params, weekday: Number(e.target.value) })}>
                {catalogue.schedule.weekdays.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : params.frequency === 'MONTHLY' ? (
          <Field label="Day of the month" hint="1 to 28, so it comes round every month.">
            {(p) => <Input {...p} type="number" min={1} max={28} value={params.dayOfMonth === undefined ? '' : String(params.dayOfMonth)} onChange={(e) => onChange({ ...params, dayOfMonth: e.target.value === '' ? undefined : Number(e.target.value) })} />}
          </Field>
        ) : (
          <span />
        )}
        <Field label="At (India time)">{(p) => <Input {...p} type="time" value={params.time ?? ''} onChange={(e) => onChange({ ...params, time: e.target.value })} />}</Field>
      </div>
    );
  }
  if (trigger === 'INVOICE_OVERDUE' || trigger === 'BILL_DUE_SOON') {
    const overdue = trigger === 'INVOICE_OVERDUE';
    return (
      <div className="max-w-xs">
        <Field
          label={overdue ? 'Days after the due date' : 'Days before the due date'}
          hint={overdue ? 'Acts once per invoice, on the day it is this many days overdue and still not fully paid.' : 'Acts once per bill, on the day it is this many days from due and still not fully paid. 0 means on the due date.'}
        >
          {(p) => <Input {...p} type="number" min={overdue ? 1 : 0} max={overdue ? 365 : 90} value={params.days === undefined ? '' : String(params.days)} onChange={(e) => onChange({ days: e.target.value === '' ? undefined : Number(e.target.value) })} />}
        </Field>
      </div>
    );
  }
  return null;
}

function ActionCard({ index, a, t, catalogue, onChange, onRemove }: { index: number; a: Action; t: TriggerDef; catalogue: Catalogue; onChange: (a: Action) => void; onRemove: () => void }) {
  const n = `Action ${index + 1}`;
  return (
    <fieldset className="rounded-[var(--t2t-radius-md)] border border-line p-4" aria-label={n}>
      <div className="mb-3 flex items-center justify-between">
        <legend className="text-sm font-medium">
          {n}: {a.type === 'CREATE_TASK' ? 'Create a task' : a.type === 'SEND_EMAIL' ? 'Send an email' : 'Send a webhook'}
        </legend>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>
      {a.type === 'CREATE_TASK' ? (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="md:col-span-2">
            <Field label="Task title">{(p) => <Input {...p} value={a.title} maxLength={200} onChange={(e) => onChange({ ...a, title: e.target.value })} placeholder="Check {{number}} for {{contactName}}" />}</Field>
          </div>
          <div className="md:col-span-2">
            <Field label="Details (optional)">{(p) => <Textarea {...p} rows={2} value={a.description ?? ''} maxLength={2000} onChange={(e) => onChange({ ...a, description: e.target.value })} />}</Field>
          </div>
          <Field label="For">
            {(p) => (
              <Select {...p} value={'role' in a.assignTo ? `role:${a.assignTo.role}` : `user:${a.assignTo.userId}`} onChange={(e) => {
                  const [kind, v] = e.target.value.split(':');
                  onChange({ ...a, assignTo: kind === 'role' ? { role: v } : { userId: v } });
                }}>
                <optgroup label="Everyone with a role">
                  {catalogue.roles.map((r) => <option key={r.role} value={`role:${r.role}`}>{r.label}</option>)}
                </optgroup>
                <optgroup label="One person">
                  {catalogue.members.map((m) => <option key={m.userId} value={`user:${m.userId}`}>{m.name}</option>)}
                </optgroup>
              </Select>
            )}
          </Field>
          <Field label="Due" hint="Days after the event, in India time. Empty for no due date.">
            {(p) => <Input {...p} type="number" min={0} max={365} value={a.dueInDays === null ? '' : String(a.dueInDays)} onChange={(e) => onChange({ ...a, dueInDays: e.target.value === '' ? null : Number(e.target.value) })} />}
          </Field>
        </div>
      ) : a.type === 'SEND_EMAIL' ? (
        <EmailFields a={a} t={t} catalogue={catalogue} onChange={onChange} />
      ) : (
        <Field label="Address" hint={`A POST with JSON, signed with the workflow's secret. Failed deliveries are tried ${catalogue.limits.webhookAttempts} times in all.${catalogue.webhooksMustBeHttps ? ' Must be a public https:// address.' : ''}`}>
          {(p) => <Input {...p} value={a.url} maxLength={500} onChange={(e) => onChange({ ...a, url: e.target.value })} placeholder="https://hooks.example.com/talk2tax" />}
        </Field>
      )}
    </fieldset>
  );
}

function EmailFields({ a, t, catalogue, onChange }: { a: Extract<Action, { type: 'SEND_EMAIL' }>; t: TriggerDef; catalogue: Catalogue; onChange: (a: Action) => void }) {
  const contactWord = t.facts.find((f) => f.key === 'contactName')?.label ?? 'Customer or vendor';
  const value = 'contact' in a.to ? 'contact' : 'role' in a.to ? `role:${a.to.role}` : `user:${a.to.userId}`;
  return (
    <div className="grid gap-3">
      {!catalogue.email.ready ? (
        <p className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning" role="note">
          Email is not set up on this server yet, so these emails will fail until an administrator sets SMTP_URL and EMAIL_FROM. You can still save and test the workflow.
        </p>
      ) : null}
      <Field label="To" hint={'contact' in a.to ? `The email address on the ${contactWord.toLowerCase()}'s contact. If it has none, this action fails and says so.` : 'Members get a link to the record at the end of the email.'}>
        {(p) => (
          <Select
            {...p}
            value={value}
            onChange={(e) => {
              const [kind, v] = e.target.value.split(':');
              const to: EmailTo = kind === 'contact' ? { contact: true } : kind === 'role' ? { role: v } : { userId: v };
              onChange({ ...a, to });
            }}
          >
            {t.emailsContact ? <option value="contact">The {contactWord.toLowerCase()} (their contact email)</option> : null}
            <optgroup label="Everyone with a role">
              {catalogue.roles.map((r) => (
                <option key={r.role} value={`role:${r.role}`}>
                  {r.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="One person">
              {catalogue.members.map((m) => (
                <option key={m.userId} value={`user:${m.userId}`}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          </Select>
        )}
      </Field>
      <Field label="Subject">{(p) => <Input {...p} value={a.subject} maxLength={200} onChange={(e) => onChange({ ...a, subject: e.target.value })} placeholder="Invoice {{number}} is overdue" />}</Field>
      <Field label="Message" hint={`Plain text. Amounts are written like ₹1,50,000.00 and dates like 2 Nov 2026.${catalogue.email.from ? ` Sent from ${catalogue.email.from}.` : ''}`}>
        {(p) => <Textarea {...p} rows={5} value={a.body} maxLength={5000} onChange={(e) => onChange({ ...a, body: e.target.value })} placeholder={'Dear {{contactName}},\n\n{{balance}} on invoice {{number}} is still to pay.'} />}
      </Field>
    </div>
  );
}
