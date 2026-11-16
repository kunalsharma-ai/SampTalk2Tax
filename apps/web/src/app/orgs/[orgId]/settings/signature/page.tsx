'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, CardHeader, Field, Input, Select } from '@talk2tax/ui';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { readAsDataUrl, type MySignature } from '@/lib/invoice-templates';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

type Mode = 'DRAWN' | 'TYPED' | 'UPLOADED';
const W = 600;
const H = 200;
const SCRIPT_FONTS = [
  { id: 'cursive', name: 'Handwriting', css: "'Segoe Script', 'Brush Script MT', 'Lucida Handwriting', 'Apple Chancery', cursive" },
  { id: 'italic-serif', name: 'Italic serif', css: "italic 400 1em Georgia, 'Times New Roman', serif" },
  { id: 'formal', name: 'Formal', css: "'Snell Roundhand', 'Zapfino', 'Edwardian Script ITC', cursive" },
];

/** A signature pad: pointer strokes on a canvas, exported as a transparent PNG. */
function DrawPad({ onChange, ink }: { onChange: (dataUrl: string | null) => void; ink: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const strokes = useRef(0);
  const ctx = () => canvas.current!.getContext('2d')!;
  const point = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return [((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * H) / r.height] as const;
  };
  const clear = () => {
    ctx().clearRect(0, 0, W, H);
    strokes.current = 0;
    onChange(null);
  };
  return (
    <div>
      <canvas
        ref={canvas}
        width={W}
        height={H}
        aria-label="Signature pad: draw your signature with a mouse, pen or finger"
        role="img"
        className="w-full touch-none rounded-md border border-dashed border-line bg-white"
        style={{ aspectRatio: `${W} / ${H}`, cursor: 'crosshair' }}
        onPointerDown={(e) => {
          drawing.current = true;
          canvas.current!.setPointerCapture(e.pointerId);
          const c = ctx();
          const [x, y] = point(e);
          c.strokeStyle = ink;
          c.lineWidth = 3;
          c.lineCap = 'round';
          c.lineJoin = 'round';
          c.beginPath();
          c.moveTo(x, y);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const [x, y] = point(e);
          const c = ctx();
          c.lineTo(x, y);
          c.stroke();
        }}
        onPointerUp={() => {
          if (!drawing.current) return;
          drawing.current = false;
          strokes.current += 1;
          onChange(canvas.current!.toDataURL('image/png'));
        }}
      />
      <div className="mt-1 flex justify-between text-xs text-fg-muted">
        <span>Sign inside the box.</span>
        <button type="button" className="text-accent hover:underline" onClick={clear}>Clear</button>
      </div>
    </div>
  );
}

/** Renders a typed name in a handwriting font to a transparent PNG. */
function typedSignature(text: string, fontCss: string, ink: string): string | null {
  if (!text.trim()) return null;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  let size = 80;
  const font = (s: number) => (fontCss.includes(' 1em ') ? fontCss.replace('1em', `${s}px`) : `${s}px ${fontCss}`);
  g.font = font(size);
  while (g.measureText(text).width > W - 40 && size > 24) g.font = font((size -= 4));
  g.fillStyle = ink;
  g.textBaseline = 'middle';
  g.fillText(text, 20, H / 2);
  return c.toDataURL('image/png');
}

export default function MySignaturePage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const allowed = !!org && can(org.role, 'documents.sign');
  const q = useQuery({ queryKey: ['my-signature', orgId], queryFn: () => api<MySignature>(`/v1/orgs/${orgId}/signatures/me`), enabled: allowed });
  const [mode, setMode] = useState<Mode>('DRAWN');
  const [image, setImage] = useState<string | null>(null);
  const [signerName, setSignerName] = useState('');
  const [designation, setDesignation] = useState('');
  const [typed, setTyped] = useState('');
  const [font, setFont] = useState(SCRIPT_FONTS[0]!.id);
  const [ink, setInk] = useState('#1e3a8a');
  const [padKey, setPadKey] = useState(0);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const s = q.data?.signature;
    if (s && !signerName) {
      setSignerName(s.signerName);
      setDesignation(s.designation ?? '');
    }
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mode === 'TYPED') setImage(typedSignature(typed, SCRIPT_FONTS.find((f) => f.id === font)!.css, ink));
  }, [mode, typed, font, ink]);

  const save = useMutation({
    mutationFn: () => api<MySignature>(`/v1/orgs/${orgId}/signatures/me`, { method: 'PUT', body: { kind: mode, signerName, designation: designation || null, imageBase64: image! } }),
    onSuccess: (d) => {
      qc.setQueryData(['my-signature', orgId], d);
      setImage(null);
      setTyped('');
      setPadKey((k) => k + 1);
      setSaved(true);
    },
  });
  const remove = useMutation({ mutationFn: () => api<MySignature>(`/v1/orgs/${orgId}/signatures/me`, { method: 'DELETE' }), onSuccess: (d) => qc.setQueryData(['my-signature', orgId], d) });

  if (!org) return null;
  const current = q.data?.signature;
  return (
    <>
      <PageHeader
        title="My signature"
        description="The signature placed on invoices and credit notes you e-sign in this organisation. Replacing it does not change invoices you already signed: each keeps its own copy."
        actions={<Link href={`/orgs/${orgId}/settings/invoice-templates`}><Button variant="ghost">Invoice templates</Button></Link>}
      />
      {!allowed ? <Alert tone="warning" title="Your role cannot sign invoices">Ask an owner or admin for the Accountant, Approver or Admin role.</Alert> : null}
      <ErrorAlert title="Could not load your signature" error={q.error} />
      {allowed ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <Card className="p-4">
            <CardHeader title={current ? 'Replace your signature' : 'Add your signature'} />
            <ErrorAlert title="Could not save the signature" error={save.error} />
            {saved && !save.isPending && !image ? <p className="mb-3 text-sm text-positive" role="status">Signature saved.</p> : null}
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                setSaved(false);
                save.mutate();
              }}
            >
              <div className="flex gap-2" role="tablist" aria-label="How to sign">
                {([['DRAWN', 'Draw'], ['TYPED', 'Type'], ['UPLOADED', 'Upload']] as const).map(([m, label]) => (
                  <Button key={m} type="button" size="sm" role="tab" aria-selected={mode === m} variant={mode === m ? 'primary' : 'secondary'} onClick={() => { setMode(m); setImage(null); }}>{label}</Button>
                ))}
                <label className="ml-auto flex items-center gap-2 text-xs text-fg-muted">Ink <input type="color" aria-label="Ink colour" value={ink} onChange={(e) => setInk(e.target.value)} className="h-7 w-9 rounded border border-line bg-transparent" /></label>
              </div>
              {mode === 'DRAWN' ? <DrawPad key={`${padKey}-${ink}`} ink={ink} onChange={setImage} /> : null}
              {mode === 'TYPED' ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Type your signature">{(p) => <Input {...p} value={typed} maxLength={60} onChange={(e) => setTyped(e.target.value)} />}</Field>
                    <Field label="Style">{(p) => <Select {...p} value={font} onChange={(e) => setFont(e.target.value)}>{SCRIPT_FONTS.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select>}</Field>
                  </div>
                  {image ? <img src={image} alt="Typed signature preview" className="w-full rounded-md border border-dashed border-line bg-white" /> : null}
                </div>
              ) : null}
              {mode === 'UPLOADED' ? (
                <div className="space-y-2">
                  <Field label="Signature image" hint="A scan or photo of your signature: PNG, JPEG or WebP up to 300 KB. A transparent PNG looks best.">
                    {(p) => <Input {...p} type="file" accept="image/png,image/jpeg,image/webp" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setImage(await readAsDataUrl(f)); }} />}
                  </Field>
                  {image ? <img src={image} alt="Uploaded signature preview" className="max-h-32 rounded-md border border-dashed border-line bg-white p-2" /> : null}
                </div>
              ) : null}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Name under the signature">{(p) => <Input {...p} value={signerName} maxLength={120} required onChange={(e) => setSignerName(e.target.value)} />}</Field>
                <Field label="Designation" hint="Optional, such as Director or Authorised signatory.">{(p) => <Input {...p} value={designation} maxLength={120} onChange={(e) => setDesignation(e.target.value)} />}</Field>
              </div>
              <Button type="submit" loading={save.isPending} disabled={!image || !signerName.trim()}>{current ? 'Replace my signature' : 'Save my signature'}</Button>
            </form>
          </Card>
          <Card className="h-fit p-4">
            <CardHeader title="In use now" />
            {current ? (
              <div className="space-y-2 text-sm">
                <img src={current.imageDataUrl} alt="Your saved signature" className="w-full rounded-md border border-line bg-white p-2" />
                <div className="text-fg">{current.signerName}{current.designation ? `, ${current.designation}` : ''}</div>
                <div className="text-xs text-fg-muted">{current.kind === 'DRAWN' ? 'Drawn' : current.kind === 'TYPED' ? 'Typed' : 'Uploaded'} on {date(current.createdAt.slice(0, 10))}. {q.data!.documentsSigned} document{q.data!.documentsSigned === 1 ? '' : 's'} signed and not withdrawn.</div>
                <Button size="sm" variant="ghost" loading={remove.isPending} onClick={() => confirm('Remove your signature? Invoices you signed keep their copy.') && remove.mutate()}>Remove</Button>
              </div>
            ) : (
              <p className="text-sm text-fg-muted">No signature saved yet.</p>
            )}
            <p className="mt-3 text-[11px] leading-4 text-fg-faint">An electronic signature with a recorded hash of each signed invoice. Aadhaar eSign and DSC signing need a licensed provider and are not connected yet.</p>
          </Card>
        </div>
      ) : null}
    </>
  );
}
