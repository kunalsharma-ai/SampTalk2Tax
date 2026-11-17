'use client';
import { VENDOR_RISK_LEVEL_LABEL, type VendorRiskFactor } from '@talk2tax/accounting-engine';
import { Badge } from '@talk2tax/ui';
import { LEVEL_TONE } from '@/lib/vendor-risk';

/** A vendor's risk factors, worst first, each with what it was raised on. `fresh` marks those the last review did not see. */
export function FactorList({ factors, fresh = [], detail = true }: { factors: VendorRiskFactor[]; fresh?: string[]; detail?: boolean }) {
  return (
    <ul className="flex flex-col gap-2">
      {factors.map((f) => (
        <li key={f.code} className="flex gap-3 text-sm">
          <Badge tone={LEVEL_TONE[f.level]} className="h-fit shrink-0">{VENDOR_RISK_LEVEL_LABEL[f.level]}</Badge>
          <span>
            <span className="font-medium">{f.title}</span>
            {fresh.includes(f.code) ? <span className="ml-2 text-xs font-medium text-warning">new since the last review</span> : null}
            {detail ? <span className="block text-fg-muted">{f.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
