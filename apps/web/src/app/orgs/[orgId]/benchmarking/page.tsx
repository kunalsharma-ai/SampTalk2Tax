'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useEffect, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { POSITION, type BenchmarkComparison, type BenchmarkDefinition, type BenchmarkOverview, type BenchmarkUnit } from '@/lib/benchmarking';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

function Value({ v, unit, currency }: { v: string | null; unit: BenchmarkUnit; currency: string }) {
  if (v === null) return <span className="text-fg-muted">n/a</span>;
  if (unit === 'MONEY') return <Money value={v} currency={currency} signed />;
  return <span className="num">{unit === 'PERCENT' ? `${v}%` : `${v} days`}</span>;
}

/** The peers' middle half as a band, their median as a tick, and this organisation as a dot. */
function RangeBar({ c, def }: { c: BenchmarkComparison; def: BenchmarkDefinition }) {
  const a = c.aggregate;
  if (!a) return null;
  const pts = [a.median, a.lowerQuartile, a.upperQuartile, c.value].filter((x): x is string => x !== null).map(Number);
  let lo = Math.min(...pts);
  let hi = Math.max(...pts);
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.15;
  lo -= pad;
  hi += pad;
  const at = (x: string) => `${((Number(x) - lo) / (hi - lo)) * 100}%`;
  return (
    <div className="relative h-5 w-full min-w-40" aria-hidden="true">
      <div className="absolute top-1/2 h-px w-full -translate-y-1/2 bg-line" />
      {a.lowerQuartile && a.upperQuartile ? (
        <div className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded bg-accent/25" style={{ left: at(a.lowerQuartile), width: `calc(${at(a.upperQuartile)} - ${at(a.lowerQuartile)})` }} />
      ) : null}
      <div className="absolute top-0 h-5 w-0.5 bg-fg-muted" style={{ left: at(a.median) }} />
      {c.value !== null ? <div className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg bg-violet" style={{ left: at(c.value) }} /> : null}
    </div>
  );
}

/**
 * Privacy-preserving benchmarking: this organisation's ten metrics from its own books, and, once
 * it takes part, how they compare with aggregates of other participants. Owners and admins decide
 * whether to take part and which metrics leave the organisation.
 */
export default function BenchmarkingPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['benchmarking', orgId], queryFn: () => api<BenchmarkOverview>(`/v1/orgs/${orgId}/benchmarking`) });
  const [editing, setEditing] = useState(false);
  const [industry, setIndustry] = useState('');
  const [sizeBand, setSizeBand] = useState('');
  const [headcount, setHeadcount] = useState('');
  const [metrics, setMetrics] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const d = q.data;
  useEffect(() => {
    if (!d) return;
    const p = d.participation?.status === 'OPTED_IN' ? d.participation : null;
    setIndustry(p?.industry ?? '');
    setSizeBand(p?.sizeBand ?? d.suggestedSizeBand ?? '');
    setHeadcount(String(p?.headcount ?? (d.headcountSource === 'ENTERED' ? (d.headcount ?? '') : '')));
    setMetrics(p?.sharedMetrics ?? d.methodology.definitions.map((m) => m.key));
    setConsent(false);
  }, [d]);
  const done = (r: BenchmarkOverview) => {
    qc.setQueryData(['benchmarking', orgId], r);
    setEditing(false);
  };
  const join = useMutation({
    mutationFn: () => api<BenchmarkOverview>(`/v1/orgs/${orgId}/benchmarking/participation`, { method: 'PUT', body: { industry, sizeBand, headcount: headcount.trim() ? Number(headcount) : null, metrics, consent } }),
    onSuccess: done,
  });
  const refresh = useMutation({ mutationFn: () => api<BenchmarkOverview>(`/v1/orgs/${orgId}/benchmarking/participation/refresh`, { method: 'POST' }), onSuccess: done });
  const withdraw = useMutation({ mutationFn: () => api<BenchmarkOverview>(`/v1/orgs/${orgId}/benchmarking/participation`, { method: 'DELETE' }), onSuccess: done });
  if (!org) return null;
  const manage = can(org.role, 'org.manage');
  const p = d?.participation?.status === 'OPTED_IN' ? d.participation : null;
  const defs = d?.methodology.definitions ?? [];
  const label = (list: { key: string; label: string }[] | undefined, k: string) => list?.find((x) => x.key === k)?.label ?? k;
  const showForm = manage && (!p || editing);
  const payrollCount = d?.headcountSource === 'PAYROLL';

  return (
    <>
      <PageHeader title="Benchmarking" description="How your margins, growth, collection and payment days compare with similar businesses. Only anonymous aggregates of other participants are ever shown, and only when the group is large enough." />
      <ErrorAlert title="Could not load benchmarking" error={q.error} />
      {d ? (
        <div className="space-y-4">
          {d.pool === 'SYNTHETIC' ? (
            <Alert tone="warning" title="Synthetic demonstration peers">
              This is a demo organisation, so it is compared only with generated peers that are clearly marked as synthetic. Live organisations never see them, and demo figures never reach the live pool.
            </Alert>
          ) : null}

          <Card aria-label="Participation">
            <CardHeader
              title={p ? 'You take part in benchmarking' : 'Take part in benchmarking'}
              description={
                p
                  ? `${label(d.methodology.industries, p.industry)}, ${label(d.methodology.sizeBands, p.sizeBand)}, ${d.countryCode}. Sharing ${p.sharedMetrics.length} of ${defs.length} metrics for ${d.period.label}${p.contributedAt ? `, updated ${dateTime(p.contributedAt)}` : ''}.`
                  : 'Comparisons are give-to-get: you see how a metric compares only if you share it. Nothing is shared until an owner or admin agrees below.'
              }
              actions={
                p && manage && !editing ? (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" onClick={() => refresh.mutate()} disabled={refresh.isPending}>Refresh my figures</Button>
                    <Button variant="secondary" onClick={() => setEditing(true)}>Change what I share</Button>
                    <Button variant="ghost" onClick={() => confirm('Withdraw from benchmarking? Your contribution is deleted from the pool straight away.') && withdraw.mutate()} disabled={withdraw.isPending}>Withdraw</Button>
                  </div>
                ) : null
              }
            />
            {d.participation?.status === 'WITHDRAWN' && !p ? <p className="px-6 pb-2 text-sm text-fg-muted">You withdrew on {dateTime(d.participation.withdrawnAt!)}. Your contribution was deleted from the pool.</p> : null}
            {!manage && !p ? <p className="px-6 pb-6 text-sm text-fg-muted">An owner or admin decides whether this organisation takes part.</p> : null}
            {showForm ? (
              <form
                className="space-y-4 px-6 pb-6"
                onSubmit={(e) => {
                  e.preventDefault();
                  join.mutate();
                }}
              >
                <div className="grid gap-4 md:grid-cols-3">
                  <Field label="Industry">
                    {(f) => (
                      <Select {...f} value={industry} onChange={(e) => setIndustry(e.target.value)} required>
                        <option value="">Choose…</option>
                        {d.methodology.industries.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}
                      </Select>
                    )}
                  </Field>
                  <Field label="Size" hint={payrollCount ? `${d.headcount} people in payroll` : undefined}>
                    {(f) => (
                      <Select {...f} value={sizeBand} onChange={(e) => setSizeBand(e.target.value)} required>
                        <option value="">Choose…</option>
                        {d.methodology.sizeBands.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                      </Select>
                    )}
                  </Field>
                  <Field label="Headcount" hint={payrollCount ? 'Payroll’s count is used' : 'For revenue per employee (optional)'}>
                    {(f) => <Input {...f} inputMode="numeric" value={headcount} onChange={(e) => setHeadcount(e.target.value)} disabled={payrollCount} />}
                  </Field>
                </div>
                <fieldset>
                  <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">Metrics to share</legend>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {defs.map((m) => (
                      <label key={m.key} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={metrics.includes(m.key)} onChange={(e) => setMetrics(e.target.checked ? [...metrics, m.key] : metrics.filter((k) => k !== m.key))} />
                        {m.label}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="rounded-lg border border-line bg-surface-hover/40 p-4 text-sm">
                  <ul className="mb-3 list-disc space-y-1 pl-5 text-fg-muted">
                    {d.methodology.consentText.map((t) => <li key={t}>{t}</li>)}
                  </ul>
                  <label className="flex items-center gap-2 font-medium">
                    <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                    I agree, on behalf of {org.name}, to share the metrics ticked above
                  </label>
                </div>
                <ErrorAlert title="Could not save" error={join.error} />
                <div className="flex gap-2">
                  <Button type="submit" disabled={!consent || !metrics.length || !industry || !sizeBand || join.isPending}>{p ? 'Save what I share' : 'Join and compare'}</Button>
                  {editing ? <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button> : null}
                </div>
              </form>
            ) : null}
            <ErrorAlert title="Could not update" error={refresh.error ?? withdraw.error} />
          </Card>

          <Card>
            <CardHeader title={p ? `How you compare, ${d.period.label}` : `Your metrics, ${d.period.label}`} description={p ? 'The dot is you, the tick is the peers’ median, and the band is their middle half. Each metric uses the narrowest peer group with enough participants.' : 'Worked out from your posted books. Join to see how they compare.'} />
            <Table aria-label="Metrics">
              <thead>
                <tr>
                  <Th>Metric</Th>
                  <Th numeric>You</Th>
                  {p ? (
                    <>
                      <Th numeric>Peers’ median</Th>
                      <Th numeric>Middle half</Th>
                      <Th>Range</Th>
                      <Th>Where you stand</Th>
                    </>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {defs.map((def) => {
                  const m = d.metrics.find((x) => x.key === def.key)!;
                  const c = d.comparison?.find((x) => x.key === def.key);
                  const a = c?.aggregate;
                  return (
                    <Tr key={def.key}>
                      <Td>
                        <div className="font-medium">{def.label}</div>
                        <div className="text-xs text-fg-muted">{def.better === 'HIGHER' ? 'Higher is better' : 'Lower is better'}</div>
                        {m.value === null ? <div className="text-xs text-fg-muted">{m.reason}</div> : null}
                        {c?.group ? <div className="text-xs text-fg-muted">Peers: {c.group.label} ({a!.peers})</div> : null}
                        {c?.note ? <div className="text-xs text-fg-muted">{c.note}</div> : null}
                      </Td>
                      <Td numeric><Value v={m.value} unit={def.unit} currency={d.currency} /></Td>
                      {p ? (
                        <>
                          <Td numeric>{a ? <Value v={a.median} unit={def.unit} currency={d.currency} /> : <span className="text-fg-muted">Not shown</span>}</Td>
                          <Td numeric>{a?.lowerQuartile && a.upperQuartile ? <span className="whitespace-nowrap"><Value v={a.lowerQuartile} unit={def.unit} currency={d.currency} /> to <Value v={a.upperQuartile} unit={def.unit} currency={d.currency} /></span> : <span className="text-fg-muted">{a ? `Needs ${d.methodology.minPeersForQuartiles}+` : ''}</span>}</Td>
                          <Td className="w-48">{c ? <RangeBar c={c} def={def} /> : null}</Td>
                          <Td>{c?.position ? <Badge tone={POSITION[c.position].tone}>{POSITION[c.position].label}</Badge> : null}</Td>
                        </>
                      ) : null}
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </Card>

          <Card aria-label="Methodology">
            <CardHeader title="How benchmarking works" description="The same rules apply to every participant." />
            <div className="grid gap-6 px-6 pb-6 text-sm lg:grid-cols-2">
              <div className="space-y-2">
                <h3 className="font-medium">Privacy</h3>
                <ul className="list-disc space-y-1 pl-5 text-fg-muted">
                  <li>Each metric is worked out from your posted books and rounded (percentages to one place, days and money to whole units). No amounts, names or records leave your organisation.</li>
                  <li>The pool has no organisation id: each participant is a random key, kept only on its own consent record and replaced if it joins again.</li>
                  <li>No organisation can read the pool. Only aggregates over other participants come back: the median once there are at least {d.methodology.minPeers}, the quartiles once there are at least {d.methodology.minPeersForQuartiles}. Smaller groups are suppressed, and the count is shown only as a band.</li>
                  <li>Contributions from the last {d.methodology.freshMonths} months are used. Withdrawing deletes yours at once.</li>
                  <li>Revenue per employee is compared only with participants in the same currency. Demo organisations are compared only with synthetic peers.</li>
                </ul>
                <h3 className="pt-2 font-medium">Peer groups, narrowest first</h3>
                <ol className="list-decimal space-y-1 pl-5 text-fg-muted">
                  <li>Same industry, size band and country</li>
                  <li>Same industry and size band</li>
                  <li>Same industry</li>
                  <li>All participants</li>
                </ol>
              </div>
              <div>
                <h3 className="mb-2 font-medium">Metrics</h3>
                <dl className="space-y-2">
                  {defs.map((m) => (
                    <div key={m.key}>
                      <dt className="font-medium">{m.label}</dt>
                      <dd className="text-fg-muted">{m.formula}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </Card>
        </div>
      ) : null}
    </>
  );
}
