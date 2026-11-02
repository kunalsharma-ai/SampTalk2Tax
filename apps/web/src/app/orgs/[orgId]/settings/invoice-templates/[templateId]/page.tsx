'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  checkHtmlTemplate,
  COLUMN_KEYS,
  COUNTRY_PRESETS,
  INVOICE_FONTS,
  INVOICE_PLACEHOLDERS,
  layoutWarnings,
  paletteById,
  PRESET_PALETTES,
  renderInvoiceDocument,
  sampleInvoiceSource,
  SECTION_INFO,
  starterHtml,
  type ColumnConfig,
  type LayoutConfig,
  type SectionConfig,
  type TemplateEngine,
} from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select, Textarea } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { InvoiceFrame } from '@/components/invoice-templates/invoice-frame';
import { ColourEditor, PalettePicker, ThemePicker } from '@/components/invoice-templates/pickers';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { readAsDataUrl, type PrintData, type TemplateDetail } from '@/lib/invoice-templates';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

type Tab = 'look' | 'sections' | 'labels' | 'logo' | 'html';

export default function TemplateDesignerPage() {
  const { org, orgId } = useOrg();
  const { templateId } = useParams<{ templateId: string }>();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['invoice-template', orgId, templateId], queryFn: () => api<TemplateDetail>(`/v1/orgs/${orgId}/invoice-templates/${templateId}`) });
  const [name, setName] = useState('');
  const [engine, setEngine] = useState<TemplateEngine>('LAYOUT');
  const [layout, setLayout] = useState<LayoutConfig | null>(null);
  const [html, setHtml] = useState('');
  const [tab, setTab] = useState<Tab>('look');
  const [dirty, setDirty] = useState(false);
  const [sampleId, setSampleId] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const loaded = useRef<string | null>(null);

  useEffect(() => {
    const t = q.data;
    if (!t || loaded.current === t.updatedAt) return;
    loaded.current = t.updatedAt;
    setName(t.name);
    setEngine(t.engine);
    setLayout(t.layout);
    setHtml(t.html ?? starterHtml(t.presetId));
    setDirty(false);
    if (t.engine === 'HTML') setTab('html');
  }, [q.data]);

  const invoices = useQuery({
    queryKey: ['designer-invoices', orgId],
    queryFn: () => api<{ items: { id: string; number: string | null; contact: { name: string }; status: string }[] }>(`/v1/orgs/${orgId}/sales/documents?kind=INVOICE&view=all&limit=100`),
  });
  const real = useQuery({
    queryKey: ['invoice-print', orgId, sampleId, 'designer'],
    queryFn: () => api<PrintData>(`/v1/orgs/${orgId}/invoice-print/${sampleId}`),
    enabled: !!sampleId,
  });

  const t = q.data;
  const manage = !!org && can(org.role, 'templates.manage') && !!t && !t.archived;
  const change = (fn: (l: LayoutConfig) => LayoutConfig) => {
    setLayout((l) => (l ? fn(structuredClone(l)) : l));
    setDirty(true);
  };
  const setSection = (key: string, patch: Partial<SectionConfig>) => change((l) => ({ ...l, sections: l.sections.map((s) => (s.key === key ? { ...s, ...patch } : s)) }));

  const preview = useMemo(() => {
    if (!layout || !t) return { html: '', error: null as string | null };
    const base = real.data?.source ?? { ...sampleInvoiceSource(t.presetId), seller: { ...sampleInvoiceSource(t.presetId).seller, name: org?.name ?? 'Your Business', legalName: null } };
    try {
      return { html: renderInvoiceDocument({ engine, layout, html }, { ...base, logoDataUrl: t.logoDataUrl }), error: null };
    } catch (e) {
      return { html: '', error: (e as Error).message };
    }
  }, [layout, engine, html, t, real.data, org?.name]);
  const htmlCheck = useMemo(() => (engine === 'HTML' ? checkHtmlTemplate(html) : null), [engine, html]);
  const warnings = useMemo(() => (layout && t && engine === 'LAYOUT' ? layoutWarnings(layout, t.presetId) : []), [layout, t, engine]);

  const save = useMutation({
    mutationFn: () => api<TemplateDetail>(`/v1/orgs/${orgId}/invoice-templates/${templateId}`, { method: 'PUT', body: { name, engine, layout: layout as unknown as Record<string, unknown>, html: engine === 'HTML' ? html : null } }),
    onSuccess: (saved) => {
      qc.setQueryData(['invoice-template', orgId, templateId], saved);
      void qc.invalidateQueries({ queryKey: ['invoice-templates', orgId] });
      setSavedAt(new Date().toLocaleTimeString());
    },
  });
  const logo = useMutation({
    mutationFn: (dataUrl: string | null) =>
      dataUrl
        ? api<TemplateDetail>(`/v1/orgs/${orgId}/invoice-templates/${templateId}/logo`, { method: 'PUT', body: { imageBase64: dataUrl } })
        : api<TemplateDetail>(`/v1/orgs/${orgId}/invoice-templates/${templateId}/logo`, { method: 'DELETE' }),
    onSuccess: (saved) => qc.setQueryData(['invoice-template', orgId, templateId], { ...saved, updatedAt: q.data?.updatedAt ?? saved.updatedAt }),
  });

  if (!org || !t || !layout) return <ErrorAlert title="Could not load the template" error={q.error} />;
  const preset = COUNTRY_PRESETS.find((p) => p.id === t.presetId);
  const paletteId = PRESET_PALETTES.find((p) => JSON.stringify(p.palette) === JSON.stringify(layout.palette))?.id ?? null;
  const tabs: [Tab, string][] = engine === 'HTML' ? [['html', 'HTML'], ['labels', 'Labels and format'], ['logo', 'Logo']] : [['look', 'Theme and colours'], ['sections', 'Sections'], ['labels', 'Labels and format'], ['logo', 'Logo']];

  return (
    <>
      <PageHeader
        title={t.name}
        description={<>{preset?.name}{t.isDefault ? ' · the default template' : ''}{t.archived ? ' · archived (restore it to edit)' : ''}</>}
        actions={
          <>
            <Link href={`/orgs/${orgId}/settings/invoice-templates`}><Button variant="ghost">All templates</Button></Link>
            {manage ? <Button loading={save.isPending} disabled={!dirty && !save.isError} onClick={() => save.mutate()}>{dirty ? 'Save template' : 'Saved'}</Button> : null}
          </>
        }
      />
      <ErrorAlert title="Could not save the template" error={save.error} />
      {savedAt && !dirty && !save.isError ? <p className="mb-3 text-sm text-positive" role="status">Saved at {savedAt}.</p> : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <Card className="h-fit p-4">
          <fieldset disabled={!manage} className="space-y-4">
            <Field label="Template name">{(p) => <Input {...p} value={name} maxLength={120} onChange={(e) => { setName(e.target.value); setDirty(true); }} />}</Field>
            <div>
              <div className="mb-1.5 text-sm font-medium text-fg">Build with</div>
              <div className="flex gap-2" role="radiogroup" aria-label="Build with">
                {(['LAYOUT', 'HTML'] as const).map((v) => (
                  <Button key={v} type="button" size="sm" role="radio" aria-checked={engine === v} variant={engine === v ? 'primary' : 'secondary'} onClick={() => { setEngine(v); setDirty(true); setTab(v === 'HTML' ? 'html' : 'look'); }}>
                    {v === 'LAYOUT' ? 'Designer' : 'HTML code'}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-1 border-b border-line" role="tablist">
              {tabs.map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === k ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg'}`}>
                  {label}
                </button>
              ))}
            </div>

            {tab === 'look' ? (
              <div className="space-y-4">
                <div><div className="mb-1.5 text-sm font-medium text-fg">Theme</div><ThemePicker value={layout.theme} onChange={(theme) => change((l) => ({ ...l, theme }))} /></div>
                <div><div className="mb-1.5 text-sm font-medium text-fg">Palette</div><PalettePicker value={paletteId} onChange={(id) => change((l) => ({ ...l, palette: paletteById(id) }))} /></div>
                <div><div className="mb-1.5 text-sm font-medium text-fg">Colours {paletteId ? null : <Badge tone="violet">Custom</Badge>}</div><ColourEditor palette={layout.palette} onChange={(palette) => change((l) => ({ ...l, palette }))} /></div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Font">{(p) => <Select {...p} value={layout.font} onChange={(e) => change((l) => ({ ...l, font: e.target.value as LayoutConfig['font'] }))}>{INVOICE_FONTS.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select>}</Field>
                  <Field label="Paper">{(p) => <Select {...p} value={layout.pageSize} onChange={(e) => change((l) => ({ ...l, pageSize: e.target.value as LayoutConfig['pageSize'] }))}><option value="A4">A4</option><option value="LETTER">US Letter</option></Select>}</Field>
                </div>
              </div>
            ) : null}

            {tab === 'sections' ? <SectionsEditor layout={layout} onMove={(i, d) => change((l) => { const s = [...l.sections]; const [x] = s.splice(i, 1); s.splice(i + d, 0, x!); return { ...l, sections: s }; })} setSection={setSection} /> : null}

            {tab === 'labels' ? (
              <div className="space-y-3">
                <Field label="Document title" hint="Printed at the top, such as Tax Invoice.">{(p) => <Input {...p} value={layout.title} maxLength={120} onChange={(e) => change((l) => ({ ...l, title: e.target.value }))} />}</Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Tax number label">{(p) => <Input {...p} value={layout.taxIdLabel} maxLength={40} onChange={(e) => change((l) => ({ ...l, taxIdLabel: e.target.value }))} />}</Field>
                  <Field label="Tax name">{(p) => <Input {...p} value={layout.taxLabel} maxLength={40} onChange={(e) => change((l) => ({ ...l, taxLabel: e.target.value }))} />}</Field>
                  <Field label="Dates">{(p) => <Select {...p} value={layout.dateStyle} onChange={(e) => change((l) => ({ ...l, dateStyle: e.target.value as LayoutConfig['dateStyle'] }))}><option value="DMY">02 Nov 2026</option><option value="MDY">Nov 2, 2026</option><option value="ISO">2026-11-02</option></Select>}</Field>
                  <Field label="Numbers">{(p) => <Select {...p} value={layout.numberStyle} onChange={(e) => change((l) => ({ ...l, numberStyle: e.target.value as LayoutConfig['numberStyle'] }))}><option value="INDIAN">12,34,567.00 (lakh)</option><option value="INTERNATIONAL">1,234,567.00</option></Select>}</Field>
                </div>
                {engine === 'HTML' ? <Field label="Paper">{(p) => <Select {...p} value={layout.pageSize} onChange={(e) => change((l) => ({ ...l, pageSize: e.target.value as LayoutConfig['pageSize'] }))}><option value="A4">A4</option><option value="LETTER">US Letter</option></Select>}</Field> : null}
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[var(--t2t-accent)]" checked={layout.showLogo} onChange={(e) => change((l) => ({ ...l, showLogo: e.target.checked }))} /> Show the logo</label>
              </div>
            ) : null}

            {tab === 'logo' ? (
              <div className="space-y-3">
                <ErrorAlert title="Could not change the logo" error={logo.error} />
                {t.logoDataUrl ? <img src={t.logoDataUrl} alt="Current logo" className="max-h-20 rounded border border-line bg-white p-2" /> : <p className="text-sm text-fg-muted">No logo yet.</p>}
                <Field label="Upload a logo" hint="PNG, JPEG or WebP up to 500 KB. Saved straight away.">
                  {(p) => (
                    <Input
                      {...p}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (f) logo.mutate(await readAsDataUrl(f));
                        e.target.value = '';
                      }}
                    />
                  )}
                </Field>
                {t.logoDataUrl ? <Button type="button" variant="ghost" size="sm" loading={logo.isPending} onClick={() => logo.mutate(null)}>Remove logo</Button> : null}
              </div>
            ) : null}

            {tab === 'html' ? <HtmlEditor html={html} check={htmlCheck} presetId={t.presetId} onChange={(v) => { setHtml(v); setDirty(true); }} /> : null}
          </fieldset>
        </Card>

        <div className="min-w-0">
          <Card className="mb-3 p-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm text-fg-muted" htmlFor="sample">Preview with</label>
              <Select id="sample" className="max-w-xs" value={sampleId} onChange={(e) => setSampleId(e.target.value)}>
                <option value="">A sample invoice</option>
                {invoices.data?.items.map((i) => <option key={i.id} value={i.id}>{i.number ?? 'Draft'} · {i.contact.name}</option>)}
              </Select>
              {dirty ? <Badge tone="warning">Unsaved changes</Badge> : null}
            </div>
            {warnings.length ? (
              <div className="mt-3"><Alert tone="warning" title={`${preset?.name ?? 'Country'} checks`}><ul className="list-inside list-disc">{warnings.map((w) => <li key={w}>{w}</li>)}</ul></Alert></div>
            ) : null}
          </Card>
          {preview.error ? <Alert title="The template cannot render yet">{preview.error}</Alert> : <InvoiceFrame html={preview.html} title="Invoice preview" />}
        </div>
      </div>
    </>
  );
}

function SectionsEditor({ layout, onMove, setSection }: { layout: LayoutConfig; onMove: (i: number, d: -1 | 1) => void; setSection: (key: string, patch: Partial<SectionConfig>) => void }) {
  const [open, setOpen] = useState<string | null>('HEADER');
  return (
    <ol className="space-y-2" aria-label="Sections">
      {layout.sections.map((s, i) => {
        const info = SECTION_INFO[s.key];
        const expanded = open === s.key;
        return (
          <li key={s.key} className={`rounded-md border ${s.visible ? 'border-line' : 'border-dashed border-line opacity-70'}`}>
            <div className="flex items-center gap-2 p-2">
              <input type="checkbox" aria-label={`Show ${info.name}`} className="accent-[var(--t2t-accent)]" checked={s.visible} onChange={(e) => setSection(s.key, { visible: e.target.checked })} />
              <button type="button" className="flex-1 text-left text-sm font-medium text-fg" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : s.key)}>
                {info.name} {s.width === 'HALF' ? <span className="text-xs font-normal text-fg-faint">half width</span> : null}
              </button>
              <Button type="button" size="sm" variant="ghost" aria-label={`Move ${info.name} up`} disabled={i === 0} onClick={() => onMove(i, -1)}>↑</Button>
              <Button type="button" size="sm" variant="ghost" aria-label={`Move ${info.name} down`} disabled={i === layout.sections.length - 1} onClick={() => onMove(i, 1)}>↓</Button>
            </div>
            {expanded ? (
              <div className="space-y-3 border-t border-line p-3">
                <p className="text-xs text-fg-muted">{info.help}</p>
                <Field label="Heading" hint="Leave empty for no heading.">{(p) => <Input {...p} value={s.title} maxLength={120} onChange={(e) => setSection(s.key, { title: e.target.value })} />}</Field>
                {s.key !== 'LINES' ? (
                  <Field label={s.key === 'TITLE' ? 'Line under the title' : 'Text'} hint="Plain text; new lines are kept. Placeholders like {{seller.name}} or {{doc.dueDate}} are filled in.">
                    {(p) => <Textarea {...p} rows={3} value={s.text} maxLength={2000} onChange={(e) => setSection(s.key, { text: e.target.value })} />}
                  </Field>
                ) : null}
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Width">{(p) => <Select {...p} value={s.width} onChange={(e) => setSection(s.key, { width: e.target.value as SectionConfig['width'] })}><option value="FULL">Full width</option><option value="HALF">Half (pairs with the next half)</option></Select>}</Field>
                  <Field label="Align">{(p) => <Select {...p} value={s.align} onChange={(e) => setSection(s.key, { align: e.target.value as SectionConfig['align'] })}><option value="LEFT">Left</option><option value="CENTER">Centre</option><option value="RIGHT">Right</option></Select>}</Field>
                </div>
                {s.key === 'LINES' && s.columns ? <ColumnsEditor columns={s.columns} onChange={(columns) => setSection(s.key, { columns })} /> : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function ColumnsEditor({ columns, onChange }: { columns: ColumnConfig[]; onChange: (c: ColumnConfig[]) => void }) {
  const move = (i: number, d: -1 | 1) => {
    const c = [...columns];
    const [x] = c.splice(i, 1);
    c.splice(i + d, 0, x!);
    onChange(c);
  };
  return (
    <div>
      <div className="mb-1.5 text-sm font-medium text-fg">Columns</div>
      <ul className="space-y-1.5" aria-label="Columns">
        {columns.map((c, i) => (
          <li key={c.key} className="flex items-center gap-2">
            <input type="checkbox" aria-label={`Show column ${c.key}`} className="accent-[var(--t2t-accent)]" checked={c.visible} disabled={c.key === 'DESCRIPTION'} onChange={(e) => onChange(columns.map((x) => (x.key === c.key ? { ...x, visible: e.target.checked } : x)))} />
            <Input aria-label={`Label for column ${c.key}`} className="h-8" value={c.label} maxLength={40} onChange={(e) => onChange(columns.map((x) => (x.key === c.key ? { ...x, label: e.target.value } : x)))} />
            <span className="w-20 shrink-0 text-[11px] text-fg-faint">{c.key.replace('_', ' ').toLowerCase()}</span>
            <Button type="button" size="sm" variant="ghost" aria-label={`Move column ${c.key} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</Button>
            <Button type="button" size="sm" variant="ghost" aria-label={`Move column ${c.key} down`} disabled={i === COLUMN_KEYS.length - 1} onClick={() => move(i, 1)}>↓</Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HtmlEditor({ html, check, presetId, onChange }: { html: string; check: ReturnType<typeof checkHtmlTemplate> | null; presetId: string; onChange: (v: string) => void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const insert = (text: string) => {
    const el = area.current;
    if (!el) return onChange(html + text);
    const { selectionStart: a, selectionEnd: b } = el;
    onChange(html.slice(0, a) + text + html.slice(b));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = a + text.length;
    });
  };
  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-muted">
        Write the page body in HTML with a &lt;style&gt; block. Values are filled in with placeholders and are always escaped. Scripts, event handlers, frames, forms and anything loaded from the internet are refused; images must be the logo placeholder or data: images.
      </p>
      <Textarea
        ref={area}
        aria-label="HTML template"
        rows={22}
        spellCheck={false}
        value={html}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Tab') {
            e.preventDefault();
            insert('  ');
          }
        }}
        className="font-mono text-xs leading-5"
      />
      {check && !check.ok ? (
        <Alert title="Fix these before saving"><ul className="list-inside list-disc">{check.errors.map((x) => <li key={x}>{x}</li>)}</ul></Alert>
      ) : check?.unknownPlaceholders.length ? (
        <Alert tone="warning" title="Unknown placeholders print empty">{check.unknownPlaceholders.map((p) => `{{${p}}}`).join(', ')}</Alert>
      ) : (
        <p className="text-xs text-positive" role="status">The template passes the safety checks.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => confirm('Replace your HTML with the starter template?') && onChange(starterHtml(presetId))}>Start again from the example</Button>
      </div>
      <details className="rounded-md border border-line p-2">
        <summary className="cursor-pointer text-sm font-medium text-fg">Placeholders (click one to insert it)</summary>
        <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto text-xs">
          {INVOICE_PLACEHOLDERS.map((p) => {
            const short = p.path.startsWith('lines.') || p.path.startsWith('taxes.') ? p.path.split('.')[1]! : p.path;
            const token = p.list ? `{{#${p.path}}}…{{/${p.path}}}` : `{{${short}}}`;
            return (
              <li key={p.path} className="flex gap-2">
                <button type="button" className="shrink-0 rounded bg-surface-hover px-1.5 py-0.5 font-mono text-accent hover:underline" onClick={() => insert(p.list ? `{{#${p.path}}}\n{{/${p.path}}}` : `{{${short}}}`)}>{token}</button>
                <span className="text-fg-muted">{p.description}</span>
              </li>
            );
          })}
        </ul>
      </details>
    </div>
  );
}
