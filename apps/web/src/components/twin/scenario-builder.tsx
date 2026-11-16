'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { api } from '@/lib/api';
import { DRIVER_ORDER, DRIVERS, monthLabel, shiftYm, type Driver, type DriverKind, type Scenario, type TwinRun } from '@/lib/twin';
import { TwinCashChart } from './twin-chart';

function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

let seq = 0;
const withId = (d: Driver): Driver => ({ ...d, id: d.id ?? `d${Date.now().toString(36)}${(seq++).toString(36)}` });

/**
 * Builds a scenario: the changes on the left are played forward against the actual figures as
 * you type (nothing saved), and saving stores only the changes. Projected figures are always
 * labelled hypothetical and drawn apart from the actual months.
 */
export function ScenarioBuilder({ orgId, initial, scenarioId, canManage }: { orgId: string; initial: Omit<Scenario, 'id' | 'createdAt' | 'updatedAt'>; scenarioId?: string; canManage: boolean }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? '');
  const [baselineMonths, setBaselineMonths] = useState<3 | 6 | 12>(initial.baselineMonths);
  const [horizonMonths, setHorizonMonths] = useState(initial.horizonMonths);
  const [drivers, setDrivers] = useState<Driver[]>(() => initial.drivers.map(withId));
  const [adding, setAdding] = useState<DriverKind>('HIRING');
  const [saved, setSaved] = useState(false);
  const body = useMemo(() => ({ baselineMonths, horizonMonths, drivers }), [baselineMonths, horizonMonths, drivers]);
  const debounced = useDebounced(body);
  const base = `/v1/orgs/${orgId}/twin`;
  const run = useQuery({ queryKey: ['twin-simulate', orgId, debounced], queryFn: () => api<TwinRun>(`${base}/simulate`, { method: 'POST', body: debounced }), placeholderData: (p) => p, retry: false });
  const baseline = useQuery({ queryKey: ['twin-baseline', orgId, baselineMonths, horizonMonths], queryFn: () => api<TwinRun>(`${base}/baseline?baselineMonths=${baselineMonths}&horizonMonths=${horizonMonths}`) });
  const save = useMutation({
    mutationFn: () => api<Scenario>(scenarioId ? `${base}/scenarios/${scenarioId}` : `${base}/scenarios`, { method: scenarioId ? 'PUT' : 'POST', body: { name, description: description || null, ...body } }),
    onSuccess: (s) => {
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ['twin-scenarios', orgId] });
      if (!scenarioId) router.push(`/orgs/${orgId}/planning/twin/${s.id}`);
    },
  });
  const update = (i: number, patch: Partial<Driver>) => {
    setSaved(false);
    setDrivers((ds) => ds.map((d, j) => (j === i ? ({ ...d, ...patch } as Driver) : d)));
  };
  const add = (kind: DriverKind) => {
    setSaved(false);
    setDrivers((ds) => [...ds, withId({ ...DRIVERS[kind].blank })]);
  };
  const r = run.data;
  const c = r?.currency ?? 'INR';
  const firstMonth = r ? shiftYm(r.baseline.toMonth, 1) : null;
  const monthName = (n: number) => (firstMonth ? monthLabel(shiftYm(firstMonth, n - 1)) : `Month ${n}`);

  return (
    <div className="space-y-4">
      <Alert tone="violet" title="Hypothetical figures">
        Scenarios play changes forward from your actual books. Nothing here is posted to the ledger, and projected figures are never mixed with actual ones.
      </Alert>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,420px)_1fr]">
        <div className="space-y-4">
          <Card className="p-4">
            <CardHeader title="Scenario" />
            <div className="grid grid-cols-1 gap-3">
              <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => (setName(e.target.value), setSaved(false))} maxLength={120} disabled={!canManage} />}</Field>
              <Field label="Description">{(p) => <Input {...p} value={description} onChange={(e) => (setDescription(e.target.value), setSaved(false))} maxLength={1000} disabled={!canManage} />}</Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Baseline">
                  {(p) => (
                    <Select {...p} value={baselineMonths} onChange={(e) => (setBaselineMonths(Number(e.target.value) as 3 | 6 | 12), setSaved(false))}>
                      <option value={3}>Last 3 months</option>
                      <option value={6}>Last 6 months</option>
                      <option value={12}>Last 12 months</option>
                    </Select>
                  )}
                </Field>
                <Field label="Horizon">
                  {(p) => (
                    <Select {...p} value={horizonMonths} onChange={(e) => (setHorizonMonths(Number(e.target.value)), setSaved(false))}>
                      {[6, 12, 18, 24, 36, 48, 60].map((h) => <option key={h} value={h}>{h} months</option>)}
                    </Select>
                  )}
                </Field>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <CardHeader title="Changes" description={drivers.length ? 'Each change applies from its month to the end of the horizon unless it says otherwise.' : 'No changes yet: the projection is your business as it is now.'} />
            <ol className="space-y-3" aria-label="Changes">
              {drivers.map((d, i) => (
                <DriverCard key={d.id} d={d} n={i + 1} horizon={horizonMonths} monthName={monthName} disabled={!canManage} onChange={(p) => update(i, p)} onRemove={() => (setDrivers((ds) => ds.filter((_, j) => j !== i)), setSaved(false))} />
              ))}
            </ol>
            {canManage || !scenarioId ? (
              <div className="mt-3 flex items-end gap-2">
                <Field label="Add a change">
                  {(p) => (
                    <Select {...p} value={adding} onChange={(e) => setAdding(e.target.value as DriverKind)}>
                      {DRIVER_ORDER.map((k) => <option key={k} value={k}>{DRIVERS[k].title}</option>)}
                    </Select>
                  )}
                </Field>
                <Button type="button" variant="secondary" onClick={() => add(adding)}>Add</Button>
              </div>
            ) : null}
          </Card>
          {canManage ? (
            <div className="flex items-center gap-3">
              <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim()}>{scenarioId ? 'Save changes' : 'Save scenario'}</Button>
              {saved ? <span role="status" className="text-sm text-positive">Saved</span> : null}
            </div>
          ) : (
            <p className="text-sm text-fg-muted">You can try changes here; saving scenarios needs the scenarios permission.</p>
          )}
          {save.error ? <ErrorAlert title="Not saved" error={save.error} /> : null}
        </div>

        <div className="min-w-0 space-y-4">
          {run.error ? <ErrorAlert title="These changes cannot be run yet" error={run.error} /> : null}
          {r ? (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-5">
                <Stat label={`Revenue, ${horizonMonths} months`} value={<Money value={r.projection.totals.revenue} currency={c} className="text-lg" />} sub="Hypothetical" />
                <Stat label="Net profit" value={<Money value={r.projection.totals.netProfit} currency={c} signed className="text-lg" />} sub={r.projection.totals.netMarginPercent ? `${r.projection.totals.netMarginPercent}% margin` : undefined} tone={r.projection.totals.netProfit.startsWith('-') ? 'negative' : 'positive'} />
                <Stat label="Cash at the end" value={<Money value={r.projection.closingCash} currency={c} signed className="text-lg" />} sub={`From ${new Intl.NumberFormat('en-IN').format(Number(r.projection.openingCash))} now`} tone="violet" />
                <Stat label="Lowest cash" value={<Money value={r.projection.minimumCash.amount} currency={c} signed className="text-lg" />} sub={monthLabel(r.projection.minimumCash.month)} tone={r.projection.cashNegativeFrom ? 'negative' : 'neutral'} />
                <Stat label="Cash to raise" value={<Money value={r.projection.cashRequired} currency={c} className="text-lg" />} sub={r.projection.cashNegativeFrom ? `Runs out in ${monthLabel(r.projection.cashNegativeFrom)}` : 'To stay above the minimum balance'} tone={Number(r.projection.cashRequired) > 0 ? 'warning' : 'positive'} />
              </div>
              <Card className="p-4">
                <CardHeader title="Cash at each month end" description="Solid: actual, from the books. Dashed: hypothetical, with no change and with this scenario." />
                <TwinCashChart
                  actual={r.actualMonths}
                  series={[...(baseline.data ? [{ name: 'No change (hypothetical)', months: baseline.data.projection.months }] : []), { name: `${name || 'This scenario'} (hypothetical)`, months: r.projection.months }]}
                  currency={c}
                  label="Month-end cash: actual months, then the no-change projection and this scenario. The figures are in the table below."
                />
              </Card>
              {r.risks.length || r.missing.length ? (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <Card className="p-4">
                    <CardHeader title="Key risks" />
                    {!r.risks.length ? <p className="text-sm text-fg-muted">No risks flagged.</p> : null}
                    <ul className="space-y-2 text-sm" aria-label="Key risks">
                      {r.risks.map((x) => (
                        <li key={x.code} className="flex gap-2">
                          <Badge tone={x.level === 'HIGH' ? 'negative' : x.level === 'MEDIUM' ? 'warning' : 'neutral'}>{x.level === 'HIGH' ? 'High' : x.level === 'MEDIUM' ? 'Medium' : 'Low'}</Badge>
                          <span>{x.message}</span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                  <Card className="p-4">
                    <CardHeader title="Inputs to confirm" description="Assumptions the scenario is missing or may have wrong." />
                    {!r.missing.length ? <p className="text-sm text-fg-muted">Nothing missing.</p> : null}
                    <ul className="space-y-2 text-sm" aria-label="Inputs to confirm">
                      {r.missing.map((m) => (
                        <li key={m.field} className="flex items-start justify-between gap-2">
                          <span>{m.question}</span>
                          {(m.field === 'TAX_RATE' || m.field === 'INFLATION' || m.field === 'INVESTMENT') && canManage ? (
                            <Button size="sm" variant="ghost" onClick={() => add(m.field === 'TAX_RATE' ? 'TAX_RATE' : m.field === 'INFLATION' ? 'INFLATION' : 'INVESTMENT')}>
                              Add
                            </Button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </Card>
                </div>
              ) : null}
              <Card className="overflow-x-auto">
                <CardHeader title="Projection by month (hypothetical)" />
                <Table aria-label="Projection by month">
                  <thead>
                    <tr>
                      <Th>Month</Th><Th numeric>Revenue</Th><Th numeric>Cost of sales</Th><Th numeric>Payroll</Th><Th numeric>Other costs</Th><Th numeric>EBITDA</Th><Th numeric>Tax</Th><Th numeric>Net profit</Th><Th numeric>Cash flow</Th><Th numeric>Cash at end</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.projection.months.map((m) => (
                      <Tr key={m.month}>
                        <Td className="whitespace-nowrap">{monthLabel(m.month)}</Td>
                        <Td numeric><Money value={m.revenue} currency={c} /></Td>
                        <Td numeric><Money value={m.costOfSales} currency={c} /></Td>
                        <Td numeric><Money value={m.payroll} currency={c} /></Td>
                        <Td numeric><Money value={m.otherOperating} currency={c} /></Td>
                        <Td numeric><Money value={m.ebitda} currency={c} signed /></Td>
                        <Td numeric><Money value={m.tax} currency={c} /></Td>
                        <Td numeric><Money value={m.netProfit} currency={c} signed /></Td>
                        <Td numeric><Money value={m.cashFlow} currency={c} signed /></Td>
                        <Td numeric className={m.closingCash.startsWith('-') ? 'text-negative' : ''}><Money value={m.closingCash} currency={c} signed /></Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
              <Card className="p-4">
                <CardHeader title="Assumptions" description={`Baseline from ${monthLabel(r.baseline.fromMonth)} to ${monthLabel(r.baseline.toMonth)} (${r.baseline.monthsUsed} actual months).`} />
                <ol className="list-decimal space-y-1 pl-5 text-sm text-fg-muted" aria-label="Assumptions">
                  {r.assumptions.map((a) => <li key={a}>{a}</li>)}
                </ol>
              </Card>
            </>
          ) : run.isLoading ? (
            <p className="text-sm text-fg-muted">Running the scenario…</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DriverCard({ d, n, horizon, monthName, disabled, onChange, onRemove }: { d: Driver; n: number; horizon: number; monthName: (n: number) => string; disabled: boolean; onChange: (p: Partial<Driver>) => void; onRemove: () => void }) {
  const meta = DRIVERS[d.kind];
  return (
    <li className="rounded-md border border-line p-3" aria-label={`Change ${n}: ${meta.title}`}>
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-fg">{n}. {meta.title}</div>
          <div className="text-xs text-fg-muted">{meta.help}</div>
        </div>
        {!disabled ? <Button size="sm" variant="ghost" aria-label={`Remove change ${n}`} onClick={onRemove}>Remove</Button> : null}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {meta.fields.map((f) => {
          const v = d[f.key];
          if (f.type === 'bool') {
            return (
              <label key={f.key} className="col-span-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={!!v} disabled={disabled} onChange={(e) => onChange({ [f.key]: e.target.checked })} /> {f.label}
              </label>
            );
          }
          if (f.type === 'select') {
            return (
              <Field key={f.key} label={f.label}>
                {(p) => (
                  <Select {...p} value={String(v ?? '')} disabled={disabled} onChange={(e) => onChange({ [f.key]: e.target.value })}>
                    {f.options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </Select>
                )}
              </Field>
            );
          }
          if (f.type === 'month') {
            return (
              <Field key={f.key} label={f.label}>
                {(p) => (
                  <Select {...p} value={String(v ?? 1)} disabled={disabled} onChange={(e) => onChange({ [f.key]: Number(e.target.value) })}>
                    {Array.from({ length: horizon }, (_, i) => <option key={i + 1} value={i + 1}>{monthName(i + 1)}</option>)}
                  </Select>
                )}
              </Field>
            );
          }
          return (
            <Field key={f.key} label={f.label}>
              {(p) => (
                <Input
                  {...p}
                  value={v === undefined || v === null ? '' : String(v)}
                  disabled={disabled}
                  inputMode={f.type === 'text' ? 'text' : 'decimal'}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (f.type === 'int') onChange({ [f.key]: raw === '' ? ('optional' in f && f.optional ? undefined : 0) : Number(raw) });
                    else if (f.type === 'number') onChange({ [f.key]: raw === '' && 'optional' in f && f.optional ? undefined : raw.trim() });
                    else onChange({ [f.key]: raw });
                  }}
                />
              )}
            </Field>
          );
        })}
      </div>
    </li>
  );
}
