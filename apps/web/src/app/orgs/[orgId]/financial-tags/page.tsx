'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, SectionHelpSlot } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useFinancialTags, type FinancialTag, type FinancialTagValue } from '@/lib/financial-tags';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

type Row = FinancialTagValue & { saved: boolean };

/** Locations and other financial tags (GL-028, GL-031) that journal lines are tagged with. */
export default function FinancialTagsPage() {
  const { org, orgId } = useOrg();
  const q = useFinancialTags();
  const [adding, setAdding] = useState<{ key: string; label: string } | null>(null);
  if (!org) return null;
  const manage = can(org.role, 'accounts.manage');
  const items = q.data?.items ?? [];
  return (
    <>
      <PageHeader
        title="Locations and tags"
        description="Tag journal lines with a location, business unit or any tag you define, then see profit for each value. Values are switched off, never removed, so old lines keep their name in reports."
        actions={<Link href={`/orgs/${orgId}/reports/profit-by-dimension`}><Button variant="secondary">Profit by tag</Button></Link>}
      />
      <ErrorAlert title="Could not load tags" error={q.error} />
      {manage && q.data && !adding ? (
        <Card className="mb-4">
          <CardHeader title="Add a tag" description="Start from a common one or name your own." />
          <div className="flex flex-wrap gap-2 p-5">
            {q.data.presets.map((p) => <Button key={p.key} size="sm" variant="secondary" onClick={() => setAdding(p)}>{p.label}</Button>)}
            <Button size="sm" variant="ghost" onClick={() => setAdding({ key: '', label: '' })}>Another tag</Button>
          </div>
        </Card>
      ) : null}
      {adding ? <TagEditor orgId={orgId} start={adding} onDone={() => setAdding(null)} /> : null}
      {q.data && !items.length && !adding ? (
        <Card><EmptyState title="No tags yet">Add Location to split profit by office, store or branch.</EmptyState></Card>
      ) : null}
      {items.map((t) => <TagCard key={t.id} orgId={orgId} tag={t} manage={manage} />)}
    </>
  );
}

function TagCard({ orgId, tag, manage }: { orgId: string; tag: FinancialTag; manage: boolean }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <TagEditor orgId={orgId} tag={tag} onDone={() => setEditing(false)} />;
  return (
    <Card className="mb-4">
      <CardHeader
        title={tag.label}
        help={<SectionHelpSlot title="Tag values" />}
        description={`Key ${tag.key} · ${tag.values.filter((v) => v.isActive).length} active of ${tag.values.length}`}
        actions={<div className="flex items-center gap-2">{tag.isActive ? null : <Badge tone="warning">Not in use</Badge>}{manage ? <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit</Button> : null}</div>}
      />
      {tag.values.length ? (
        <ul className="flex flex-wrap gap-2 p-5" aria-label={`${tag.label} values`}>
          {tag.values.map((v) => (
            <li key={v.code} className={`rounded border px-2 py-1 text-sm ${v.isActive ? 'border-border' : 'border-dashed border-border text-fg-faint'}`}>
              <span className="num text-xs text-fg-muted">{v.code}</span> {v.name}{v.isActive ? '' : ' (inactive)'}
            </li>
          ))}
        </ul>
      ) : <p className="p-5 text-sm text-fg-muted">No values yet.</p>}
    </Card>
  );
}

function TagEditor({ orgId, tag, start, onDone }: { orgId: string; tag?: FinancialTag; start?: { key: string; label: string }; onDone: () => void }) {
  const qc = useQueryClient();
  const [key, setKey] = useState(tag?.key ?? start?.key ?? '');
  const [label, setLabel] = useState(tag?.label ?? start?.label ?? '');
  const [isActive, setActive] = useState(tag?.isActive ?? true);
  const [rows, setRows] = useState<Row[]>(tag ? tag.values.map((v) => ({ ...v, saved: true })) : [{ code: '', name: '', isActive: true, saved: false }]);
  const save = useMutation({
    mutationFn: () => {
      const values = rows.filter((r) => r.saved || r.code || r.name).map(({ code, name, isActive }) => ({ code, name, isActive }));
      return tag
        ? api<FinancialTag>(`/v1/orgs/${orgId}/financial-tags/${tag.id}`, { method: 'PUT', body: { label, isActive, values } })
        : api<FinancialTag>(`/v1/orgs/${orgId}/financial-tags`, { method: 'POST', body: { key, label, values } });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['financial-tags', orgId] });
      onDone();
    },
  });
  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Card className="mb-4">
      <CardHeader title={tag ? `Edit ${tag.label}` : 'New tag'} help={<SectionHelpSlot title="New tag" />} description={tag ? 'The key stays the same. Switch a value off to stop new lines using it.' : 'The key is what lines store, such as location. It cannot change later.'} />
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">{(p) => <Input {...p} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Location" required maxLength={60} />}</Field>
          <Field label="Key" hint="Lower case letters, digits and _">{(p) => <Input {...p} value={key} onChange={(e) => setKey(e.target.value)} placeholder="location" disabled={!!tag} required maxLength={32} />}</Field>
        </div>
        <fieldset>
          <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">Values</legend>
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[8rem_1fr_auto] items-center gap-2">
                <Input aria-label={`Code for value ${i + 1}`} value={r.code} disabled={r.saved} onChange={(e) => set(i, { code: e.target.value.toUpperCase() })} placeholder="PUNE" maxLength={20} />
                <Input aria-label={`Name for value ${i + 1}`} value={r.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="Pune office" maxLength={100} />
                {r.saved ? (
                  <label className="flex items-center gap-1.5 whitespace-nowrap text-sm text-fg-muted">
                    <input type="checkbox" checked={r.isActive} onChange={(e) => set(i, { isActive: e.target.checked })} aria-label={`${r.code} in use`} /> In use
                  </label>
                ) : (
                  <Button type="button" size="sm" variant="ghost" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label={`Remove value ${i + 1}`}>Remove</Button>
                )}
              </div>
            ))}
          </div>
          <Button type="button" size="sm" variant="ghost" className="mt-2" onClick={() => setRows((rs) => [...rs, { code: '', name: '', isActive: true, saved: false }])}>Add a value</Button>
        </fieldset>
        {tag ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isActive} onChange={(e) => setActive(e.target.checked)} /> Offer this tag on new lines
          </label>
        ) : null}
        <ErrorAlert title="Could not save the tag" error={save.error as Error | null} />
        <div className="flex gap-2">
          <Button type="submit" disabled={save.isPending}>{tag ? 'Save' : 'Add tag'}</Button>
          <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
