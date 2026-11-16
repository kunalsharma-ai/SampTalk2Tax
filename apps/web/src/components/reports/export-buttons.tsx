'use client';
import { Button } from '@talk2tax/ui';
import { useState } from 'react';
import { ApiError } from '@/lib/api';

export type ExportableReport = 'trial-balance' | 'income-statement' | 'balance-sheet' | 'general-ledger' | 'receivables-ageing' | 'payables-ageing' | 'profit-by-dimension';
type Format = 'csv' | 'xlsx' | 'pdf';
const FORMATS: { id: Format; label: string; name: string }[] = [
  { id: 'csv', label: 'CSV', name: 'CSV' },
  { id: 'xlsx', label: 'Excel', name: 'Excel' },
  { id: 'pdf', label: 'PDF', name: 'PDF' },
];

/**
 * Downloads the report on screen as CSV, Excel or PDF with the same parameters. The file is
 * fetched first so a refusal (a bad date, no permission) shows here instead of downloading an
 * error as a file.
 */
export function ExportButtons({ orgId, report, params, disabled }: { orgId: string; report: ExportableReport; params: Record<string, string | boolean | null | undefined>; disabled?: boolean }) {
  const [busy, setBusy] = useState<Format | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const download = async (format: Format) => {
    setBusy(format);
    setError(null);
    setSaved(null);
    try {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '' && v !== false) qs.set(k, String(v));
      qs.set('format', format);
      const res = await fetch(`/api/t2t/v1/orgs/${orgId}/reports/export/${report}?${qs}`, { headers: { 'x-t2t-csrf': '1' } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const issues: string[] = Array.isArray(body.details?.issues) ? body.details.issues : [];
        throw new ApiError(res.status, body.error ?? 'ERROR', [body.message ?? `Export failed (${res.status})`, ...issues].join(': '), issues);
      }
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') ?? '';
      const fileName = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(cd)?.[1] ?? `${report}.${format}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setSaved(fileName);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div role="group" aria-label="Export" className="flex items-center gap-1">
        <span className="mr-1 text-xs font-medium text-fg-muted">Export</span>
        {FORMATS.map((f) => (
          <Button key={f.id} size="sm" variant="secondary" aria-label={`Export as ${f.name}`} disabled={disabled || busy !== null} loading={busy === f.id} onClick={() => void download(f.id)}>
            {f.label}
          </Button>
        ))}
      </div>
      {error ? <p role="alert" className="max-w-sm text-right text-xs text-negative">{error}</p> : null}
      {saved ? <p role="status" className="text-xs text-fg-muted">Downloaded {saved}</p> : null}
    </div>
  );
}
