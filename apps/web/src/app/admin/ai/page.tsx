'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useMeWithRole } from '@/lib/admin';
import { dateTime } from '@/lib/format';

type Status = { stopped: boolean; reason: string | null; since: string | null; history: { id: string; action: 'STOPPED' | 'RESUMED'; reason: string; by: string; at: string }[] };

/** The platform-wide AI emergency shutdown (SEC-038). */
export default function AdminAiPage() {
  const qc = useQueryClient();
  const me = useMeWithRole();
  const q = useQuery({ queryKey: ['admin-ai'], queryFn: () => api<Status>('/v1/admin/ai') });
  const [reason, setReason] = useState('');
  const change = useMutation({
    mutationFn: (action: 'stop' | 'resume') => api<Status>(`/v1/admin/ai/${action}`, { method: 'POST', body: { reason: reason.trim() } }),
    onSuccess: (s) => { setReason(''); qc.setQueryData(['admin-ai'], s); },
  });
  const manage = me.data?.user.platformRole === 'SUPER_ADMIN';
  const s = q.data;
  return (
    <>
      <PageHeader title="AI shutdown" description="Stops AI for every organisation at once, for an incident with the AI provider or with how the agents behave. Every agent checks before each call to the AI model, so work already running stops too, and nothing more is sent until AI is turned back on here. Organisations see the reason." />
      <ErrorAlert title="Could not load the AI shutdown" error={q.error} />
      <ErrorAlert title="That did not work" error={change.error} />
      {s ? (
        <>
          <div className="mb-4">
            {s.stopped ? (
              <Alert tone="negative" title="AI is stopped for everyone">Since {s.since ? dateTime(s.since) : '—'}: {s.reason}</Alert>
            ) : (
              <Alert tone="positive" title="AI is running">Each organisation's own switches, budgets and stop still apply.</Alert>
            )}
          </div>
          {manage ? (
            <Card className="mb-6" aria-label={s.stopped ? 'Turn AI back on' : 'Stop AI for everyone'}>
              <CardHeader title={s.stopped ? 'Turn AI back on' : 'Stop AI for everyone'} description="Give the reason; it is kept in the history and the audit trail, and stopping shows it to every organisation." />
              <form className="flex flex-wrap items-end gap-3 px-5 pb-5 pt-4" onSubmit={(e) => { e.preventDefault(); change.mutate(s.stopped ? 'resume' : 'stop'); }}>
                <Field label="Reason">{(p) => <Input {...p} className="w-[30rem]" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={s.stopped ? 'e.g. The provider confirmed the incident is over.' : 'e.g. Provider incident under investigation.'} />}</Field>
                <Button type="submit" variant={s.stopped ? 'primary' : 'danger'} disabled={reason.trim().length < 10} loading={change.isPending}>{s.stopped ? 'Turn AI back on' : 'Stop AI for everyone'}</Button>
              </form>
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Shutdown history" description="Every stop and resume, newest first. It cannot be changed." />
            {!s.history.length ? <EmptyState title="Never stopped">AI has not been stopped for everyone.</EmptyState> : (
              <Table aria-label="Shutdown history">
                <thead><tr><Th>When</Th><Th>What</Th><Th>Reason</Th><Th>By</Th></tr></thead>
                <tbody>
                  {s.history.map((h) => (
                    <Tr key={h.id}>
                      <Td className="whitespace-nowrap">{dateTime(h.at)}</Td>
                      <Td>{h.action === 'STOPPED' ? <Badge tone="negative">Stopped</Badge> : <Badge tone="positive">Resumed</Badge>}</Td>
                      <Td>{h.reason}</Td>
                      <Td>{h.by}</Td>
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
