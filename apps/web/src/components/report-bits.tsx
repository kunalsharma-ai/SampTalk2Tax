'use client';
import { Badge, Input } from '@talk2tax/ui';
import type { ReactNode } from 'react';

export function DateInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
      {label}
      <Input type="date" className="w-40" value={value} onChange={(e) => e.target.value && onChange(e.target.value)} />
    </label>
  );
}

export function BalancedBadge({ balanced, children }: { balanced: boolean; children?: ReactNode }) {
  return balanced ? <Badge tone="positive">✓ {children ?? 'Balanced'}</Badge> : <Badge tone="negative">Out of balance</Badge>;
}

export function fyStartFor(today: string, startMonth: number): string {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const year = m >= startMonth ? y : y - 1;
  return `${year}-${String(startMonth).padStart(2, '0')}-01`;
}
