'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardHeader, EmptyState, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Item {
  key: string;
  label: string;
  bills: number;
  quantity: string;
  spend: string;
  firstPrice: string;
  firstDate: string;
  latestPrice: string;
  latestDate: string;
  priceChange: string | null;
  extraPaid: string;
  bestOther: { vendorId: string; vendorName: string; unitPrice: string; date: string; gap: string } | null;
  cheaperSaving: string;
}
interface Brief {
  asOf: string;
  from: string;
  currency: string;
  vendor: { id: string; name: string; paymentTermsDays: number };
  spend: { current: string; previous: string; change: string | null; share: string | null; bills: number };
  payments: { record: 'GOOD' | 'FAIR' | 'POOR' | 'NONE'; paid: number; onTime: number; onTimePercent: number | null; averageDaysLate: number | null; overdue: number };
  paymentRecordLabel: string;
  grade: string | null;
  items: Item[];
  points: { code: string; label: string; tone: 'ASK' | 'CAUTION'; title: string; detail: string; saving: string | null }[];
  targetSaving: string;
}

const RECORD_TONE = { GOOD: 'positive', FAIR: 'neutral', POOR: 'negative', NONE: 'neutral' } as const;

/** One vendor's negotiation brief (AP-033). */
export default function NegotiationBriefPage() {
  const { orgId } = useOrg();
  const { vendorId } = useParams<{ vendorId: string }>();
  const q = useQuery({ queryKey: ['negotiation-brief', orgId, vendorId], queryFn: () => api<Brief>(`/v1/orgs/${orgId}/purchases/negotiation-briefs/${vendorId}`) });
  const d = q.data;
  return (
    <>
      <PageHeader title={d ? `Negotiation brief: ${d.vendor.name}` : 'Negotiation brief'} description={d ? `What to raise with ${d.vendor.name}, from posted bills and payments between ${date(d.from)} and ${date(d.asOf)}. Every point says what it was raised on.` : undefined} />
      <ErrorAlert title="Could not load the negotiation brief" error={q.error} />
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Spend, last 12 months" value={<Money value={d.spend.current} currency={d.currency} />} sub={d.spend.change === null ? 'Nothing billed the year before' : `${d.spend.change.startsWith('-') ? '' : '+'}${d.spend.change}% on the year before`} />
            <Stat label="Share of all purchases" value={d.spend.share === null ? '—' : `${d.spend.share}%`} sub={`${d.spend.bills} ${d.spend.bills === 1 ? 'bill' : 'bills'}`} />
            <Stat label="Your payments" value={<Badge tone={RECORD_TONE[d.payments.record]}>{d.paymentRecordLabel}</Badge>} sub={d.payments.paid ? `${d.payments.onTime} of ${d.payments.paid} paid on time${d.payments.overdue ? `, ${d.payments.overdue} overdue` : ''}` : d.payments.overdue ? `${d.payments.overdue} overdue` : `Terms ${d.vendor.paymentTermsDays} days`} />
            <Stat label="Possible saving" value={<Money value={d.targetSaving} currency={d.currency} />} tone={/[1-9]/.test(d.targetSaving) ? 'positive' : 'neutral'} sub={d.grade ? `Scorecard grade ${d.grade}` : 'Not graded yet'} />
          </div>
          <Card className="mb-4">
            <CardHeader title="Points to raise" description={<>Cautions first, then the largest savings. See also the <Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/vendor-performance`}>vendor scorecards</Link>.</>} />
            {!d.points.length ? (
              <EmptyState title="Nothing stands out">The books show no price rise, cheaper vendor, large volume or payment record to bring up with this vendor.</EmptyState>
            ) : (
              <ul className="divide-y divide-line" aria-label="Points to raise">
                {d.points.map((p, i) => (
                  <li key={`${p.code}-${i}`} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={p.tone === 'CAUTION' ? 'warning' : 'accent'}>{p.label}</Badge>
                      <span className="font-medium">{p.title}</span>
                      {p.saving ? <span className="text-sm text-fg-muted">Saving <Money value={p.saving} currency={d.currency} /></span> : null}
                    </div>
                    <p className="mt-1 text-sm text-fg-muted">{p.detail}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Items bought from this vendor" description="By HSN/SAC code, or by description when a line has none. Prices are per unit, in your currency." />
            {!d.items.length ? (
              <EmptyState title="No items">No posted bill lines from this vendor in the last twelve months.</EmptyState>
            ) : (
              <Table aria-label="Items bought from this vendor">
                <thead><Tr><Th>Item</Th><Th numeric>Quantity</Th><Th numeric>Spend</Th><Th numeric>First price</Th><Th numeric>Latest price</Th><Th numeric>Change</Th><Th>Best other vendor</Th><Th numeric>Paid above first price</Th></Tr></thead>
                <tbody>
                  {d.items.map((it) => (
                    <Tr key={it.key}>
                      <Td>{it.label}<div className="text-xs text-fg-muted">{it.key.startsWith('hsn:') ? `HSN/SAC ${it.key.slice(4)}` : 'By description'} · {it.bills} {it.bills === 1 ? 'bill' : 'bills'}</div></Td>
                      <Td numeric>{it.quantity}</Td>
                      <Td numeric><Money value={it.spend} currency={d.currency} /></Td>
                      <Td numeric><Money value={it.firstPrice} currency={d.currency} /><div className="text-xs text-fg-muted">{date(it.firstDate)}</div></Td>
                      <Td numeric><Money value={it.latestPrice} currency={d.currency} /><div className="text-xs text-fg-muted">{date(it.latestDate)}</div></Td>
                      <Td numeric>{it.priceChange === null ? '—' : `${it.priceChange.startsWith('-') ? '' : '+'}${it.priceChange}%`}</Td>
                      <Td>
                        {it.bestOther ? (
                          <>
                            <Link className="hover:underline" href={`/orgs/${orgId}/purchases/negotiation/${it.bestOther.vendorId}`}>{it.bestOther.vendorName}</Link>: <Money value={it.bestOther.unitPrice} currency={d.currency} />
                            <div className="text-xs text-fg-muted">{!it.bestOther.gap.startsWith('-') && it.bestOther.gap !== '0.0' ? `${it.bestOther.gap}% lower` : 'Not lower'} · {date(it.bestOther.date)}</div>
                          </>
                        ) : (
                          <span className="text-fg-muted">No other vendor</span>
                        )}
                      </Td>
                      <Td numeric><Money value={it.extraPaid} currency={d.currency} /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
