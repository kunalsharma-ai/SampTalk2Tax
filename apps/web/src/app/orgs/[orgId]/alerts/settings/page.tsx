'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Field, Input, Select } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { AREAS, dateTime, type AlertRule, type NotificationSetting } from '@/lib/alerts';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

const UNIT: Record<AlertRule['params'][number]['unit'], string> = { days: 'days', percent: '%', amount: '', times: '×', months: 'months' };

export default function AlertSettingsPage() {
  const { org, orgId } = useOrg();
  const q = useQuery({ queryKey: ['alert-rules', orgId], queryFn: () => api<AlertRule[]>(`/v1/orgs/${orgId}/alert-rules`) });
  if (!org) return null;
  const canManage = can(org.role, 'alerts.manage');
  return (
    <>
      <PageHeader
        title="Check settings"
        description="Choose which alerts become tasks, then turn each check on or off and set when it raises an alert. Changes apply from the next run of the checks. Turning a check off clears its open alerts; turning it back on brings back whatever it still finds."
        actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/alerts`}>Back to alerts</Link>}
      />
      <Notifications canManage={canManage} />
      <ErrorAlert title="Could not load the checks" error={q.error} />
      {q.data
        ? AREAS.map((a) => {
            const rules = q.data.filter((r) => r.area === a.key);
            return rules.length ? (
              <section key={a.key} className="mb-6" aria-label={a.label}>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">{a.label}</h2>
                <div className="grid gap-3 lg:grid-cols-2">
                  {rules.map((r) => <RuleCard key={r.key} rule={r} canManage={canManage} currency={org.functionalCurrency} />)}
                </div>
              </section>
            ) : null;
          })
        : null}
    </>
  );
}

function RuleCard({ rule, canManage, currency }: { rule: AlertRule; canManage: boolean; currency: string }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(rule.enabled);
  const [values, setValues] = useState(rule.values);
  const save = useMutation({
    mutationFn: () => api<AlertRule>(`/v1/orgs/${orgId}/alert-rules/${rule.key}`, { method: 'PUT', body: { enabled, params: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()])) } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['alert-rules', orgId] }),
  });
  const issue = (p: AlertRule['params'][number]) => {
    const v = (values[p.key] ?? '').trim();
    if (!/^\d{1,13}(\.\d{1,4})?$/.test(v)) return 'Enter a number';
    if (p.integer && v.includes('.')) return 'Whole number';
    if (Number(v) < Number(p.min) || Number(v) > Number(p.max)) return `From ${p.min} to ${p.max}`;
    return undefined;
  };
  const invalid = rule.params.some((p) => issue(p));
  const changed = enabled !== rule.enabled || rule.params.some((p) => (values[p.key] ?? '').trim() !== rule.values[p.key]);
  return (
    <Card className="flex flex-col gap-3 p-4" aria-label={rule.name}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{rule.name}</h3>
          <p className="mt-0.5 text-xs text-fg-muted">{rule.description}</p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-[var(--t2t-accent)]" checked={enabled} disabled={!canManage} onChange={(e) => setEnabled(e.target.checked)} />
          On
        </label>
      </div>
      {rule.params.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {rule.params.map((p) => (
            <Field key={p.key} label={`${p.label}${p.unit === 'amount' ? ` (${currency})` : UNIT[p.unit] ? ` (${UNIT[p.unit]})` : ''}`} error={issue(p)} hint={`Default ${p.default}`}>
              {(fp) => <Input {...fp} className="num" inputMode="decimal" disabled={!canManage || !enabled} value={values[p.key] ?? ''} onChange={(e) => setValues({ ...values, [p.key]: e.target.value })} />}
            </Field>
          ))}
        </div>
      ) : (
        <p className="text-xs text-fg-faint">No thresholds: targets are set on the KPI page.</p>
      )}
      <ErrorAlert title="Not saved" error={save.error} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-fg-faint">
          {!rule.enabled ? <Badge className="mr-2">Off</Badge> : null}
          {rule.updatedAt ? `Changed ${dateTime(rule.updatedAt)}${rule.updatedBy ? ` by ${rule.updatedBy}` : ''}` : 'Default settings'}
        </span>
        {canManage ? (
          <Button size="sm" variant="secondary" disabled={!changed || invalid} loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

const ROLE_LABEL: Record<NotificationSetting['taskRole'], string> = { OWNER: 'Owners', ADMIN: 'Admins', ACCOUNTANT: 'Accountants', APPROVER: 'Approvers' };

/** Which new alerts become a task in the work queue, for whom, and how soon. */
function Notifications({ canManage }: { canManage: boolean }) {
  const { orgId } = useOrg();
  const q = useQuery({ queryKey: ['alert-notifications', orgId], queryFn: () => api<NotificationSetting>(`/v1/orgs/${orgId}/alerts/notifications`) });
  return (
    <section className="mb-6" aria-label="Tasks from alerts">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">Tasks from alerts</h2>
      <ErrorAlert title="Could not load the setting" error={q.error} />
      {q.data ? <NotificationsForm s={q.data} canManage={canManage} /> : null}
    </section>
  );
}

function NotificationsForm({ s, canManage }: { s: NotificationSetting; canManage: boolean }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const [minSeverity, setMin] = useState(s.minSeverity);
  const [taskRole, setRole] = useState(s.taskRole);
  const [dueDays, setDue] = useState(String(s.dueDays));
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => api<NotificationSetting>(`/v1/orgs/${orgId}/alerts/notifications`, { method: 'PUT', body: { minSeverity, taskRole, dueDays: Number(dueDays) } }),
    onSuccess: (n) => {
      setSaved(true);
      qc.setQueryData(['alert-notifications', orgId], n);
    },
  });
  const dueIssue = !/^\d{1,2}$/.test(dueDays.trim()) || Number(dueDays) > 30 ? 'A whole number from 0 to 30' : undefined;
  const changed = minSeverity !== s.minSeverity || taskRole !== s.taskRole || Number(dueDays) !== s.dueDays;
  const off = minSeverity === 'OFF';
  return (
    <Card className="flex flex-col gap-3 p-4" aria-label="Task setting">
      <p className="text-xs text-fg-muted">
        When the checks find a new alert, or one comes back, it can become a task in the work queue for a role. The task links to the alert and closes itself when the alert is cleared (done) or dismissed
        (cancelled). The checks also run in the background, so this happens without anyone opening the alerts page.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Make a task for">
          {(p) => (
            <Select {...p} value={minSeverity} disabled={!canManage} onChange={(e) => (setSaved(false), setMin(e.target.value as NotificationSetting['minSeverity']))}>
              <option value="CRITICAL">Critical alerts</option>
              <option value="WARNING">Critical alerts and warnings</option>
              <option value="OFF">No alerts (off)</option>
            </Select>
          )}
        </Field>
        <Field label="Give it to">
          {(p) => (
            <Select {...p} value={taskRole} disabled={!canManage || off} onChange={(e) => (setSaved(false), setRole(e.target.value as NotificationSetting['taskRole']))}>
              {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Due after (days)" error={dueIssue} hint="0 = the day it is found">
          {(p) => <Input {...p} className="num" inputMode="numeric" disabled={!canManage || off} value={dueDays} onChange={(e) => (setSaved(false), setDue(e.target.value))} />}
        </Field>
      </div>
      <ErrorAlert title="Not saved" error={save.error} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-fg-faint">
          {s.isDefault ? 'Default setting' : `Changed ${s.updatedAt ? dateTime(s.updatedAt) : ''}${s.updatedBy ? ` by ${s.updatedBy}` : ''}`}
          {saved ? <span role="status" className="ml-2 text-positive">Saved</span> : null}
        </span>
        {canManage ? (
          <Button size="sm" variant="secondary" disabled={!changed || !!dueIssue} loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
