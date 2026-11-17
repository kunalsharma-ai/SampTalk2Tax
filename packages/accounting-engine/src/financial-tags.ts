/**
 * Financial tags (Directive Part 5.1, GL-031 custom financial tags, GL-028 locations). Besides
 * departments and projects, a journal line can carry tags: a key such as `location` and a value
 * such as `PUNE`. The organisation defines the keys it reports by and their values; a line that
 * uses a defined key must use one of its active values. Keys nobody defined stay free text.
 */

export const TAG_KEY = /^[a-z][a-z0-9_]{0,31}$/;
export const TAG_CODE = /^[A-Z0-9][A-Z0-9_-]{0,19}$/;
/** Ready-made tags an organisation can start from. */
export const TAG_PRESETS = { location: 'Location', business_unit: 'Business unit', profit_center: 'Profit centre', channel: 'Sales channel' } as const;

export interface FinancialTagDef {
  key: string;
  label: string;
  isActive: boolean;
  values: { code: string; name: string; isActive: boolean }[];
}

/** Problems with a tag as defined, or an empty list. */
export function financialTagIssues(t: { key: string; label: string; values: { code: string; name: string }[] }): string[] {
  const issues: string[] = [];
  if (!TAG_KEY.test(t.key)) issues.push('The key is lower case letters, digits and _, starting with a letter, such as location');
  if (!t.label.trim() || t.label.trim().length > 60) issues.push('Give the tag a name of 1 to 60 characters');
  const seen = new Set<string>();
  for (const v of t.values) {
    if (!TAG_CODE.test(v.code)) issues.push(`Value code ${v.code || '(blank)'}: use capital letters, digits, - and _, up to 20 characters`);
    if (!v.name.trim()) issues.push(`Value ${v.code}: give it a name`);
    if (seen.has(v.code)) issues.push(`Value code ${v.code} is used twice`);
    seen.add(v.code);
  }
  return issues;
}

/** Problems with the tags on journal lines, against the organisation's defined tags. */
export function lineTagIssues(defs: readonly FinancialTagDef[], lines: readonly { dimensions?: Record<string, string> | null }[]): string[] {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const issues: string[] = [];
  lines.forEach((l, i) => {
    for (const [key, value] of Object.entries(l.dimensions ?? {})) {
      const d = byKey.get(key);
      if (!d) continue;
      if (!d.isActive) {
        issues.push(`Line ${i + 1}: the ${d.label} tag is no longer used`);
        continue;
      }
      const v = d.values.find((x) => x.code === value);
      if (!v) issues.push(`Line ${i + 1}: ${value} is not a ${d.label}`);
      else if (!v.isActive) issues.push(`Line ${i + 1}: ${d.label} ${v.code} is inactive`);
    }
  });
  return issues;
}
