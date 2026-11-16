'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, CardHeader, Field, Input, Select } from '@talk2tax/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { ImpactResults } from '@/components/impact/impact-results';
import { api, ApiError } from '@/lib/api';
import { AREA_LABEL, newChange, type AssessmentDetail, type AssessResponse, type Change, type Lever, type Options } from '@/lib/impact';
import { money } from '@/lib/format';
import { monthLabel, shiftYm } from '@/lib/twin';

type Init = { name: string; description: string; baselineMonths: 3 | 6 | 12; horizonMonths: number; changes: Change[] };

/**
 * Builds a business impact assessment from sales, HR, procurement and operations changes, runs
 * it against the posted books and, for people who manage scenarios, saves it. Changes pick
 * customers and suppliers from the books.
 */
export function ImpactBuilder({ orgId, assessmentId, init, canManage, initialResult, startLever }: { orgId: string; assessmentId?: string; init: Init; canManage: boolean; initialResult?: AssessResponse | null; startLever?: Lever | null }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [name, setName] = useState(init.name);
  const [description, setDescription] = useState(init.description);
  const [baselineMonths, setBaselineMonths] = useState(init.baselineMonths);
  const [horizonMonths, setHorizonMonths] = useState(init.horizonMonths);
  const [changes, setChanges] = useState<Change[]>(init.changes);
  const [started, setStarted] = useState(!startLever);
  const [result, setResult] = useState<AssessResponse | null>(initialResult ?? null);
  const [saved, setSaved] = useState(false);
  const opts = useQuery({ queryKey: ['impact-options', orgId, baselineMonths, horizonMonths], queryFn: () => api<Options>(`/v1/orgs/${orgId}/impact/options?baselineMonths=${baselineMonths}&horizonMonths=${horizonMonths}`) });
  const o = opts.data;
  if (o && !started && startLever) {
    setStarted(true);
    setChanges([newChange(startLever, o)]);
  }
  const body = () => ({ baselineMonths, horizonMonths, changes });
  const run = useMutation({ mutationFn: () => api<AssessResponse>(`/v1/orgs/${orgId}/impact/assess`, { method: 'POST', body: body() }), onSuccess: setResult });
  const save = useMutation({
    mutationFn: () =>
      assessmentId
        ? api<AssessmentDetail>(`/v1/orgs/${orgId}/impact/assessments/${assessmentId}`, { method: 'PUT', body: { ...body(), name: name.trim(), description: description.trim() || null } })
        : api<AssessmentDetail>(`/v1/orgs/${orgId}/impact/assessments`, { method: 'POST', body: { ...body(), name: name.trim(), description: description.trim() || null } }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['impact-assessments', orgId] });
      void qc.invalidateQueries({ queryKey: ['impact-assessment', orgId, s.id] });
      setSaved(true);
      if (s.result) setResult({ ...s.result, currency: s.currency, actual: s.actual });
      if (!assessmentId) router.push(`/orgs/${orgId}/planning/impact/${s.id}`);
    },
  });
  const dirty = () => (setSaved(false), setResult(null));
  const change = (i: number, patch: Partial<Change>) => (setChanges((xs) => xs.map((x, k) => (k === i ? ({ ...x, ...patch } as Change) : x))), dirty());
  const first = o?.firstMonth ?? '';
  const monthOptions = Array.from({ length: horizonMonths }, (_, k) => k + 1);
  const err = run.error ?? save.error;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="The assessment" description="Played forward from the posted books with the digital twin. Nothing is posted, paid or sent." />
        <div className="grid gap-3 px-5 pb-5 md:grid-cols-2">
          {canManage ? (
            <>
              <Field label="Name">{(p) => <Input {...p} value={name} maxLength={120} onChange={(e) => (setName(e.target.value), setSaved(false))} />}</Field>
              <Field label="Description">{(p) => <Input {...p} value={description} maxLength={1000} onChange={(e) => (setDescription(e.target.value), setSaved(false))} />}</Field>
            </>
          ) : null}
          <Field label="Baseline" hint={o ? `Cost of sales is ${o.costOfSalesPercent}% of revenue in these months; new revenue carries the same share.` : undefined}>
            {(p) => (
              <Select {...p} value={baselineMonths} onChange={(e) => (setBaselineMonths(Number(e.target.value) as 3 | 6 | 12), dirty())}>
                <option value={3}>Last 3 months</option>
                <option value={6}>Last 6 months</option>
                <option value={12}>Last 12 months</option>
              </Select>
            )}
          </Field>
          <Field label="Horizon">
            {(p) => (
              <Select {...p} value={horizonMonths} onChange={(e) => (setHorizonMonths(Number(e.target.value)), dirty())}>
                {[6, 12, 18, 24, 36].map((h) => <option key={h} value={h}>{h} months</option>)}
              </Select>
            )}
          </Field>
        </div>
      </Card>

      {changes.map((c, i) => {
        const info = o?.levers.find((k) => k.key === c.lever);
        const legend = `Change ${i + 1}: ${info?.label ?? c.lever}`;
        return (
          <Card key={i}>
            <fieldset aria-label={legend}>
              <CardHeader title={<span>{legend} {info ? <span className="ml-1 text-xs font-normal text-fg-muted">{AREA_LABEL[info.area]}</span> : null}</span>} description={info?.description} actions={<Button variant="ghost" onClick={() => (setChanges((xs) => xs.filter((_, k) => k !== i)), dirty())}>Remove</Button>} />
              <div className="grid gap-3 px-5 pb-5 md:grid-cols-3">
                <Field label="Starts in">
                  {(p) => (
                    <Select {...p} value={c.month ?? 1} onChange={(e) => change(i, { month: Number(e.target.value) })}>
                      {monthOptions.map((m) => <option key={m} value={m}>{first ? monthLabel(shiftYm(first, m - 1)) : `Month ${m}`}</option>)}
                    </Select>
                  )}
                </Field>
                <LeverFields c={c} o={o} currency={o?.currency ?? ''} onChange={(patch) => change(i, patch)} />
              </div>
            </fieldset>
          </Card>
        );
      })}

      <Card>
        <CardHeader title="Add a change" description="Pick what the business would do. Starting figures are sized to your books; change them to your own." />
        <div className="grid gap-4 px-5 pb-5 md:grid-cols-2 xl:grid-cols-4">
          {(o?.areas ?? []).map((a) => (
            <div key={a.key} role="group" aria-label={a.label}>
              <p className="mb-2 text-sm font-medium">{a.label}</p>
              <div className="flex flex-col items-start gap-1">
                {o!.levers.filter((l) => l.area === a.key).map((l) => (
                  <Button
                    key={l.key}
                    variant="secondary"
                    disabled={changes.length >= 15 || (l.key === 'LOSE_CUSTOMER' && !o!.customers.length)}
                    onClick={() => (setChanges((xs) => [...xs, newChange(l.key, o!)]), dirty())}
                  >
                    {l.label}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {err ? <ErrorAlert title={err instanceof ApiError && err.issues.length === 1 ? err.issues[0]! : 'Could not run the assessment'} error={err} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => run.mutate()} loading={run.isPending} disabled={!changes.length}>Assess the impact</Button>
        {canManage ? <Button variant="secondary" onClick={() => save.mutate()} loading={save.isPending} disabled={!changes.length || !name.trim()}>{assessmentId ? 'Save changes' : 'Save assessment'}</Button> : null}
        {saved ? <span className="self-center text-sm text-positive">Saved.</span> : null}
      </div>
      {!changes.length ? <Alert tone="neutral" title="No changes yet">Add a change above, then assess the impact.</Alert> : null}
      {result ? <ImpactResults r={result} actual={result.actual} currency={result.currency} /> : null}
    </div>
  );
}

function LeverFields({ c, o, currency, onChange }: { c: Change; o: Options | undefined; currency: string; onChange: (patch: Partial<Change>) => void }) {
  const v = (key: string) => (c as Record<string, unknown>)[key];
  const num = (label: string, key: string, hint?: string) => (
    <Field label={label} hint={hint}>{(p) => <Input {...p} inputMode="decimal" value={String(v(key) ?? '')} onChange={(e) => onChange({ [key]: e.target.value } as Partial<Change>)} />}</Field>
  );
  const int = (label: string, key: string, hint?: string) => (
    <Field label={label} hint={hint}>{(p) => <Input {...p} type="number" value={String(v(key) ?? 0)} onChange={(e) => onChange({ [key]: Number(e.target.value) } as Partial<Change>)} />}</Field>
  );
  const text = (label: string, key: string) => (
    <Field label={label}>{(p) => <Input {...p} value={String(v(key) ?? '')} maxLength={80} onChange={(e) => onChange({ [key]: e.target.value } as Partial<Change>)} />}</Field>
  );
  const m = o?.monthly;
  switch (c.lever) {
    case 'NEW_CUSTOMER':
      return (
        <>
          {text('Customer or contract', 'label')}
          {num('Monthly sales at full speed', 'monthlyRevenue', m ? `Revenue today: ${money(m.revenue, currency)} a month` : undefined)}
          {int('Months to reach full speed', 'rampMonths')}
        </>
      );
    case 'LOSE_CUSTOMER': {
      const k = o?.customers.find((x) => x.contactId === c.contactId);
      return (
        <Field label="Customer" hint={k ? `Buys ${money(k.monthlyRevenue, currency)} a month` : undefined}>
          {(p) => (
            <Select {...p} value={c.contactId} onChange={(e) => onChange({ contactId: e.target.value })}>
              {(o?.customers ?? []).map((x) => <option key={x.contactId} value={x.contactId}>{x.name}</option>)}
            </Select>
          )}
        </Field>
      );
    }
    case 'PRICE_CHANGE':
      return (
        <>
          {num('Price change (%)', 'pricePercent')}
          {num('Change in sales volume (%)', 'volumePercent', 'How many more or fewer units you expect to sell')}
        </>
      );
    case 'SALES_HIRES':
      return (
        <>
          {int('Salespeople added', 'count')}
          {num('Monthly cost per person', 'monthlyCostPerHead')}
          {num('One-off cost per person', 'oneOffCostPerHead', 'Recruitment, laptop, training')}
          {num('Monthly sales per person at full speed', 'monthlyRevenuePerHead')}
          {int('Months to reach full speed', 'rampMonths')}
        </>
      );
    case 'CUSTOMER_TERMS':
      return int('Days customers take to pay: change', 'collectionDaysChange', 'Positive gives customers longer; negative collects sooner');
    case 'HIRE':
      return (
        <>
          {int('People hired', 'count')}
          {num('Monthly cost per person', 'monthlyCostPerHead', 'Salary plus employer contributions')}
          {num('One-off cost per person', 'oneOffCostPerHead')}
        </>
      );
    case 'PAY_RISE':
      return num('Pay change (%)', 'percent', m ? `Payroll today: ${money(m.payroll, currency)} a month` : undefined);
    case 'HEADCOUNT_REDUCTION':
      return (
        <>
          {int('People leaving', 'count')}
          {num('Monthly cost per person', 'monthlyCostPerHead', m ? `Payroll today: ${money(m.payroll, currency)} a month` : undefined)}
          {num('Severance per person', 'severancePerHead')}
        </>
      );
    case 'SUPPLIER_PRICE': {
      const s = o?.suppliers.find((x) => x.contactId === c.contactId);
      return (
        <>
          <Field label="Supplier" hint={s ? `Bills ${money(s.monthlySpend, currency)} a month` : m ? `Cost of sales today: ${money(m.costOfSales, currency)} a month` : undefined}>
            {(p) => (
              <Select {...p} value={c.contactId ?? ''} onChange={(e) => onChange({ contactId: e.target.value || null })}>
                <option value="">All suppliers</option>
                {(o?.suppliers ?? []).map((x) => <option key={x.contactId} value={x.contactId}>{x.name}</option>)}
              </Select>
            )}
          </Field>
          {num('Price change (%)', 'percent')}
        </>
      );
    }
    case 'SUPPLIER_TERMS':
      return int('Days you take to pay suppliers: change', 'paymentDaysChange', 'Positive pays later; negative pays sooner');
    case 'NEW_SITE':
      return (
        <>
          {text('Site, branch or line', 'label')}
          {num('Set-up cost', 'oneOffCost')}
          {num('Monthly running cost', 'monthlyCost', 'Rent, staff and utilities for the site')}
          {num('Monthly sales at full speed', 'monthlyRevenue')}
          {int('Months to reach full speed', 'rampMonths')}
        </>
      );
    case 'EQUIPMENT':
      return (
        <>
          {text('Equipment', 'label')}
          {num('Cost', 'cost')}
          {int('Useful life in months', 'usefulLifeMonths')}
          {num('Running costs saved a month', 'monthlySaving')}
        </>
      );
    case 'RUNNING_COSTS':
      return (
        <>
          {num('Change (%)', 'percent', m ? `Running costs today: ${money(m.otherOperating, currency)} a month` : undefined)}
          {num('Change a month (negative saves)', 'monthlyAmount')}
        </>
      );
  }
}
