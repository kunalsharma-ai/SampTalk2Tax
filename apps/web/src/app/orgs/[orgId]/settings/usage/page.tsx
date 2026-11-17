'use client';
import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { PageHeader } from '@/components/shell';
import { bytes, type Level, UsageMeter } from '@/components/usage-meter';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrgId } from '@/lib/org';

interface Usage {
  month: string;
  resetsAt: string;
  plan: string | null;
  ai: Level & { inputTokens: number; outputTokens: number; ownKey: number; talk2taxKey: number };
  uploads: Level & { bytes: number };
  days: { day: string; ai: number; uploads: number }[];
  history: { month: string; ai: number; uploads: number; tokens: number }[];
}

const monthName = (m: string) => new Date(`${m}-15T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export default function UsagePage() {
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
            <UsageMeter label="AI requests" level={u.ai} unit="requests" detail={`Each answered call to the AI model counts once, whichever agent made it. ${(u.ai.inputTokens + u.ai.outputTokens).toLocaleString('en-IN')} tokens this month.`} />
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
