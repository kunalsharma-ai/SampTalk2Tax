'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, CardHeader, Field, Input, Select } from '@talk2tax/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { DisasterResults } from '@/components/disasters/disaster-results';
import { api, ApiError } from '@/lib/api';
import { newShock, type Options, type Shock, type ShockKind, type SimulateResponse, type SimulationDetail } from '@/lib/disasters';
import { money } from '@/lib/format';
import { monthLabel, shiftYm } from '@/lib/twin';

type Init = { name: string; description: string; baselineMonths: 3 | 6 | 12; horizonMonths: number; shocks: Shock[] };

/**
 * Builds a disaster simulation from shocks, runs it against the posted books and, for people
 * who manage scenarios, saves it. Shocks pick customers and suppliers from the books.
 */
export function SimulationBuilder({ orgId, simulationId, init, canManage, initialResult }: { orgId: string; simulationId?: string; init: Init; canManage: boolean; initialResult?: SimulateResponse | null }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [name, setName] = useState(init.name);
  const [description, setDescription] = useState(init.description);
  const [baselineMonths, setBaselineMonths] = useState(init.baselineMonths);
  const [horizonMonths, setHorizonMonths] = useState(init.horizonMonths);
  const [shocks, setShocks] = useState<Shock[]>(init.shocks);
  const [result, setResult] = useState<SimulateResponse | null>(initialResult ?? null);
  const [saved, setSaved] = useState(false);
  const opts = useQuery({ queryKey: ['disaster-options', orgId, baselineMonths, horizonMonths], queryFn: () => api<Options>(`/v1/orgs/${orgId}/disasters/options?baselineMonths=${baselineMonths}&horizonMonths=${horizonMonths}`) });
  const body = () => ({ baselineMonths, horizonMonths, shocks });
  const run = useMutation({ mutationFn: () => api<SimulateResponse>(`/v1/orgs/${orgId}/disasters/simulate`, { method: 'POST', body: body() }), onSuccess: setResult });
  const save = useMutation({
    mutationFn: () =>
      simulationId
        ? api<SimulationDetail>(`/v1/orgs/${orgId}/disasters/simulations/${simulationId}`, { method: 'PUT', body: { ...body(), name: name.trim(), description: description.trim() || null } })
        : api<SimulationDetail>(`/v1/orgs/${orgId}/disasters/simulations`, { method: 'POST', body: { ...body(), name: name.trim(), description: description.trim() || null } }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['disaster-simulations', orgId] });
      void qc.invalidateQueries({ queryKey: ['disaster-simulation', orgId, s.id] });
      setSaved(true);
      if (s.result) setResult({ ...s.result, currency: s.currency, actual: s.actual });
      if (!simulationId) router.push(`/orgs/${orgId}/planning/disasters/${s.id}`);
    },
  });
  const o = opts.data;
  const change = (i: number, patch: Partial<Shock>) => (setShocks((xs) => xs.map((x, k) => (k === i ? ({ ...x, ...patch } as Shock) : x))), setSaved(false), setResult(null));
  const first = o?.firstMonth ?? '';
  const monthOptions = Array.from({ length: horizonMonths }, (_, k) => k + 1);
  const err = run.error ?? save.error;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="The simulation" description="Played forward from the posted books with the digital twin. Nothing is posted, paid or sent." />
        <div className="grid gap-3 px-5 pb-5 md:grid-cols-2">
          {canManage ? (
            <>
              <Field label="Name">{(p) => <Input {...p} value={name} maxLength={120} onChange={(e) => (setName(e.target.value), setSaved(false))} />}</Field>
              <Field label="Description">{(p) => <Input {...p} value={description} maxLength={1000} onChange={(e) => (setDescription(e.target.value), setSaved(false))} />}</Field>
            </>
          ) : null}
          <Field label="Baseline">
            {(p) => (
              <Select {...p} value={baselineMonths} onChange={(e) => (setBaselineMonths(Number(e.target.value) as 3 | 6 | 12), setResult(null), setSaved(false))}>
                <option value={3}>Last 3 months</option>
                <option value={6}>Last 6 months</option>
                <option value={12}>Last 12 months</option>
              </Select>
            )}
          </Field>
          <Field label="Horizon">
            {(p) => (
              <Select {...p} value={horizonMonths} onChange={(e) => (setHorizonMonths(Number(e.target.value)), setResult(null), setSaved(false))}>
                {[6, 12, 18, 24].map((h) => <option key={h} value={h}>{h} months</option>)}
              </Select>
            )}
          </Field>
        </div>
      </Card>

      {shocks.map((s, i) => {
        const info = o?.kinds.find((k) => k.key === s.kind);
        const legend = `Shock ${i + 1}: ${info?.label ?? s.kind}`;
        return (
          <Card key={i}>
            <fieldset aria-label={legend}>
              <CardHeader title={legend} description={info?.description} actions={<Button variant="ghost" onClick={() => (setShocks((xs) => xs.filter((_, k) => k !== i)), setResult(null), setSaved(false))}>Remove</Button>} />
              <div className="grid gap-3 px-5 pb-5 md:grid-cols-3">
                <Field label="Starts in">
                  {(p) => (
                    <Select {...p} value={s.month ?? 1} onChange={(e) => change(i, { month: Number(e.target.value) })}>
                      {monthOptions.map((m) => <option key={m} value={m}>{first ? monthLabel(shiftYm(first, m - 1)) : `Month ${m}`}</option>)}
                    </Select>
                  )}
                </Field>
                <ShockFields s={s} o={o} currency={o?.currency ?? ''} onChange={(patch) => change(i, patch)} />
              </div>
            </fieldset>
          </Card>
        );
      })}

      <Card>
        <div className="flex flex-wrap items-center gap-2 p-5">
          <span className="text-sm text-fg-muted">Add a shock:</span>
          {(o?.kinds ?? []).map((k) => (
            <Button
              key={k.key}
              variant="secondary"
              disabled={shocks.length >= 10 || (k.key === 'CUSTOMER_DEFAULT' && !o!.customers.length) || (k.key === 'SUPPLIER_FAILURE' && !o!.suppliers.length)}
              onClick={() => (setShocks((xs) => [...xs, newShock(k.key as ShockKind, o!)]), setResult(null), setSaved(false))}
            >
              {k.label}
            </Button>
          ))}
        </div>
      </Card>

      {err ? <ErrorAlert title={err instanceof ApiError && err.issues.length === 1 ? err.issues[0]! : 'Could not run the simulation'} error={err} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => run.mutate()} loading={run.isPending} disabled={!shocks.length}>Run the simulation</Button>
        {canManage ? <Button variant="secondary" onClick={() => save.mutate()} loading={save.isPending} disabled={!shocks.length || !name.trim()}>{simulationId ? 'Save changes' : 'Save simulation'}</Button> : null}
        {saved ? <span className="self-center text-sm text-positive">Saved.</span> : null}
      </div>
      {!shocks.length ? <Alert tone="neutral" title="No shocks yet">Add a shock above, then run the simulation.</Alert> : null}
      {result ? <DisasterResults r={result} actual={result.actual} currency={result.currency} /> : null}
    </div>
  );
}

function ShockFields({ s, o, currency, onChange }: { s: Shock; o: Options | undefined; currency: string; onChange: (patch: Partial<Shock>) => void }) {
  const num = (label: string, key: string, hint?: string) => (
    <Field label={label} hint={hint}>{(p) => <Input {...p} inputMode="decimal" value={String((s as Record<string, unknown>)[key] ?? '')} onChange={(e) => onChange({ [key]: e.target.value } as Partial<Shock>)} />}</Field>
  );
  const int = (label: string, key: string) => (
    <Field label={label}>{(p) => <Input {...p} type="number" min={0} value={String((s as Record<string, unknown>)[key] ?? 0)} onChange={(e) => onChange({ [key]: Number(e.target.value) } as Partial<Shock>)} />}</Field>
  );
  switch (s.kind) {
    case 'CUSTOMER_DEFAULT': {
      const c = o?.customers.find((x) => x.contactId === s.contactId);
      return (
        <>
          <Field label="Customer" hint={c ? `Sells ${money(c.monthlyRevenue, currency)} a month; owes ${money(c.balance, currency)} now` : undefined}>
            {(p) => (
              <Select {...p} value={s.contactId} onChange={(e) => onChange({ contactId: e.target.value })}>
                {(o?.customers ?? []).map((x) => <option key={x.contactId} value={x.contactId}>{x.name}</option>)}
              </Select>
            )}
          </Field>
          {num('Share of the balance never paid (%)', 'writeOffPercent')}
          <Field label="Future sales">
            {(p) => (
              <Select {...p} value={s.loseFutureSales ? 'yes' : 'no'} onChange={(e) => onChange({ loseFutureSales: e.target.value === 'yes' })}>
                <option value="yes">Lost: the customer stops buying</option>
                <option value="no">Replaced by other customers</option>
              </Select>
            )}
          </Field>
        </>
      );
    }
    case 'SUPPLIER_FAILURE': {
      const x = o?.suppliers.find((y) => y.contactId === s.contactId);
      return (
        <>
          <Field label="Supplier" hint={x ? `Bills ${money(x.monthlySpend, currency)} a month` : undefined}>
            {(p) => (
              <Select {...p} value={s.contactId} onChange={(e) => onChange({ contactId: e.target.value })}>
                {(o?.suppliers ?? []).map((y) => <option key={y.contactId} value={y.contactId}>{y.name}</option>)}
              </Select>
            )}
          </Field>
          {int('Months until a replacement delivers', 'disruptionMonths')}
          {num('Sales lost meanwhile (%)', 'revenueLostPercent')}
          {num('Replacement costs more by (%)', 'replacementPremiumPercent')}
        </>
      );
    }
    case 'LIQUIDITY_SHOCK':
      return (
        <>
          {num('Cash frozen', 'frozenCash', o?.cash ? `Cash now: ${money(o.cash, currency)}` : undefined)}
          {int('Months the cash stays frozen', 'frozenMonths')}
          {num('Credit line withdrawn (repaid at once)', 'creditWithdrawn')}
          {int('Extra days customers take to pay', 'collectionDelayDays')}
          {int('Months customers pay late', 'delayMonths')}
        </>
      );
    case 'OPERATIONAL_DISRUPTION':
      return (
        <>
          {num('Sales lost (%)', 'revenueLostPercent')}
          {int('Months it lasts', 'months')}
          {num('Cost to recover', 'recoveryCost')}
          {num('Insurance payout', 'insuranceRecovery')}
          {int('Months until the insurer pays', 'insuranceMonthsLater')}
        </>
      );
    case 'DEMAND_SHOCK':
      return (
        <>
          {num('Sales lost (%)', 'revenueLostPercent')}
          {int('Months it lasts', 'months')}
          {int('Extra days customers take to pay', 'extraCollectionDays')}
        </>
      );
  }
}
