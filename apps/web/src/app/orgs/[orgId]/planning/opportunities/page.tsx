'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import type { AssessmentDetail } from '@/lib/impact';
import { CONFIDENCE, type OpportunitiesResponse, type Opportunity } from '@/lib/opportunities';
import { useOrg } from '@/lib/org';
import { monthLabel } from '@/lib/twin';
import { can } from '@/lib/types';

type Settings = { horizonMonths: number; winBackRatePercent: string; crossSellRatePercent: string; segmentGrowthPercent: string };
const DEFAULTS: Settings = { horizonMonths: 12, winBackRatePercent: '25', crossSellRatePercent: '15', segmentGrowthPercent: '10' };
const qs = (s: Settings) => new URLSearchParams(Object.entries(s).map(([k, v]) => [k, String(v)])).toString();

/** Opportunity intelligence: growth opportunities found in the books, each measured on the digital twin. */
export default function OpportunitiesPage() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const [draft, setDraft] = useState<Settings>(DEFAULTS);
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const q = useQuery({ queryKey: ['opportunities', orgId, settings], queryFn: () => api<OpportunitiesResponse>(`/v1/orgs/${orgId}/opportunities?${qs(settings)}`), retry: false });
  const take = useMutation({
    mutationFn: (key: string) => api<AssessmentDetail>(`/v1/orgs/${orgId}/opportunities/${encodeURIComponent(key)}/assessment?${qs(settings)}`, { method: 'POST' }),
    onSuccess: (a) => router.push(`/orgs/${orgId}/planning/impact/${a.id}`),
  });
  if (!org) return null;
  const d = q.data;
  const canTake = can(org.role, 'scenarios.manage') && can(org.role, 'purchases.read');
  const err = q.error;
  return (
    <>
      <PageHeader
        title="Growth opportunities"
        description="Profitable growth found in your own books: customers who have stopped buying, lines other customers do not buy yet, your best-margin department or project, and margin that has slipped. Each one is sized from named records and measured on the digital twin. Nothing is posted or sent."
        actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/planning/impact`}>Business impact</Link>}
      />
      <Card>
        <CardHeader title="Assumptions you can change" description="How much of each opportunity you expect to win. The defaults are deliberately modest." />
        <form
          className="grid gap-3 px-5 pb-5 md:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            setSettings(draft);
          }}
        >
          <Field label="Lapsed customers’ sales won back (%)">{(p) => <Input {...p} inputMode="decimal" value={draft.winBackRatePercent} onChange={(e) => setDraft({ ...draft, winBackRatePercent: e.target.value })} />}</Field>
          <Field label="Customers taking up a line (%)">{(p) => <Input {...p} inputMode="decimal" value={draft.crossSellRatePercent} onChange={(e) => setDraft({ ...draft, crossSellRatePercent: e.target.value })} />}</Field>
          <Field label="Growth of the best segment (%)">{(p) => <Input {...p} inputMode="decimal" value={draft.segmentGrowthPercent} onChange={(e) => setDraft({ ...draft, segmentGrowthPercent: e.target.value })} />}</Field>
          <Field label="Measured over">
            {(p) => (
              <Select {...p} value={draft.horizonMonths} onChange={(e) => setDraft({ ...draft, horizonMonths: Number(e.target.value) })}>
                {[6, 12, 18, 24].map((h) => <option key={h} value={h}>{h} months</option>)}
              </Select>
            )}
          </Field>
          <div className="self-end">
            <Button type="submit" loading={q.isFetching}>Look again</Button>
          </div>
        </form>
      </Card>

      {err ? <ErrorAlert title={err instanceof ApiError && err.issues.length === 1 ? err.issues[0]! : 'Could not look for opportunities'} error={err} /> : null}
      <ErrorAlert title="Could not take the opportunity forward" error={take.error} />

      {d ? (
        <div className="mt-4 space-y-4">
          <p className="text-sm" data-testid="opportunities-summary">{d.summary}</p>
          {d.opportunities.map((o, i) => (
            <OpportunityCard key={o.key} o={o} rank={i + 1} currency={d.currency} horizon={d.horizonMonths} canTake={canTake} taking={take.isPending && take.variables === o.key} onTake={() => take.mutate(o.key)} />
          ))}
          <Card>
            <CardHeader title="What was checked" description={`Posted sales and costs from ${monthLabel(d.window.from)} to ${monthLabel(d.window.to)}.`} />
            <Table aria-label="What was checked">
              <thead>
                <tr>
                  <Th>Looked for</Th>
                  <Th numeric>Found</Th>
                  <Th>Result</Th>
                </tr>
              </thead>
              <tbody>
                {d.checks.map((c) => (
                  <Tr key={c.kind}>
                    <Td className="font-medium">{c.label}<p className="text-xs font-normal text-fg-muted">{d.kinds.find((k) => k.key === c.kind)?.description}</p></Td>
                    <Td numeric>{c.found}</Td>
                    <Td className="text-sm">{c.note}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>
      ) : !err ? (
        <p className="mt-4 text-sm text-fg-muted">Looking through the books…</p>
      ) : null}
    </>
  );
}

function OpportunityCard({ o, rank, currency, horizon, canTake, taking, onTake }: { o: Opportunity; rank: number; currency: string; horizon: number; canTake: boolean; taking: boolean; onTake: () => void }) {
  const c = CONFIDENCE[o.confidence];
  return (
    <Card>
      <section aria-label={`Opportunity ${rank}: ${o.title}`}>
        <CardHeader
          title={<span className="flex flex-wrap items-center gap-2">{rank}. {o.title} <Badge tone={c.tone}>{c.label}</Badge></span>}
          description={o.finding}
          actions={canTake ? <Button variant="secondary" loading={taking} onClick={onTake}>Assess in business impact</Button> : null}
        />
        <div className="space-y-4 px-5 pb-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Extra net profit" value={<Money value={o.effect.netProfit} currency={currency} signed />} sub={`Over ${horizon} months`} tone={o.effect.netProfit.startsWith('-') ? 'negative' : 'positive'} />
            <Stat label="Extra revenue" value={<Money value={o.effect.revenue} currency={currency} signed />} sub={o.effect.grossMarginPoints ? `Gross margin ${Number(o.effect.grossMarginPoints) > 0 ? '+' : ''}${o.effect.grossMarginPoints} pts` : undefined} />
            <Stat label="Cash at the end" value={<Money value={o.effect.closingCash} currency={currency} signed />} sub="Against carrying on as is" tone={o.effect.closingCash.startsWith('-') ? 'negative' : 'neutral'} />
          </div>
          <Table aria-label={`Evidence for opportunity ${rank}`}>
            <thead>
              <tr>{o.evidence.columns.map((h, i) => <Th key={h} numeric={i > 0}>{h}</Th>)}</tr>
            </thead>
            <tbody>
              {o.evidence.rows.map((r) => (
                <Tr key={r.join('|')}>{r.map((v, i) => <Td key={i} numeric={i > 0} className={i === 0 ? 'font-medium' : ''}>{v}</Td>)}</Tr>
              ))}
            </tbody>
          </Table>
          <div className="text-sm text-fg-muted">
            <p className="font-medium text-fg">Assumptions</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">{o.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
            <p className="mt-2">{c.label}: {o.confidenceReason}</p>
          </div>
        </div>
      </section>
    </Card>
  );
}
