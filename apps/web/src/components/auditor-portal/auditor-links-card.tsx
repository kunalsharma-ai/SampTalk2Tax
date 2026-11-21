'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { date, dateTime } from '@/lib/format';

interface AuditorLink {
  id: string;
  auditorName: string;
  firm: string | null;
  prefix: string;
  state: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  expiresAt: string;
  createdBy: string;
  createdAt: string;
  lastSeenAt: string | null;
  viewCount: number;
  filesOpened: number;
  revokedAt: string | null;
  revokedBy: string | null;
}
const TONE = { ACTIVE: 'positive', EXPIRED: 'neutral', REVOKED: 'negative' } as const;
const LABEL = { ACTIVE: 'Active', EXPIRED: 'Expired', REVOKED: 'Withdrawn' } as const;

/** External auditor access to one engagement (AUDIT-002): read-only links that always expire. */
export function AuditorLinksCard({ orgId, engagementId, canManage }: { orgId: string; engagementId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const url = `/v1/orgs/${orgId}/audit-engagements/${engagementId}/auditor-links`;
  const key = ['auditor-links', orgId, engagementId];
  const q = useQuery({ queryKey: key, queryFn: () => api<AuditorLink[]>(url) });
  const [making, setMaking] = useState(false);
  const revoke = useMutation({ mutationFn: (id: string) => api<AuditorLink[]>(`${url}/${id}/revoke`, { method: 'POST' }), onSuccess: (d) => qc.setQueryData(key, d) });
  const links = q.data ?? [];
  return (
    <Card className="mb-4" role="region" aria-label="External auditor access">
      <CardHeader
        title="External auditor access"
        description="A private, read-only link for an external auditor, without signing in: this engagement's scope, work and sign-offs, accepted evidence (files can be opened), findings, samples and the trial balance at the end of the scope. Nothing else. It always expires; withdraw it if it goes to the wrong person."
        actions={canManage ? <Button size="sm" variant="secondary" onClick={() => setMaking(true)}>Give auditor access</Button> : null}
      />
      <div className="px-5 pb-5">
        {q.error ? <Alert title="Could not load auditor links">{q.error.message}</Alert> : null}
        {revoke.error ? <Alert title="Could not withdraw">{revoke.error.message}</Alert> : null}
        {links.length ? (
          <Table aria-label="Auditor links">
            <thead><Tr><Th>Auditor</Th><Th>Made</Th><Th>Works until</Th><Th>Opened</Th><Th>Status</Th><Th /></Tr></thead>
            <tbody>
              {links.map((l) => (
                <Tr key={l.id}>
                  <Td>{l.auditorName}{l.firm ? <span className="text-fg-muted">, {l.firm}</span> : null}<span className="block font-mono text-xs text-fg-muted">…/auditor-portal/t2ta_{l.prefix}…</span></Td>
                  <Td className="text-sm">{date(l.createdAt.slice(0, 10))}<span className="block text-xs text-fg-muted">by {l.createdBy}</span></Td>
                  <Td className="text-sm">{date(l.expiresAt.slice(0, 10))}</Td>
                  <Td className="text-sm">{l.viewCount ? <>{l.viewCount} {l.viewCount === 1 ? 'time' : 'times'}, {l.filesOpened} {l.filesOpened === 1 ? 'file' : 'files'}<span className="block text-xs text-fg-muted">last {dateTime(l.lastSeenAt!)}</span></> : 'Not yet'}</Td>
                  <Td><Badge tone={TONE[l.state]}>{LABEL[l.state]}</Badge>{l.revokedBy ? <span className="block text-xs text-fg-muted">by {l.revokedBy}</span> : null}</Td>
                  <Td className="text-right">{canManage && l.state === 'ACTIVE' ? <Button size="sm" variant="ghost" loading={revoke.isPending && revoke.variables === l.id} onClick={() => revoke.mutate(l.id)}>Withdraw</Button> : null}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : q.data ? <p className="text-sm text-fg-muted">No external auditor has access.{canManage ? '' : ' An owner or admin can give it.'}</p> : null}
      </div>
      {making ? <MakeDialog url={url} onClose={() => setMaking(false)} onDone={() => qc.invalidateQueries({ queryKey: key })} /> : null}
    </Card>
  );
}

function MakeDialog({ url, onClose, onDone }: { url: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [form, setForm] = useState({ auditorName: '', firm: '', days: '30' });
  const [copied, setCopied] = useState(false);
  const make = useMutation({
    mutationFn: () => api<{ token: string; path: string; expiresAt: string }>(url, { method: 'POST', body: { auditorName: form.auditorName, firm: form.firm || null, expiresInDays: Number(form.days) } }),
    onSuccess: onDone,
  });
  const full = make.data ? `${window.location.origin}${make.data.path}` : '';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Give an external auditor access" description="Send the link to the auditor. It is shown only now; if it is lost, withdraw it and make another.">
      {make.data ? (
        <div className="flex flex-col gap-4">
          <Field label="Auditor link">{(p) => <Input {...p} readOnly value={full} onFocus={(e) => e.target.select()} />}</Field>
          <p className="text-sm text-fg-muted">It works until {date(make.data.expiresAt.slice(0, 10))}.</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={async () => { await navigator.clipboard?.writeText(full).catch(() => undefined); setCopied(true); }}>{copied ? 'Copied' : 'Copy link'}</Button>
            <Button type="button" onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); make.mutate(); }}>
          {make.error ? <Alert title="Could not make the link">{make.error.message}</Alert> : null}
          <Field label="Auditor's name">{(p) => <Input {...p} maxLength={120} value={form.auditorName} onChange={(e) => setForm({ ...form, auditorName: e.target.value })} />}</Field>
          <Field label="Firm" hint="Optional">{(p) => <Input {...p} maxLength={120} value={form.firm} onChange={(e) => setForm({ ...form, firm: e.target.value })} />}</Field>
          <Field label="Works for">{(p) => <Select {...p} value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></Select>}</Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={form.auditorName.trim().length < 2} loading={make.isPending}>Make link</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
