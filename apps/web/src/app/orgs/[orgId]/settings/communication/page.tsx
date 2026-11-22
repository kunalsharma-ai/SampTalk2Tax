'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';

type Choice = 'ALLOWED' | 'BLOCKED';
type Overview = {
  policy: { automationsToContacts: Choice; updatedAt: string | null; updatedBy: string | null };
  optedOut: { contactId: string; name: string; email: string | null; ledger: 'SALES' | 'PURCHASES'; reason: string; since: string }[];
  canManage: boolean;
};

/** Communication policy (AR-043): what may be emailed to customers and vendors, and who opted out. */
export default function CommunicationPolicyPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/communication-policy`;
  const q = useQuery({ queryKey: ['communication-policy', orgId], queryFn: () => api<Overview>(base) });
  const set = useMutation({ mutationFn: (automationsToContacts: Choice) => api<Overview>(base, { method: 'PUT', body: { automationsToContacts } }), onSuccess: (o) => qc.setQueryData(['communication-policy', orgId], o) });
  if (!org) return null;
  const o = q.data;
  return (
    <>
      <PageHeader
        title="Communication policy"
        description="What Talk2Tax may email to your customers and vendors. A contact who opted out is never emailed, and a reminder drafted by AI goes only after a person approves it."
      />
      <ErrorAlert title="Could not load the communication policy" error={q.error} />
      <ErrorAlert title="The policy was not saved" error={set.error} />
      {o ? (
        <>
          <Card className="mb-4">
            <CardHeader title="Automations and customers" description="Whether automations may email customers and vendors. Emails to your own team are not affected." />
            <div className="flex flex-col gap-3 px-5 pb-5">
              <PolicyForm key={o.policy.automationsToContacts} value={o.policy.automationsToContacts} manage={o.canManage} pending={set.isPending} onSave={(v) => set.mutate(v)} />
              <p className="text-sm text-fg-muted">
                {o.policy.updatedAt ? `Last changed by ${o.policy.updatedBy} on ${dateTime(o.policy.updatedAt)}.` : 'Not changed yet: automations may email contacts who have not opted out.'}
                {o.canManage ? null : ' Only owners and admins can change it.'}
              </p>
              <ul className="list-disc pl-5 text-sm">
                <li>Collection reminders are always drafted for a person to approve; they are never sent by themselves.</li>
                <li>Every email is checked again just before it goes, so a contact who opts out after a draft was written is not emailed.</li>
                <li>Each refused email is recorded in the audit trail.</li>
              </ul>
            </div>
          </Card>
          <Card>
            <CardHeader title="Opted out of email" description="Customers and vendors who asked not to be emailed. Open one to see the record or to record that they want email again." />
            {!o.optedOut.length ? <EmptyState title="No one has opted out">Record an opt-out on the customer's or vendor's page when they ask you to stop emailing.</EmptyState> : (
              <Table aria-label="Opted out of email">
                <thead><tr><Th>Contact</Th><Th>Email</Th><Th>Why</Th><Th>Since</Th></tr></thead>
                <tbody>
                  {o.optedOut.map((c) => (
                    <Tr key={c.contactId}>
                      <Td><Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/${c.ledger === 'SALES' ? 'sales/customers' : 'purchases/vendors'}/${c.contactId}`} prefetch={false}>{c.name}</Link></Td>
                      <Td className="text-sm">{c.email ?? '—'}</Td>
                      <Td className="text-sm">{c.reason}</Td>
                      <Td className="whitespace-nowrap">{dateTime(c.since)}</Td>
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

function PolicyForm({ value, manage, pending, onSave }: { value: Choice; manage: boolean; pending: boolean; onSave: (v: Choice) => void }) {
  const [v, setV] = useState<Choice>(value);
  if (!manage) return <div><Badge tone={value === 'ALLOWED' ? 'positive' : 'warning'}>{value === 'ALLOWED' ? 'Automations may email contacts' : 'Automations never email contacts'}</Badge></div>;
  return (
    <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); onSave(v); }}>
      <Field label="Automations emailing customers and vendors">
        {(p) => (
          <Select {...p} value={v} onChange={(e) => setV(e.target.value as Choice)} className="w-96">
            <option value="ALLOWED">Allowed, except contacts who opted out</option>
            <option value="BLOCKED">Never: automations email only the team</option>
          </Select>
        )}
      </Field>
      <Button type="submit" disabled={v === value} loading={pending}>Save policy</Button>
    </form>
  );
}
