'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { date, dateTime } from '@/lib/format';

interface PortalLink {
  id: string;
  prefix: string;
  note: string | null;
  state: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  createdAt: string;
  createdBy: string;
  expiresAt: string | null;
  lastSeenAt: string | null;
  viewCount: number;
  revokedAt: string | null;
  revokedBy: string | null;
}
const TONE = { ACTIVE: 'positive', EXPIRED: 'neutral', REVOKED: 'negative' } as const;
const LABEL = { ACTIVE: 'Active', EXPIRED: 'Expired', REVOKED: 'Revoked' } as const;

/** Vendor portal links for one vendor (AP-013): make one to send, see when it was opened, revoke it. */
export function VendorPortalCard({ orgId, contactId, vendorName, canManage, active }: { orgId: string; contactId: string; vendorName: string; canManage: boolean; active: boolean }) {
  const qc = useQueryClient();
  const url = `/v1/orgs/${orgId}/contacts/${contactId}/vendor-portal-links`;
  const key = ['vendor-portal-links', orgId, contactId];
  const q = useQuery({ queryKey: key, queryFn: () => api<PortalLink[]>(url) });
  const [making, setMaking] = useState(false);
  const revoke = useMutation({ mutationFn: (id: string) => api<PortalLink[]>(`${url}/${id}/revoke`, { method: 'POST' }), onSuccess: (d) => qc.setQueryData(key, d) });
  const links = q.data ?? [];
  const sent = useQuery({ queryKey: ['vendor-invoices', orgId, contactId], queryFn: () => api<{ counts: { received: number; recorded: number; rejected: number } }>(`/v1/orgs/${orgId}/purchases/vendor-invoices?contactId=${contactId}`) });
  const c = sent.data?.counts;
  return (
    <Card className="mt-6" role="region" aria-label="Vendor portal">
      <CardHeader
        title="Vendor portal"
        description={`A private link ${vendorName} can open, without signing in, to see their invoices as recorded and when they fall due, payments made to them, open purchase orders and their statement, and to send an invoice for you to check. Anyone with the link can see it; revoke it if it goes to the wrong person.`}
        actions={canManage && active ? <Button size="sm" variant="secondary" onClick={() => setMaking(true)}>Make portal link</Button> : null}
      />
      <div className="px-5 pb-5">
        {q.error ? <Alert title="Could not load portal links">{q.error.message}</Alert> : null}
        {revoke.error ? <Alert title="Could not revoke">{revoke.error.message}</Alert> : null}
        {links.length ? (
          <Table aria-label="Portal links">
            <thead><Tr><Th>Link</Th><Th>Made</Th><Th>Works until</Th><Th>Opened</Th><Th>Status</Th><Th /></Tr></thead>
            <tbody>
              {links.map((l) => (
                <Tr key={l.id}>
                  <Td><span className="font-mono text-xs">…/vendor-portal/t2tv_{l.prefix}…</span>{l.note ? <span className="block text-xs text-fg-muted">{l.note}</span> : null}</Td>
                  <Td className="text-sm">{date(l.createdAt.slice(0, 10))}<span className="block text-xs text-fg-muted">by {l.createdBy}</span></Td>
                  <Td className="text-sm">{l.expiresAt ? date(l.expiresAt.slice(0, 10)) : 'No expiry'}</Td>
                  <Td className="text-sm">{l.viewCount ? <>{l.viewCount} {l.viewCount === 1 ? 'time' : 'times'}<span className="block text-xs text-fg-muted">last {dateTime(l.lastSeenAt!)}</span></> : 'Not yet'}</Td>
                  <Td><Badge tone={TONE[l.state]}>{LABEL[l.state]}</Badge>{l.revokedBy ? <span className="block text-xs text-fg-muted">by {l.revokedBy}</span> : null}</Td>
                  <Td className="text-right">{canManage && l.state === 'ACTIVE' ? <Button size="sm" variant="ghost" loading={revoke.isPending && revoke.variables === l.id} onClick={() => confirm('Revoke this link? It stops working at once.') && revoke.mutate(l.id)}>Revoke</Button> : null}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : q.data ? <p className="text-sm text-fg-muted">No portal links yet.</p> : null}
        {c && c.received + c.recorded + c.rejected > 0 ? (
          <p className="mt-3 text-sm">
            Invoices sent through the portal: {c.received} waiting to be checked, {c.recorded} recorded, {c.rejected} turned down.{' '}
            <Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/vendor-invoices?contactId=${contactId}`}>Open them</Link>
          </p>
        ) : null}
      </div>
      {making ? <MakeDialog url={url} vendorName={vendorName} onClose={() => setMaking(false)} onDone={() => qc.invalidateQueries({ queryKey: key })} /> : null}
    </Card>
  );
}

function MakeDialog({ url, vendorName, onClose, onDone }: { url: string; vendorName: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [days, setDays] = useState('90');
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState(false);
  const make = useMutation({
    mutationFn: () => api<{ token: string; path: string; expiresAt: string | null }>(url, { method: 'POST', body: { expiresInDays: days === 'never' ? null : Number(days), note: note || null } }),
    onSuccess: onDone,
  });
  const full = make.data ? `${window.location.origin}${make.data.path}` : '';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Portal link for ${vendorName}`} description="Send the link to the vendor by email or chat. It is shown only now; if it is lost, revoke it and make another.">
      {make.data ? (
        <div className="flex flex-col gap-4">
          <Field label="Portal link">{(p) => <Input {...p} readOnly value={full} onFocus={(e) => e.target.select()} />}</Field>
          <p className="text-sm text-fg-muted">{make.data.expiresAt ? `It works until ${date(make.data.expiresAt.slice(0, 10))}.` : 'It works until you revoke it.'}</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={async () => { await navigator.clipboard?.writeText(full).catch(() => undefined); setCopied(true); }}>{copied ? 'Copied' : 'Copy link'}</Button>
            <Button type="button" onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); make.mutate(); }}>
          {make.error ? <Alert title="Could not make the link">{make.error.message}</Alert> : null}
          <Field label="Works for">{(p) => <Select {...p} value={days} onChange={(e) => setDays(e.target.value)}><option value="30">30 days</option><option value="90">90 days</option><option value="180">180 days</option><option value="365">A year</option><option value="never">Until revoked</option></Select>}</Field>
          <Field label="Note" hint="For you, such as who it was sent to. The vendor does not see it.">{(p) => <Input {...p} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={make.isPending}>Make link</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
