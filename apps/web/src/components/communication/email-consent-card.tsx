'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';

interface Consent {
  contactId: string;
  status: 'OPTED_IN' | 'OPTED_OUT';
  history: { status: 'OPTED_IN' | 'OPTED_OUT'; reason: string; recordedBy: string; recordedAt: string }[];
  canManage: boolean;
}

/** Whether this customer or vendor receives email from the organisation, and the record of each change (AR-043). */
export function EmailConsentCard({ orgId, contactId, name }: { orgId: string; contactId: string; name: string }) {
  const qc = useQueryClient();
  const key = ['email-consent', orgId, contactId];
  const url = `/v1/orgs/${orgId}/contacts/${contactId}/email-consent`;
  const q = useQuery({ queryKey: key, queryFn: () => api<Consent>(url) });
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: (status: Consent['status']) => api<Consent>(url, { method: 'POST', body: { status, reason } }),
    onSuccess: (x) => {
      qc.setQueryData(key, x);
      void qc.invalidateQueries({ queryKey: ['communication-policy', orgId] });
      setReason('');
    },
  });
  if (q.error) return <div className="mt-6"><Alert title="Could not load email consent">{q.error.message}</Alert></div>;
  const d = q.data;
  if (!d) return null;
  const out = d.status === 'OPTED_OUT';
  const next = out ? 'OPTED_IN' : 'OPTED_OUT';
  return (
    <Card className="mt-6" role="region" aria-label="Email consent">
      <CardHeader
        title="Email consent"
        description="Whether reminders, automations and other email from Talk2Tax may go to this contact. Record it when they ask you to stop, or to start again."
        actions={<Badge tone={out ? 'negative' : 'positive'}>{out ? 'Opted out of email' : 'Receives email'}</Badge>}
      />
      <div className="flex flex-col gap-4 px-5 pb-5">
        {out ? <Alert tone="warning" title={`${name} has opted out of email`}>Nothing is emailed to them: collection reminders skip them, automations record the email as not sent, and no one can send them a reminder by hand.</Alert> : null}
        {d.canManage ? (
          <form aria-label={out ? 'Record that they want email again' : 'Record an opt-out'} className="flex flex-col gap-3 rounded-md border border-border p-4" onSubmit={(e) => { e.preventDefault(); save.mutate(next); }}>
            {save.error ? <Alert title="Consent was not recorded">{save.error.message}</Alert> : null}
            <Field label={out ? 'Why they want email again' : 'Why they opted out'} hint="Kept with the record, with your name and the time.">{(p) => <Textarea {...p} rows={2} minLength={3} maxLength={500} required value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
            <div className="flex justify-end"><Button type="submit" variant={out ? 'secondary' : 'danger'} loading={save.isPending}>{out ? 'Start emailing again' : 'Stop emailing'}</Button></div>
          </form>
        ) : null}
        {d.history.length ? (
          <Table aria-label="Consent history">
            <thead><Tr><Th>When</Th><Th>Change</Th><Th>Why</Th><Th>By</Th></Tr></thead>
            <tbody>
              {d.history.map((h) => (
                <Tr key={h.recordedAt}>
                  <Td className="whitespace-nowrap">{dateTime(h.recordedAt)}</Td>
                  <Td>{h.status === 'OPTED_OUT' ? 'Opted out' : 'Opted in'}</Td>
                  <Td className="text-sm">{h.reason}</Td>
                  <Td className="text-sm">{h.recordedBy}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="text-sm text-fg-muted">No change recorded: they receive email.</p>}
      </div>
    </Card>
  );
}
