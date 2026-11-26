'use client';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Card, CardHeader, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { axisValue, MEASURE_LABEL, ScenarioSurface3D, type ScenarioSurfaceData, type SurfaceMeasure } from '@/components/twin/scenario-surface';
import { api, ApiError } from '@/lib/api';
import { useOrg } from '@/lib/org';
import { DEFAULT_VIEW, type View3D } from '@/lib/surface-3d';

const AXES: Record<string, { label: string; min: number; max: number; unit: string }> = {
  PRICE: { label: 'Price change (%)', min: -20, max: 20, unit: '%' },
  VOLUME_GROWTH: { label: 'Sales growth (% a month)', min: -5, max: 5, unit: '% a month' },
  CHURN: { label: 'Customers lost (% a month)', min: 0, max: 10, unit: '% a month' },
  COST_OF_SALES: { label: 'Cost of sales change (%)', min: -20, max: 20, unit: '%' },
  PAYROLL: { label: 'Payroll change (%)', min: -20, max: 20, unit: '%' },
  OPERATING_COSTS: { label: 'Operating costs change (%)', min: -20, max: 20, unit: '%' },
  COLLECTION_DAYS: { label: 'Days to collect, change', min: -30, max: 30, unit: 'days' },
  PAYMENT_DAYS: { label: 'Days to pay, change', min: -30, max: 30, unit: 'days' },
};
interface AxisForm {
  axis: string;
  min: string;
  max: string;
  steps: string;
}

function AxisFields({ name, value, onChange }: { name: string; value: AxisForm; onChange: (a: AxisForm) => void }) {
  return (
    <fieldset className="grid grid-cols-2 gap-3 rounded-md border border-line p-3 sm:grid-cols-4">
      <legend className="px-1 text-xs font-medium uppercase tracking-wide text-fg-muted">{name}</legend>
      <Field label={`${name}: change`}>
        {(p) => (
          <Select {...p} value={value.axis} onChange={(e) => onChange({ axis: e.target.value, min: String(AXES[e.target.value].min), max: String(AXES[e.target.value].max), steps: value.steps })}>
            {Object.entries(AXES).map(([k, a]) => (
              <option key={k} value={k}>
                {a.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={`${name}: from`}>{(p) => <Input {...p} type="number" value={value.min} onChange={(e) => onChange({ ...value, min: e.target.value })} />}</Field>
      <Field label={`${name}: to`}>{(p) => <Input {...p} type="number" value={value.max} onChange={(e) => onChange({ ...value, max: e.target.value })} />}</Field>
      <Field label={`${name}: points`}>{(p) => <Input {...p} type="number" min={3} max={11} value={value.steps} onChange={(e) => onChange({ ...value, steps: e.target.value })} />}</Field>
    </fieldset>
  );
}

/**
 * Planning → Digital twin → Scenario surface (DASH-027): the twin re-run over a grid of two
 * changes, one outcome at every point, drawn as a surface you can turn and play month by month.
 * Hypothetical only: nothing is saved or posted.
 */
export default function ScenarioSurfacePage() {
  const { org, orgId } = useOrg();
  const [x, setX] = useState<AxisForm>({ axis: 'PRICE', min: '-20', max: '20', steps: '9' });
  const [y, setY] = useState<AxisForm>({ axis: 'PAYROLL', min: '-20', max: '20', steps: '9' });
  const [measure, setMeasure] = useState<SurfaceMeasure>('NET_PROFIT');
  const [horizon, setHorizon] = useState('12');
  const [baselineMonths, setBaselineMonths] = useState('6');
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [view, setView] = useState<View3D>(DEFAULT_VIEW);
  const [mark, setMark] = useState<{ xi: number; yi: number } | null>(null);
  const draw = useMutation({
    mutationFn: () =>
      api<ScenarioSurfaceData>(`/v1/orgs/${orgId}/twin/surface`, {
        method: 'POST',
        body: {
          baselineMonths: Number(baselineMonths),
          horizonMonths: Number(horizon),
          measure,
          x: { axis: x.axis, min: Number(x.min), max: Number(x.max), steps: Number(x.steps) },
          y: { axis: y.axis, min: Number(y.min), max: Number(y.max), steps: Number(y.steps) },
        },
      }),
    onSuccess: (d) => {
      setFrameIndex(d.frames.length - 1);
      setPlaying(false);
      setMark(null);
    },
  });
  const d = draw.data;
  const frames = d?.frames.length ?? 0;
  useEffect(() => {
    if (!playing || !frames) return;
    const t = setInterval(() => setFrameIndex((i) => (i + 1 >= frames ? 0 : i + 1)), 900);
    return () => clearInterval(t);
  }, [playing, frames]);
  if (!org) return null;
  const frame = d ? d.frames[Math.min(frameIndex, d.frames.length - 1)] : null;
  const issues = draw.error instanceof ApiError ? draw.error.issues : [];
  return (
    <>
      <PageHeader
        title="Scenario surface"
        description="Try two changes at once across a range, say price against payroll, and see one outcome at every combination as a surface. Every point re-runs the digital twin from your actual books. Hypothetical only: nothing is saved or posted."
        actions={
          <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/planning/twin`}>
            Back to the digital twin
          </Link>
        }
      />
      <Card className="mb-4" role="region" aria-label="Surface settings">
        <CardHeader title="Surface settings" description="Choose what to measure and the two changes to vary. Up to 11 points each way (121 runs)." />
        <form
          className="grid gap-3 px-5 pb-5"
          onSubmit={(e) => {
            e.preventDefault();
            draw.mutate();
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Measure">
              {(p) => (
                <Select {...p} value={measure} onChange={(e) => setMeasure(e.target.value as SurfaceMeasure)}>
                  {(Object.keys(MEASURE_LABEL) as SurfaceMeasure[]).map((m) => (
                    <option key={m} value={m}>
                      {MEASURE_LABEL[m]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Months ahead">{(p) => <Input {...p} type="number" min={1} max={24} value={horizon} onChange={(e) => setHorizon(e.target.value)} />}</Field>
            <Field label="Actual months to start from">
              {(p) => (
                <Select {...p} value={baselineMonths} onChange={(e) => setBaselineMonths(e.target.value)}>
                  {['3', '6', '12'].map((m) => (
                    <option key={m} value={m}>{`Last ${m} months`}</option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <AxisFields name="Across" value={x} onChange={setX} />
          <AxisFields name="Back" value={y} onChange={setY} />
          <div>
            <Button type="submit" loading={draw.isPending}>
              Draw the surface
            </Button>
          </div>
          {draw.error ? (
            <Alert tone="negative" title="Could not draw the surface">
              {issues.length ? (
                <ul className="list-disc pl-5">
                  {issues.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              ) : (
                (draw.error as Error).message
              )}
            </Alert>
          ) : null}
        </form>
      </Card>
      {d && frame ? (
        <>
          <section aria-label="Surface summary" className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="With neither change"
              value={d.current === null ? '—' : <Money value={d.current} currency={d.currency} />}
              sub={d.current === null ? 'No change is off the ranges chosen' : `${MEASURE_LABEL[d.measure]}, ${d.frames[d.frames.length - 1].month}`}
              tone="neutral"
            />
            <Stat label="Best point" value={<Money value={d.best.value} currency={d.currency} />} sub={`${axisValue(d.best.x, d.x.unit)} · ${axisValue(d.best.y, d.y.unit)}`} tone="positive" />
            <Stat
              label="Worst point"
              value={<Money value={d.worst.value} currency={d.currency} />}
              sub={`${axisValue(d.worst.x, d.x.unit)} · ${axisValue(d.worst.y, d.y.unit)}`}
              tone={Number(d.worst.value) < 0 ? 'negative' : 'warning'}
            />
            <Stat label="Points where cash runs out" value={`${d.cashNegativeCells} of ${d.runs}`} sub="Cash below zero in some month" tone={d.cashNegativeCells ? 'negative' : 'positive'} />
          </section>
          <Card className="mb-4" role="region" aria-label="Scenario surface">
            <CardHeader
              title="Scenario surface"
              description={`From actual months ${d.actualFrom} to ${d.actualTo}. Drag to turn it, or focus it and use the arrow keys. Play the months to watch it build up; each month shows the measure up to then.`}
            />
            <div className="flex flex-wrap items-center gap-3 px-5 pb-3">
              <Button
                variant="secondary"
                aria-pressed={playing}
                onClick={() => {
                  if (!playing && frameIndex >= frames - 1) setFrameIndex(0);
                  setPlaying((p) => !p);
                }}
              >
                {playing ? 'Pause' : 'Play months'}
              </Button>
              <Button variant="ghost" onClick={() => setView(DEFAULT_VIEW)}>
                Reset view
              </Button>
              <Button variant="ghost" onClick={() => setView({ yaw: 0, pitch: 85 })}>
                View from above
              </Button>
              <label className="flex min-w-[14rem] flex-1 items-center gap-3 text-sm">
                <span className="text-fg-muted">Month</span>
                <input
                  type="range"
                  className="flex-1"
                  min={0}
                  max={frames - 1}
                  value={frameIndex}
                  onChange={(e) => {
                    setPlaying(false);
                    setFrameIndex(Number(e.target.value));
                  }}
                  aria-label="Projected month to show"
                  aria-valuetext={frame.month}
                />
                <span className="w-20 text-right font-medium" aria-live="polite" data-testid="surface-month">
                  {frame.month}
                </span>
              </label>
            </div>
            <div className="px-4 pb-4">
              <ScenarioSurface3D d={d} frame={frame} view={view} onView={setView} mark={mark} />
            </div>
          </Card>
          <Card role="region" aria-label="Surface values">
            <CardHeader
              title="Surface values"
              description={`${MEASURE_LABEL[d.measure]} in ${frame.month} at every point. Across: ${d.x.label.toLowerCase()}; down: ${d.y.label.toLowerCase()}. Choose a value to mark it on the surface.`}
            />
            <div className="overflow-x-auto">
              <Table aria-label={`${MEASURE_LABEL[d.measure]}, ${frame.month}`}>
                <thead>
                  <tr>
                    <Th>{`${d.y.label} / ${d.x.label}`}</Th>
                    {d.x.values.map((v) => (
                      <Th key={v} numeric>
                        {axisValue(v, d.x.unit)}
                      </Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.y.values.map((yv, yi) => (
                    <Tr key={yv}>
                      <Th scope="row">{axisValue(yv, d.y.unit)}</Th>
                      {d.x.values.map((xv, xi) => {
                        const on = mark?.xi === xi && mark?.yi === yi;
                        return (
                          <Td key={xv} numeric className={on ? 'bg-accent/15' : undefined}>
                            <button
                              type="button"
                              className="hover:underline"
                              aria-pressed={on}
                              aria-label={`${d.x.label} ${axisValue(xv, d.x.unit)}, ${d.y.label} ${axisValue(yv, d.y.unit)}`}
                              onClick={() => setMark(on ? null : { xi, yi })}
                            >
                              <Money value={frame.values[yi][xi]} currency={d.currency} signed />
                            </button>
                          </Td>
                        );
                      })}
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </Card>
        </>
      ) : null}
    </>
  );
}
