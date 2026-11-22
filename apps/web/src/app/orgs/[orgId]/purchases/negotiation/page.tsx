'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardHeader, EmptyState, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface VendorRow {
  vendor: { id: string; name: string };
  spend: string;
  change: string | null;
  share: string | null;
  bills: number;
  grade: string | null;
  paymentRecord: 'GOOD' | 'FAIR' | 'POOR' | 'NONE';
  paymentRecordLabel: string;
  points: { code: string; label: string; tone: 'ASK' | 'CAUTION' }[];
  targetSaving: string;
}
interface Briefs {
  asOf: string;
  from: string;
  currency: string;
  summary: { vendors: number; withPoints: number; targetSaving: string };
  vendors: VendorRow[];
}

const RECORD_TONE = { GOOD: 'positive', FAIR: 'neutral', POOR: 'negative', NONE: 'neutral' } as const;

/** Supplier negotiation help (AP-033): where the books give you leverage with each vendor. */
export default function NegotiationPage() {
  const { orgId } = useOrg();
  const q = useQuery({ queryKey: ['negotiation-briefs', orgId], queryFn: () => api<Briefs>(`/v1/orgs/${orgId}/purchases/negotiation-briefs`) });
  const d = q.data;
  return (
    <>
      <PageHeader title="Supplier negotiation" description="For every vendor billed in the last twelve months: prices that went up, the same item cheaper from another vendor, how much you buy, how well you pay and how the vendor performs, with the savings your books can show. Nothing here changes the books or contacts a vendor." />
      <ErrorAlert title="Could not load negotiation briefs" error={q.error} />
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-3">
            <Stat label="Vendors billed" value={d.summary.vendors} sub={`${date(d.from)} to ${date(d.asOf)}`} />
            <Stat label="With something to ask" value={d.summary.withPoints} tone={d.summary.withPoints ? 'warning' : 'neutral'} />
            <Stat label="Savings the books show" value={<Money value={d.summary.targetSaving} currency={d.currency} />} tone={/[1-9]/.test(d.summary.targetSaving) ? 'positive' : 'neutral'} sub="Price rises and cheaper vendors" />
          </div>
          <Card>
            <CardHeader title="Vendors to negotiate with" description="Largest possible saving first, then the most points to raise and the largest spend." />
            {!d.vendors.length ? (
              <EmptyState title="No vendors billed">Post bills from vendors and their briefs appear here.</EmptyState>
            ) : (
              <Table aria-label="Vendors to negotiate with">
                <thead><Tr><Th>Vendor</Th><Th numeric>Spend</Th><Th numeric>Change</Th><Th numeric>Share</Th><Th>Paying</Th><Th>Grade</Th><Th>Points to raise</Th><Th numeric>Possible saving</Th></Tr></thead>
                <tbody>
                  {d.vendors.map((v) => (
                    <Tr key={v.vendor.id}>
                      <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/negotiation/${v.vendor.id}`}>{v.vendor.name}</Link><div className="text-xs text-fg-muted">{v.bills} {v.bills === 1 ? 'bill' : 'bills'}</div></Td>
                      <Td numeric><Money value={v.spend} currency={d.currency} /></Td>
                      <Td numeric>{v.change === null ? '—' : `${v.change.startsWith('-') ? '' : '+'}${v.change}%`}</Td>
                      <Td numeric>{v.share === null ? '—' : `${v.share}%`}</Td>
                      <Td><Badge tone={RECORD_TONE[v.paymentRecord]}>{v.paymentRecordLabel}</Badge></Td>
                      <Td>{v.grade ?? '—'}</Td>
                      <Td>
                        {v.points.length ? (
                          <div className="flex flex-wrap gap-1">{v.points.map((p, i) => <Badge key={`${p.code}-${i}`} tone={p.tone === 'CAUTION' ? 'warning' : 'accent'}>{p.label}</Badge>)}</div>
                        ) : (
                          <span className="text-fg-muted">Nothing stands out</span>
                        )}
                      </Td>
                      <Td numeric><Money value={v.targetSaving} currency={d.currency} /></Td>
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
