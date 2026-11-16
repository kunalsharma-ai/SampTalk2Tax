'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { COUNTRY_PRESETS, INVOICE_THEMES, layoutFromPreset, paletteById, renderInvoiceDocument, sampleInvoiceSource, type InvoiceTheme, type PresetId, type TemplateEngine } from '@talk2tax/accounting-engine';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { InvoiceFrame } from '@/components/invoice-templates/invoice-frame';
import { Swatches, ThemePicker, PalettePicker } from '@/components/invoice-templates/pickers';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useTemplates, type TemplateDetail, type TemplateSummary } from '@/lib/invoice-templates';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

export default function InvoiceTemplatesPage() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const q = useTemplates(showArchived);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [presetId, setPresetId] = useState<PresetId | ''>('');
  const [theme, setTheme] = useState<InvoiceTheme | null>(null);
  const [paletteId, setPaletteId] = useState<string | null>(null);
  const [engine, setEngine] = useState<TemplateEngine>('LAYOUT');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['invoice-templates', orgId] });
  const preset = presetId || q.data?.suggestedPresetId || 'GENERIC';
  const manage = !!org && can(org.role, 'templates.manage');

  const create = useMutation({
    mutationFn: () => api<TemplateDetail>(`/v1/orgs/${orgId}/invoice-templates`, { method: 'POST', body: { name, presetId: preset, theme, paletteId, engine } }),
    onSuccess: (t) => {
      refresh();
      router.push(`/orgs/${orgId}/settings/invoice-templates/${t.id}`);
    },
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'default' | 'duplicate' | 'archive' | 'restore' }) =>
      action === 'duplicate'
        ? api(`/v1/orgs/${orgId}/invoice-templates/${id}/duplicate`, { method: 'POST', body: {} })
        : action === 'default'
          ? api(`/v1/orgs/${orgId}/invoice-templates/${id}/default`, { method: 'POST' })
          : api(`/v1/orgs/${orgId}/invoice-templates/${id}/archive`, { method: 'POST', body: { archived: action === 'archive' } }),
    onSuccess: refresh,
  });

  const previewHtml = useMemo(() => {
    const p = COUNTRY_PRESETS.find((x) => x.id === preset)!;
    const layout = layoutFromPreset(preset, { theme: theme ?? undefined, palette: paletteId ? paletteById(paletteId) : undefined });
    const src = { ...sampleInvoiceSource(preset), seller: { ...sampleInvoiceSource(preset).seller, name: org?.name ?? 'Your Business', legalName: null } };
    return { html: renderInvoiceDocument({ engine: 'LAYOUT', layout }, src), preset: p };
  }, [preset, theme, paletteId, org?.name]);

  if (!org) return null;
  const items = q.data?.items ?? [];
  return (
    <>
      <PageHeader
        title="Invoice templates"
        description="How invoices and credit notes look when printed, saved as PDF or e-signed. Start from a country preset, pick a theme and colours, then change any section, or write your own HTML. Every invoice prints with the default template unless you choose another for it."
        actions={
          <>
            <Link href={`/orgs/${orgId}/settings/signature`}><Button variant="secondary">My signature</Button></Link>
            {manage && !creating ? <Button onClick={() => { create.reset(); setName(''); setCreating(true); }}>New template</Button> : null}
          </>
        }
      />
      <ErrorAlert title="Could not load the templates" error={q.error} />
      <ErrorAlert title="That did not work" error={act.error} />

      {creating ? (
        <Card className="mb-4 p-4">
          <CardHeader title="New template" description="Every choice here can be changed afterwards in the designer." />
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate();
              }}
            >
              <ErrorAlert title="Could not create the template" error={create.error} />
              <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="Tax invoice, export invoice…" required maxLength={120} />}</Field>
              <Field label="Country preset" hint={previewHtml.preset.summary}>
                {(p) => (
                  <Select {...p} value={preset} onChange={(e) => { setPresetId(e.target.value as PresetId); setTheme(null); setPaletteId(null); }}>
                    {COUNTRY_PRESETS.map((c) => <option key={c.id} value={c.id}>{c.name}{c.id === q.data?.suggestedPresetId ? ' (suggested)' : ''}</option>)}
                  </Select>
                )}
              </Field>
              <div>
                <div className="mb-1.5 text-sm font-medium text-fg">Theme</div>
                <ThemePicker value={theme ?? previewHtml.preset.theme} onChange={setTheme} />
              </div>
              <div>
                <div className="mb-1.5 text-sm font-medium text-fg">Colour palette</div>
                <PalettePicker value={paletteId ?? previewHtml.preset.paletteId} onChange={setPaletteId} />
              </div>
              <fieldset>
                <legend className="mb-1.5 text-sm font-medium text-fg">Build with</legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {([['LAYOUT', 'The designer', 'Sections, columns, labels and colours with point and click.'], ['HTML', 'My own HTML', 'Write HTML and CSS with placeholders such as {{doc.number}}; starts from a working example.']] as const).map(([v, t, d]) => (
                    <label key={v} className={`cursor-pointer rounded-md border p-3 text-sm ${engine === v ? 'border-accent bg-accent/10' : 'border-line hover:bg-surface-hover'}`}>
                      <input type="radio" name="engine" className="sr-only" checked={engine === v} onChange={() => setEngine(v)} />
                      <span className="font-medium text-fg">{t}</span>
                      <span className="mt-0.5 block text-xs text-fg-muted">{d}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="flex gap-2">
                <Button type="submit" loading={create.isPending}>Create and open the designer</Button>
                <Button type="button" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
              </div>
            </form>
            <div>
              <div className="mb-1.5 text-sm font-medium text-fg">Preview with a sample invoice</div>
              <InvoiceFrame html={previewHtml.html} title="Template preview" scale={0.62} />
            </div>
          </div>
        </Card>
      ) : null}

      <Card className="p-4">
        <CardHeader
          title={showArchived ? 'All templates, including archived' : 'Templates'}
          actions={<label className="flex items-center gap-2 text-sm text-fg-muted"><input type="checkbox" className="accent-[var(--t2t-accent)]" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>}
        />
        {q.data && !items.length ? (
          <EmptyState title="No templates yet">
            Invoices print with the built-in {COUNTRY_PRESETS.find((c) => c.id === q.data.suggestedPresetId)?.name} layout until you create one. The first template you create becomes the default.
          </EmptyState>
        ) : null}
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3" aria-label="Invoice templates">
          {items.map((t) => (
            <TemplateCard key={t.id} t={t} orgId={orgId} manage={manage} busy={act.isPending} onAction={(action) => act.mutate({ id: t.id, action })} />
          ))}
        </ul>
      </Card>
    </>
  );
}

function TemplateCard({ t, orgId, manage, busy, onAction }: { t: TemplateSummary; orgId: string; manage: boolean; busy: boolean; onAction: (a: 'default' | 'duplicate' | 'archive' | 'restore') => void }) {
  const theme = INVOICE_THEMES.find((x) => x.id === t.theme)?.name ?? t.theme;
  return (
    <li className="rounded-lg border border-line bg-surface-raised p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={`/orgs/${orgId}/settings/invoice-templates/${t.id}`} className="font-medium text-fg hover:underline">{t.name}</Link>
          <div className="text-xs text-fg-muted">{t.presetName}</div>
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {t.isDefault ? <Badge tone="positive">Default</Badge> : null}
          {t.archived ? <Badge>Archived</Badge> : null}
          <Badge tone={t.engine === 'HTML' ? 'violet' : 'accent'}>{t.engine === 'HTML' ? 'HTML' : theme}</Badge>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Swatches palette={t.palette} />
        <span className="truncate text-sm text-fg-muted">“{t.title}”</span>
      </div>
      <div className="mt-2 text-xs text-fg-faint">
        {t.documentsUsing ? `${t.documentsUsing} invoice${t.documentsUsing === 1 ? '' : 's'} chosen to use it · ` : ''}
        {t.hasLogo ? 'Logo · ' : ''}Changed {date(t.updatedAt.slice(0, 10))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link href={`/orgs/${orgId}/settings/invoice-templates/${t.id}`}><Button size="sm" variant="secondary">{manage && !t.archived ? 'Design' : 'View'}</Button></Link>
        {manage && !t.archived ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('duplicate')}>Duplicate</Button> : null}
        {manage && !t.archived && !t.isDefault ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('default')}>Make default</Button> : null}
        {manage && !t.archived && !t.isDefault ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => confirm(`Archive ${t.name}? It can be restored later.`) && onAction('archive')}>Archive</Button> : null}
        {manage && t.archived ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('restore')}>Restore</Button> : null}
      </div>
    </li>
  );
}
