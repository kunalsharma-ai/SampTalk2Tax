'use client';
import { Button, Input, Select } from '@talk2tax/ui';
import { money } from '@/lib/format';
import type { PayComponentKind } from '@/lib/types';

export interface ComponentDraft {
  code: string;
  name: string;
  kind: PayComponentKind;
  monthlyAmount: string;
}

export const DEFAULT_COMPONENTS: ComponentDraft[] = [
  { code: 'BASIC', name: 'Basic', kind: 'WAGES', monthlyAmount: '' },
  { code: 'HRA', name: 'House rent allowance', kind: 'EXCLUDED', monthlyAmount: '' },
  { code: 'SPECIAL', name: 'Special allowance', kind: 'WAGES', monthlyAmount: '' },
];

const AMT = /^\d{0,13}(\.\d{0,2})?$/;

/** Monthly salary components. "Counts as wages" decides PF and ESI under the Code on Social Security. */
export function SalaryEditor({ value, onChange }: { value: ComponentDraft[]; onChange: (v: ComponentDraft[]) => void }) {
  const set = (i: number, patch: Partial<ComponentDraft>) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const cents = (v: string) => Math.round(Number(v || '0') * 100);
  const total = value.reduce((s, c) => s + cents(c.monthlyAmount), 0);
  const excluded = value.filter((c) => c.kind === 'EXCLUDED').reduce((s, c) => s + cents(c.monthlyAmount), 0);
  const addedBack = excluded * 2 > total ? excluded - Math.floor(total / 2) : 0;
  const wages = total - excluded + addedBack;
  return (
    <div className="flex flex-col gap-2">
      <div className="hidden grid-cols-[6rem_1fr_11rem_8rem_2rem] gap-2 text-[11px] font-medium uppercase tracking-wide text-fg-muted sm:grid">
        <span>Code</span><span>Component</span><span>PF/ESI</span><span className="text-right">Monthly (₹)</span><span />
      </div>
      {value.map((c, i) => (
        <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[6rem_1fr_11rem_8rem_2rem]">
          <Input aria-label={`Code for component ${i + 1}`} className="num uppercase" value={c.code} maxLength={20} onChange={(e) => set(i, { code: e.target.value.toUpperCase() })} />
          <Input aria-label={`Name for component ${i + 1}`} value={c.name} maxLength={100} onChange={(e) => set(i, { name: e.target.value })} />
          <Select aria-label={`PF and ESI treatment for component ${i + 1}`} value={c.kind} onChange={(e) => set(i, { kind: e.target.value as PayComponentKind })}>
            <option value="WAGES">Counts as wages</option>
            <option value="EXCLUDED">Excluded allowance</option>
          </Select>
          <Input aria-label={`Monthly amount for component ${i + 1}`} className="num text-right" inputMode="decimal" placeholder="0" value={c.monthlyAmount} onChange={(e) => AMT.test(e.target.value) && set(i, { monthlyAmount: e.target.value })} />
          <button type="button" aria-label={`Remove component ${i + 1}`} className="text-fg-faint hover:text-negative" onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <Button type="button" size="sm" variant="secondary" onClick={() => onChange([...value, { code: '', name: '', kind: 'EXCLUDED', monthlyAmount: '' }])}>+ Add component</Button>
        <p className="text-right text-xs text-fg-muted">
          Gross <span className="num font-medium text-fg">{money((total / 100).toFixed(2), 'INR')}</span> a month · wages for PF/ESI <span className="num font-medium text-fg">{money((wages / 100).toFixed(2), 'INR')}</span>
          {addedBack ? <span className="block text-warning">Excluded allowances are over half the pay, so {money((addedBack / 100).toFixed(2), 'INR')} counts as wages (Code on Social Security s.2(88)).</span> : null}
        </p>
      </div>
    </div>
  );
}

export function componentsBody(value: ComponentDraft[]) {
  return value.filter((c) => c.code.trim() || c.name.trim() || c.monthlyAmount).map((c) => ({ code: c.code.trim(), name: c.name.trim(), kind: c.kind, monthlyAmount: c.monthlyAmount || '0' }));
}
