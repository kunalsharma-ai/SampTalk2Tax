'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEAL_STAGE_LABEL, DEAL_STAGE_PROBABILITY, isOpenStage, LEAD_SOURCE_LABEL, OPEN_DEAL_STAGES } from '@talk2tax/accounting-engine';
import { Badge, Button, Card, CardHeader, Dialog, Field, Input, Select, Textarea } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { StageBadge, Timeline } from '@/components/crm/bits';
import { DealForm } from '@/components/crm/deal-form';
import { Money } from '@/components/money';
import { DealSales } from '@/components/sales-orders/deal-sales';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { DealDetail, DealStage } from '@/lib/crm';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

export default function DealPage() {
  const { org, orgId } = useOrg();
  const { dealId } = useParams<{ dealId: string }>();
  const qc = useQueryClient();
  const key = ['crm-deal', orgId, dealId];
  const deal = useQuery({ queryKey: key, queryFn: () => api<DealDetail>(`/v1/orgs/${orgId}/crm/deals/${dealId}`) });
  const [editing, setEditing] = useState(false);
  const [losing, setLosing] = useState(false);
  const [lostReason, setLostReason] = useState('');
  const [stage, setStage] = useState<DealStage | ''>('');
  const [probability, setProbability] = useState('');
  const move = useMutation({
    mutationFn: (b: { stage: DealStage; probability?: number | null; lostReason?: string }) => api<DealDetail>(`/v1/orgs/${orgId}/crm/deals/${dealId}/stage`, { method: 'POST', body: b }),
    onSuccess: async () => {
      setLosing(false);
      setLostReason('');
      setStage('');
      setProbability('');
      await qc.invalidateQueries({ queryKey: key });
      await qc.invalidateQueries({ queryKey: ['crm-deals', orgId] });
    },
  });
  if (!org) return null;
  if (deal.error) return <ErrorAlert title="Could not load the deal" error={deal.error} />;
  const d = deal.data;
  if (!d) return <p className="text-sm text-fg-muted">Loading…</p>;
  const cur = org.functionalCurrency;
  const open = isOpenStage(d.stage);
  const target = (stage || d.stage) as DealStage;
  return (
    <>
      <PageHeader
        title={`${d.reference} ${d.name}`}
        description={[d.contact?.name, d.owner ? `owned by ${d.owner.name}` : 'no owner yet'].filter(Boolean).join(' · ')}
        actions={
          d.can.manage ? (
            <>
              <Button variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
              {open ? (
                <>
                  <Button variant="danger" onClick={() => setLosing(true)}>Mark lost</Button>
                  <Button loading={move.isPending && move.variables?.stage === 'WON'} onClick={() => move.mutate({ stage: 'WON' })}>Mark won</Button>
                </>
              ) : (
                <Button variant="secondary" loading={move.isPending} onClick={() => move.mutate({ stage: 'NEGOTIATION' })}>Reopen</Button>
              )}
            </>
          ) : null
        }
      />
      <ErrorAlert title="Could not change the stage" error={move.error} />
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="flex flex-col gap-4 xl:col-span-1">
          <Card>
            <CardHeader title="Deal" />
            <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-2 px-5 pb-5 text-sm">
              <dt className="text-fg-muted">Stage</dt><dd><StageBadge stage={d.stage} /></dd>
              <dt className="text-fg-muted">Amount</dt><dd className="font-medium"><Money value={d.amount} currency={cur} /></dd>
              <dt className="text-fg-muted">Probability</dt><dd>{d.probability}%</dd>
              <dt className="text-fg-muted">Weighted</dt><dd><Money value={d.weighted} currency={cur} /></dd>
              <dt className="text-fg-muted">Expected close</dt><dd className="flex items-center gap-2">{date(d.expectedCloseDate)}{d.overdue ? <Badge tone="warning">Past date</Badge> : null}</dd>
              {d.closedOn ? <><dt className="text-fg-muted">Closed</dt><dd>{date(d.closedOn)}</dd></> : null}
              {d.lostReason ? <><dt className="text-fg-muted">Lost because</dt><dd>{d.lostReason}</dd></> : null}
              <dt className="text-fg-muted">Customer</dt><dd>{d.contact ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/customers/${d.contact.id}`}>{d.contact.name}</Link> : '—'}</dd>
              {d.lead ? <><dt className="text-fg-muted">From lead</dt><dd><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/leads/${d.lead.id}`}>{d.lead.reference} {d.lead.name}</Link> <span className="text-fg-faint">({LEAD_SOURCE_LABEL[d.lead.source]})</span></dd></> : null}
              {d.notes ? <><dt className="text-fg-muted">Notes</dt><dd className="whitespace-pre-wrap">{d.notes}</dd></> : null}
            </dl>
          </Card>
          {d.can.manage && open ? (
            <Card>
              <CardHeader title="Move the deal" description="Each stage has a default win probability; give another if you know better." />
              <form
                className="grid gap-3 px-5 pb-5"
                onSubmit={(e) => {
                  e.preventDefault();
                  move.mutate({ stage: target, probability: probability ? Number(probability) : null });
                }}
              >
                <Field label="Stage">{(p) => <Select {...p} value={target} onChange={(e) => setStage(e.target.value as DealStage)}>{OPEN_DEAL_STAGES.map((s) => <option key={s} value={s}>{DEAL_STAGE_LABEL[s]} ({DEAL_STAGE_PROBABILITY[s]}%)</option>)}</Select>}</Field>
                <Field label="Win probability (%)" hint={target === d.stage ? `Now ${d.probability}%.` : `Blank for ${DEAL_STAGE_PROBABILITY[target]}%.`}>{(p) => <Input {...p} inputMode="numeric" className="num" value={probability} onChange={(e) => setProbability(e.target.value)} />}</Field>
                <div><Button type="submit" size="sm" variant="secondary" loading={move.isPending} disabled={target === d.stage && !probability}>Update</Button></div>
              </form>
            </Card>
          ) : null}
        </div>
        <div className="flex flex-col gap-4 xl:col-span-2">
          <DealSales orgId={orgId} dealId={d.id} contactId={d.contact?.id ?? null} currency={cur} />
          <Timeline orgId={orgId} target={{ dealId: d.id }} activities={d.activities} canLog={d.can.manage} currency={cur} queryKey={key} />
        </div>
      </div>
      <Dialog open={editing} onOpenChange={setEditing} title={`Edit ${d.reference}`}>
        {editing ? <DealForm orgId={orgId} currency={cur} deal={d} onSaved={() => setEditing(false)} onCancel={() => setEditing(false)} /> : null}
      </Dialog>
      <Dialog open={losing} onOpenChange={setLosing} title={`Mark ${d.reference} lost`} description="The reason is kept with the deal and counts in the win rate. A lost deal can be reopened.">
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            move.mutate({ stage: 'LOST', lostReason });
          }}
        >
          <Field label="Why was it lost?">{(p) => <Textarea {...p} rows={2} value={lostReason} onChange={(e) => setLostReason(e.target.value)} placeholder="Chose a cheaper provider" />}</Field>
          <ErrorAlert title="Could not mark it lost" error={move.error} />
          <div className="flex justify-end"><Button type="submit" variant="danger" loading={move.isPending} disabled={!lostReason.trim()}>Mark lost</Button></div>
        </form>
      </Dialog>
    </>
  );
}
