'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Field, Input } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { AREAS, dateTime, type AlertRule } from '@/lib/alerts';
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
        description="Turn each check on or off and set when it raises an alert. Changes apply from the next run of the checks. Turning a check off clears its open alerts; turning it back on brings back whatever it still finds."
        actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/alerts`}>Back to alerts</Link>}
      />
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
