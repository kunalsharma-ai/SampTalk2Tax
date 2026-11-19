'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { bytes, type Level, UsageMeter } from '@/components/usage-meter';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg, useOrgId } from '@/lib/org';
import { can } from '@/lib/types';

interface Usage {
  month: string;
  resetsAt: string;
  plan: string | null;
  ai: Level & { inputTokens: number; outputTokens: number; ownKey: number; talk2taxKey: number; extra: number };
  uploads: Level & { bytes: number };
  days: { day: string; ai: number; uploads: number }[];
  history: { month: string; ai: number; uploads: number; tokens: number }[];
  credits: Credits | null;
}
interface Credits {
  balance: number;
  bought: { id: string; name: string; invoiceId: string; requests: number; used: number; left: number; grantedAt: string; expiresAt: string; expired: boolean }[];
  packs: { id: string; name: string; requests: number; price: string; currency: string; perRequest: string }[];
}
interface CreditQuote { pack: { id: string; name: string; requests: number }; currency: string; subtotal: string; lines: { code: string; rate: string; amount: string }[]; taxTotal: string; total: string; note: string; expiresAt: string; payOnline: boolean }
interface PaidCheck { invoice: { id: string; number: string | null; total: string; currency: string; creditPack: { requests: number } | null }; state: string }

const monthName = (m: string) => new Date(`${m}-15T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export default function UsagePage() {
  return (
    <Suspense>
      <Usage />
    </Suspense>
  );
}

function Usage() {
  const orgId = useOrgId();
  const usage = useQuery({ queryKey: ['usage', orgId], queryFn: () => api<Usage>(`/v1/orgs/${orgId}/usage`) });
  const u = usage.data;
  const peak = Math.max(1, ...(u?.days ?? []).map((d) => d.ai + d.uploads));
  return (
    <>
      <PageHeader
        title="Usage"
        description={u ? <>What this organisation used in {monthName(u.month)} against its {u.plan ?? ''} plan. The counts start again on {date(new Date(new Date(u.resetsAt).getTime() + 330 * 60_000).toISOString().slice(0, 10))}. <Link className="text-accent hover:underline" href={`/orgs/${orgId}/settings/subscription`}>Change plan</Link></> : null}
      />
      {u ? (
        <>
          <div className="mb-6 grid gap-4 md:grid-cols-2">
            <UsageMeter label="AI requests" level={u.ai} unit="requests" detail={`Each answered call to the AI model counts once, whichever agent made it. ${(u.ai.inputTokens + u.ai.outputTokens).toLocaleString('en-IN')} tokens this month.${u.ai.extra ? ` ${u.ai.extra.toLocaleString('en-IN')} more came from extra requests you bought.` : ''}`} />
            <UsageMeter label="Uploads" level={u.uploads} unit="files" detail={`Receipts and documents attached to records; ${bytes(u.uploads.bytes)} this month.`} />
          </div>
          <Card className="mb-6" aria-label="This month by day">
            <CardHeader title="This month by day" description="AI requests and uploads each day, India time." />
            <div className="flex h-40 items-end gap-1 px-5 pb-2 pt-4">
              {u.days.map((d) => (
                <div key={d.day} className="flex flex-1 flex-col justify-end" title={`${d.day}: ${d.ai} AI requests, ${d.uploads} uploads`}>
                  <div className="rounded-t bg-violet/70" style={{ height: `${(d.uploads / peak) * 120}px` }} />
                  <div className="bg-accent/80" style={{ height: `${(d.ai / peak) * 120}px` }} />
                </div>
              ))}
            </div>
            <div className="flex justify-between px-5 pb-4 text-xs text-fg-muted"><span>{u.days[0]?.day.slice(8)}</span><span className="flex gap-3"><span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-accent/80" />AI requests</span><span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-violet/70" />Uploads</span></span><span>{u.days.at(-1)?.day.slice(8)}</span></div>
          </Card>
          {u.credits && u.ai.limit !== null ? <ExtraRequests credits={u.credits} /> : null}
          <Card aria-label="Earlier months">
            <CardHeader title="Earlier months" />
            <Table>
              <thead><tr><Th>Month</Th><Th numeric>AI requests</Th><Th numeric>Tokens</Th><Th numeric>Uploads</Th></tr></thead>
              <tbody>
                {u.history.map((h) => (
                  <Tr key={h.month}>
                    <Td>{monthName(h.month)}</Td>
                    <Td numeric>{h.ai.toLocaleString('en-IN')}</Td>
                    <Td numeric>{h.tokens.toLocaleString('en-IN')}</Td>
                    <Td numeric>{h.uploads.toLocaleString('en-IN')}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      ) : null}
    </>
  );
}

/** Extra AI requests (SUBS-018): what is left of the packs bought, and buying another. */
function ExtraRequests({ credits }: { credits: Credits }) {
  const orgId = useOrgId();
  const { org } = useOrg();
  const qc = useQueryClient();
  const manage = can(org?.role, 'org.manage');
  const [choice, setChoice] = useState<string | null>(null);
  const quote = useQuery({ queryKey: ['credits-quote', orgId, choice], queryFn: () => api<CreditQuote>(`/v1/orgs/${orgId}/subscription/credits/quote?pack=${choice}`), enabled: !!choice, retry: false });
  const buy = useMutation({ mutationFn: (pack: string) => api<{ url: string }>(`/v1/orgs/${orgId}/subscription/credits/checkout`, { method: 'POST', body: { pack } }), onSuccess: (r) => window.location.assign(r.url) });
  // Coming back from the gateway's payment page: ask it whether the payment went through.
  const params = useSearchParams();
  const router = useRouter();
  const returned = params.get('invoice');
  const cancelled = params.get('cancelled') === '1';
  const check = useMutation({ mutationFn: (id: string) => api<PaidCheck>(`/v1/orgs/${orgId}/subscription/invoices/${id}/check`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['usage', orgId] }) });
  const { mutate: checkNow } = check;
  useEffect(() => {
    if (returned && !cancelled) checkNow(returned);
  }, [returned, cancelled, checkNow]);
  return (
    <Card className="mb-6" aria-label="Extra AI requests">
      <CardHeader title="Extra AI requests" description="When this month's AI requests in your plan run out, the AI assistant goes on using requests you bought, from the pack that expires first. Each pack lasts a year from payment." />
      <div className="px-5 pb-5 pt-2">
        {returned ? (
          <div className="mb-4" aria-label="Payment result">
            {cancelled ? (
              <Alert tone="warning" title="Payment cancelled">Nothing was charged.</Alert>
            ) : check.data?.state === 'paid' ? (
              <Alert tone="positive" title="Payment received">
                {check.data.invoice.creditPack?.requests.toLocaleString('en-IN')} AI requests added. Tax invoice {check.data.invoice.number} for <Money value={check.data.invoice.total} currency={check.data.invoice.currency} />.{' '}
                <Link className="underline" href={`/orgs/${orgId}/settings/subscription/invoices/${check.data.invoice.id}`}>View the invoice</Link>
              </Alert>
            ) : check.data ? (
              <Alert tone="warning" title="Waiting for the payment to be confirmed">
                The payment gateway has not confirmed the payment yet ({check.data.state}).{' '}
                <Button variant="ghost" size="sm" loading={check.isPending} onClick={() => check.mutate(returned)}>Check again</Button>
              </Alert>
            ) : (
              <ErrorAlert title="Could not check the payment" error={check.error} />
            )}
            <button type="button" className="mt-2 text-xs text-fg-muted underline" onClick={() => router.replace(`/orgs/${orgId}/settings/usage`)}>Dismiss</button>
          </div>
        ) : null}
        <p className="font-mono text-2xl tabular-nums" data-testid="credit-balance">{credits.balance.toLocaleString('en-IN')}<span className="text-base text-fg-muted"> extra requests left</span></p>
        {credits.packs.length ? (
          <div className="mt-4 flex flex-wrap gap-3">
            {credits.packs.map((p) => (
              <div key={p.id} className="min-w-48 rounded-[var(--t2t-radius-md)] border border-line p-4" aria-label={`Pack ${p.name}`}>
                <p className="font-medium">{p.name}</p>
                <p className="text-sm"><Money value={p.price} currency={p.currency} /> plus tax</p>
                <p className="text-xs text-fg-muted">{p.requests.toLocaleString('en-IN')} requests, <Money value={p.perRequest} currency={p.currency} /> each</p>
                {manage ? <Button className="mt-2" size="sm" variant={choice === p.id ? 'primary' : 'secondary'} onClick={() => setChoice(p.id)}>Choose</Button> : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-fg-muted">Talk2Tax has no packs of extra requests on offer at the moment. A larger plan has more AI requests each month.</p>
        )}
        {!manage && credits.packs.length ? <p className="mt-2 text-xs text-fg-muted">Owners and administrators can buy extra requests.</p> : null}
        {choice ? (
          <div className="mt-4 max-w-md rounded-[var(--t2t-radius-md)] border border-line p-4" aria-label="Pack total">
            <ErrorAlert title="Cannot buy this pack" error={quote.error ?? buy.error} />
            {quote.data ? (
              <>
                <table className="w-full text-sm">
                  <tbody>
                    <tr><td>{quote.data.pack.name}</td><td className="text-right num"><Money value={quote.data.subtotal} currency={quote.data.currency} /></td></tr>
                    {quote.data.lines.map((l) => <tr key={l.code}><td>{l.code} {l.rate}%</td><td className="text-right num"><Money value={l.amount} currency={quote.data!.currency} /></td></tr>)}
                    <tr className="font-medium"><td>Total</td><td className="text-right num"><Money value={quote.data.total} currency={quote.data.currency} /></td></tr>
                  </tbody>
                </table>
                <p className="mt-1 text-xs text-fg-muted">{quote.data.note}</p>
                {quote.data.payOnline ? (
                  <Button className="mt-3" loading={buy.isPending} onClick={() => buy.mutate(quote.data!.pack.id)}>Pay <Money value={quote.data.total} currency={quote.data.currency} /></Button>
                ) : (
                  <p className="mt-2 text-sm text-fg-muted">Online payment is not set up yet, so packs cannot be bought for now.</p>
                )}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      {credits.bought.length ? (
        <Table>
          <thead><tr><Th>Pack</Th><Th>Bought</Th><Th numeric>Used</Th><Th numeric>Left</Th><Th>Expires</Th></tr></thead>
          <tbody>
            {credits.bought.map((g) => (
              <Tr key={g.id}>
                <Td><Link className="underline" href={`/orgs/${orgId}/settings/subscription/invoices/${g.invoiceId}`}>{g.name}</Link></Td>
                <Td>{date(g.grantedAt.slice(0, 10))}</Td>
                <Td numeric>{g.used.toLocaleString('en-IN')} of {g.requests.toLocaleString('en-IN')}</Td>
                <Td numeric>{g.left.toLocaleString('en-IN')}</Td>
                <Td>{g.expired ? <Badge tone="neutral">Expired</Badge> : date(g.expiresAt.slice(0, 10))}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </Card>
  );
}
