'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { AdminOrg, useMeWithRole } from '@/lib/admin';
import { dateTime } from '@/lib/format';
import { FlagRow } from '@/lib/operations';

function FlagCard({ flag, orgs, manage }: { flag: FlagRow; orgs: AdminOrg[]; manage: boolean }) {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(flag.setting?.enabled ?? flag.defaultOn);
  const [rollout, setRollout] = useState(String(flag.setting?.rolloutPercent ?? 100));
  const [note, setNote] = useState(flag.setting?.note ?? '');
  const [ov, setOv] = useState({ orgId: '', enabled: 'false', reason: '' });
  const done = async () => { await qc.invalidateQueries({ queryKey: ['admin-flags'] }); await qc.invalidateQueries({ queryKey: ['org-flags'] }); };
  const save = useMutation({ mutationFn: () => api(`/v1/admin/flags/${flag.key}`, { method: 'PUT', body: { enabled, rolloutPercent: Number(rollout), note: note.trim() || null } }), onSuccess: done });
  const reset = useMutation({ mutationFn: () => api(`/v1/admin/flags/${flag.key}`, { method: 'DELETE' }), onSuccess: async () => { setEnabled(flag.defaultOn); setRollout('100'); setNote(''); await done(); } });
  const addOverride = useMutation({ mutationFn: () => api(`/v1/admin/flags/${flag.key}/organisations/${ov.orgId}`, { method: 'PUT', body: { enabled: ov.enabled === 'true', reason: ov.reason } }), onSuccess: async () => { setOv({ orgId: '', enabled: 'false', reason: '' }); await done(); } });
  const removeOverride = useMutation({ mutationFn: (orgId: string) => api(`/v1/admin/flags/${flag.key}/organisations/${orgId}`, { method: 'DELETE' }), onSuccess: done });
  const state = flag.setting ? (flag.setting.enabled ? (flag.setting.rolloutPercent === 100 ? 'On for everyone' : `Rolling out to ${flag.setting.rolloutPercent}%`) : 'Off') : flag.defaultOn ? 'On (default)' : 'Off (default)';
  const tone = flag.setting && !flag.setting.enabled ? 'negative' : flag.setting && flag.setting.rolloutPercent < 100 ? 'warning' : 'positive';
  return (
    <Card className="mb-6" aria-label={flag.name}>
      <CardHeader
        title={flag.name}
        description={
          <>
            {flag.description} <span className="font-mono text-xs text-fg-faint">{flag.key}</span>
          </>
        }
        actions={<div className="flex items-center gap-2"><span data-testid="flag-state"><Badge tone={tone}>{state}</Badge></span><span className="text-sm text-fg-muted">on for {flag.organisations.on} of {flag.organisations.total} organisations</span></div>}
      />
      <div className="px-5 pb-5 pt-3">
        {flag.setting ? <p className="mb-3 text-xs text-fg-muted">Last changed {dateTime(flag.setting.updatedAt)} by {flag.setting.updatedBy}{flag.setting.note ? `: ${flag.setting.note}` : ''}</p> : null}
        {manage ? (
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <Field label="Switch">
              {(p) => (
                <Select {...p} className="w-32" value={enabled ? 'on' : 'off'} onChange={(e) => setEnabled(e.target.value === 'on')}>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </Select>
              )}
            </Field>
            <Field label="Rollout %">{(p) => <Input {...p} type="number" min={0} max={100} step={1} className="w-24" disabled={!enabled} value={rollout} onChange={(e) => setRollout(e.target.value)} />}</Field>
            <Field label="Note">{(p) => <Input {...p} className="w-72" maxLength={500} placeholder="Why (kept with the change)" value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
            <Button type="submit" loading={save.isPending}>Save</Button>
            {flag.setting ? <Button type="button" variant="ghost" loading={reset.isPending} onClick={() => reset.mutate()}>Back to default</Button> : null}
          </form>
        ) : null}
        <ErrorAlert title="Not saved" error={save.error ?? reset.error ?? addOverride.error ?? removeOverride.error} />
        <h3 className="mb-2 mt-5 text-sm font-medium">Organisations with their own setting</h3>
        {flag.overrides.length ? (
          <Table>
            <thead><tr><Th>Organisation</Th><Th>Setting</Th><Th>Why</Th><Th>By</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody>
              {flag.overrides.map((o) => (
                <Tr key={o.orgId}>
                  <Td>{o.orgName ?? o.orgId}</Td>
                  <Td><Badge tone={o.enabled ? 'positive' : 'negative'}>{o.enabled ? 'Always on' : 'Always off'}</Badge></Td>
                  <Td className="text-sm">{o.reason}</Td>
                  <Td className="text-sm text-fg-muted">{o.createdBy} · {dateTime(o.createdAt)}</Td>
                  <Td className="text-right">{manage ? <Button variant="ghost" size="sm" onClick={() => removeOverride.mutate(o.orgId)}>Remove</Button> : null}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="text-sm text-fg-muted">None. Every organisation follows the setting above.</p>}
        {manage ? (
          <form className="mt-3 flex flex-wrap items-end gap-3" aria-label={`Set ${flag.name} for one organisation`} onSubmit={(e) => { e.preventDefault(); addOverride.mutate(); }}>
            <Field label="Organisation">
              {(p) => (
                <Select {...p} className="w-72" value={ov.orgId} onChange={(e) => setOv({ ...ov, orgId: e.target.value })}>
                  <option value="">Choose…</option>
                  {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Setting">
              {(p) => (
                <Select {...p} className="w-36" value={ov.enabled} onChange={(e) => setOv({ ...ov, enabled: e.target.value })}>
                  <option value="false">Always off</option>
                  <option value="true">Always on</option>
                </Select>
              )}
            </Field>
            <Field label="Why">{(p) => <Input {...p} className="w-72" maxLength={500} value={ov.reason} onChange={(e) => setOv({ ...ov, reason: e.target.value })} />}</Field>
            <Button type="submit" variant="secondary" disabled={!ov.orgId || !ov.reason.trim()} loading={addOverride.isPending}>Set for organisation</Button>
          </form>
        ) : null}
      </div>
    </Card>
  );
}

/** Switch parts of Talk2Tax on or off, roll them out gradually, or set them for one organisation. */
export default function AdminFlagsPage() {
  const me = useMeWithRole();
  const flags = useQuery({ queryKey: ['admin-flags'], queryFn: () => api<FlagRow[]>('/v1/admin/flags') });
  const orgs = useQuery({ queryKey: ['admin-orgs-all'], queryFn: () => api<AdminOrg[]>('/v1/admin/organisations') });
  const manage = me.data?.user.platformRole === 'SUPER_ADMIN';
  return (
    <>
      <PageHeader title="Feature flags" description="A switched-off module disappears from the menus and the API refuses it (its records stay in place). A rollout serves a share of organisations, chosen by a stable hash, so an organisation keeps its answer as the share grows. An organisation's own setting wins over both. Changes take effect within 10 seconds and are kept in the audit trail." />
      {flags.data?.map((f) => <FlagCard key={`${f.key}-${f.setting?.updatedAt ?? 'default'}`} flag={f} orgs={orgs.data ?? []} manage={manage} />)}
    </>
  );
}
