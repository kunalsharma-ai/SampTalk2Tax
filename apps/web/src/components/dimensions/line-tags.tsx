'use client';
import { Select } from '@talk2tax/ui';
import type { FinancialTag } from '@/lib/financial-tags';

/**
 * A picker per financial tag (such as Location) under a line's account. Only active tags are
 * offered; a saved line keeps showing an inactive value it already has.
 */
export function LineTags({ tags, line, value, onChange }: { tags: FinancialTag[] | undefined; line: number; value: Record<string, string>; onChange: (next: Record<string, string>) => void }) {
  const shown = (tags ?? []).filter((t) => t.isActive || value[t.key]);
  if (!shown.length) return null;
  return (
    <div className="mt-1.5 grid grid-cols-2 gap-2">
      {shown.map((t) => {
        const current = value[t.key] ?? '';
        const options = t.values.filter((v) => v.isActive || v.code === current);
        return (
          <Select
            key={t.key}
            aria-label={`${t.label} for line ${line}`}
            className="h-8 min-w-0 text-xs"
            value={current}
            onChange={(e) => {
              const next = { ...value };
              if (e.target.value) next[t.key] = e.target.value;
              else delete next[t.key];
              onChange(next);
            }}
          >
            <option value="">{t.label}</option>
            {options.map((v) => <option key={v.code} value={v.code} title={v.code}>{v.name}{v.isActive ? '' : ' (inactive)'}</option>)}
            {current && !options.length ? <option value={current}>{current}</option> : null}
          </Select>
        );
      })}
    </div>
  );
}

/** The tag values on a saved line, by their names, for read-only views. */
export function LineTagBadges({ tags, value }: { tags: FinancialTag[] | undefined; value: Record<string, string> | null | undefined }) {
  const entries = Object.entries(value ?? {});
  if (!entries.length) return null;
  return (
    <p className="mt-0.5 flex flex-wrap gap-1.5 text-xs">
      {entries.map(([key, code]) => {
        const t = tags?.find((x) => x.key === key);
        const name = t?.values.find((v) => v.code === code)?.name ?? code;
        return <span key={key} className="rounded bg-positive/10 px-1.5 py-0.5 text-positive" title={t?.label ?? key}>{name}</span>;
      })}
    </p>
  );
}
