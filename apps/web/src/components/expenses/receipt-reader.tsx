'use client';
import { useMutation } from '@tanstack/react-query';
import type { ReadConfidence, ReceiptReading } from '@talk2tax/tax-engine';
import { Alert, Badge, Button } from '@talk2tax/ui';
import { useId, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { uploadFile } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { shrinkPhoto } from '@/lib/photo';

export interface ReceiptReadingResult {
  id: string;
  source: 'PHOTO' | 'PDF';
  fileName: string;
  ocrConfidence: number | null;
  text: string;
  reading: ReceiptReading;
}

const CONFIDENCE: Record<ReadConfidence, { label: string; tone: 'positive' | 'accent' | 'warning' }> = {
  HIGH: { label: 'Read clearly', tone: 'positive' },
  MEDIUM: { label: 'Check', tone: 'accent' },
  LOW: { label: 'Guess', tone: 'warning' },
};

/**
 * Read a receipt (EXP-004): the member picks a photo or PDF, Talk2Tax reads it (OCR runs inside
 * Talk2Tax), and the caller fills its form with what was read. Shows each value with how sure the
 * reading is and anything to check, since the member saves only after checking.
 */
export function ReceiptReader({ onRead, title = 'Read a receipt' }: { onRead: (r: ReceiptReadingResult, file: File) => void; title?: string }) {
  const { org, orgId } = useOrg();
  const inputId = useId();
  const [result, setResult] = useState<ReceiptReadingResult | null>(null);
  const read = useMutation({
    mutationFn: async (original: File) => {
      const file = original.type === 'application/pdf' ? original : await shrinkPhoto(original);
      const r = await uploadFile<ReceiptReadingResult>(`/v1/orgs/${orgId}/receipt-reading?fileName=${encodeURIComponent(file.name)}`, file);
      return { r, file };
    },
    onSuccess: ({ r, file }) => {
      setResult(r);
      onRead(r, file);
    },
  });
  const g = result?.reading;
  const currency = g?.currency ?? org?.functionalCurrency ?? 'INR';
  return (
    <section aria-label={title} className="rounded-[var(--t2t-radius-md)] border border-border bg-surface-sunken p-3">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={inputId} className="text-sm font-medium">
          {title}
        </label>
        <input
          id={inputId}
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          capture="environment"
          className="text-sm"
          disabled={read.isPending}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) read.mutate(f);
            e.target.value = '';
          }}
        />
        {read.isPending ? (
          <span className="text-sm text-fg-muted" role="status">
            Reading the receipt…
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-fg-muted">A photo or PDF. Talk2Tax reads it itself (nothing is sent to an outside service) and fills in the form below; check every value before saving.</p>
      <ErrorAlert title="The receipt could not be read" error={read.error} />
      {g && result ? (
        <div className="mt-3">
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]" aria-label="What was read">
            {(
              [
                ['Merchant', g.merchant, g.merchant?.value],
                ['Date', g.date, g.date ? date(g.date.value) : null],
                ['Total', g.total, g.total ? <Money value={g.total.value} currency={currency} /> : null],
                ['GSTIN', g.gstin, g.gstin?.value],
              ] as const
            ).map(([label, field, shown]) => (
              <div key={label} className="contents">
                <dt className="text-fg-muted">{label}</dt>
                <dd>
                  {field ? (
                    <>
                      <span className="font-medium">{shown}</span> <Badge tone={CONFIDENCE[field.confidence].tone}>{CONFIDENCE[field.confidence].label}</Badge>
                    </>
                  ) : (
                    <span className="text-fg-muted">Not found</span>
                  )}
                </dd>
              </div>
            ))}
            <div className="contents">
              <dt className="text-fg-muted">Tax</dt>
              <dd>
                {g.taxes.length ? (
                  <>
                    {g.taxes.map((t) => `${t.label}${t.rate ? ` ${t.rate}%` : ''} ${t.amount}`).join(', ')}
                    {g.addsUp === true ? <span className="text-fg-muted"> (subtotal and tax add up to the total)</span> : null}
                  </>
                ) : (
                  <span className="text-fg-muted">None shown</span>
                )}
              </dd>
            </div>
          </dl>
          {result.ocrConfidence !== null ? <p className="mt-1 text-xs text-fg-muted">Characters read with {result.ocrConfidence}% confidence.</p> : null}
          {g.warnings.length ? (
            <div className="mt-2">
              <Alert tone="warning" title="Check before saving">
                <ul className="list-disc pl-5">
                  {g.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Alert>
            </div>
          ) : null}
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-fg-muted">Text read from the receipt</summary>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-surface-raised p-2">{result.text}</pre>
          </details>
          <div className="mt-2">
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => {
                setResult(null);
                read.reset();
              }}
            >
              Clear reading
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
