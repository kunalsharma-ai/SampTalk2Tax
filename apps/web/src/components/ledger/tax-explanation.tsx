'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { api } from '@/lib/api';

interface Source {
  kind: 'LAW' | 'BOOKS';
  label: string;
}
interface Explanation {
  summary: string;
  points: { key: string; title: string; text: string; sources: Source[] }[];
  lines: { lineNo: number; description: string; hsnCode: string | null; tax: string; text: string; sources: Source[] }[];
  checks: string[];
  basis: string;
}

function Sources({ sources }: { sources: Source[] }) {
  return (
    <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Sources">
      {sources.map((s) => (
        <li key={`${s.kind}${s.label}`}>
          <Badge tone={s.kind === 'LAW' ? 'accent' : 'neutral'}>{s.kind === 'LAW' ? 'Law' : 'Books'}: {s.label}</Badge>
        </li>
      ))}
    </ul>
  );
}

/** Source-backed tax explanation (TAX-052): how the tax on this document was worked out, each point with its source. */
export function TaxExplanationCard({ orgId, ledger, documentId }: { orgId: string; ledger: 'SALES' | 'PURCHASES'; documentId: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['tax-explanation', orgId, ledger, documentId], queryFn: () => api<Explanation>(`/v1/orgs/${orgId}/${ledger === 'SALES' ? 'sales' : 'purchases'}/documents/${documentId}/tax-explanation`) });
  const e = q.data;
  return (
    <Card className="mt-6" role="region" aria-label="How the tax was worked out">
      <CardHeader
        title="How the tax was worked out"
        description="Every point names where it comes from: a record in your books or the provision of law. Built from the document as saved and fixed rules; no AI model is used."
        actions={e ? <Button variant="secondary" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide the explanation' : 'Explain the tax'}</Button> : null}
      />
      <ErrorAlert title="Could not explain the tax" error={q.error} />
      {e ? (
        <div className="grid gap-4 p-5 text-sm">
          <p className="font-medium">{e.summary}</p>
          {e.checks.length ? (
            <Alert tone="warning" title="Worth checking">
              <ul className="list-disc pl-5">{e.checks.map((c) => <li key={c}>{c}</li>)}</ul>
            </Alert>
          ) : null}
          {open ? (
            <>
              <ol className="grid gap-3" aria-label="Explanation">
                {e.points.map((p) => (
                  <li key={p.key}>
                    <p className="font-medium">{p.title}</p>
                    <p>{p.text}</p>
                    <Sources sources={p.sources} />
                  </li>
                ))}
              </ol>
              <div>
                <p className="mb-2 font-medium">Line by line</p>
                <ol className="grid gap-3" aria-label="Tax on each line">
                  {e.lines.map((l) => (
                    <li key={l.lineNo}>
                      <p className="text-fg-muted">Line {l.lineNo}{l.description ? `: ${l.description}` : ''}{l.hsnCode ? ` (HSN/SAC ${l.hsnCode})` : ''}</p>
                      <p>{l.text}</p>
                      {l.sources.length ? <Sources sources={l.sources} /> : null}
                    </li>
                  ))}
                </ol>
              </div>
              <p className="text-xs text-fg-muted">{e.basis}</p>
            </>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
