type Document = Record<string, unknown>;

/**
 * Efficient search (PERF-012). A search for "part of a name or number" cannot narrow an index to
 * a range, so it used to fetch every record of the organisation and test each one. Instead, each
 * searched field has an index that starts with the organisation, and the search walks that index
 * in its own order: MongoDB tests the text on the index entries alone and fetches only the
 * records that match, and the walk stops once it has enough of them. Matches that start with the
 * text are looked for first, so they are never crowded out by matches in the middle.
 *
 * Ranking: the whole value equals the text, then values that start with it, then values that
 * contain it; ties keep the field's own order.
 */

/** What a search reads from one collection. */
export interface SearchCollection {
  find(filter: Document, options: { sort?: Record<string, 1 | -1>; limit?: number; projection?: Record<string, 0 | 1>; hint?: Record<string, 1 | -1> }): Promise<Document[]>;
}

/** A searched field and the direction its index ({ orgId: 1, <field>: 1 }) is walked (newest numbers first, names A to Z). */
export interface SearchField {
  field: string;
  dir: 1 | -1;
  /** Only values that start with the text (account codes). */
  prefixOnly?: boolean;
}

/** The text as a literal pattern: every character that means something to a pattern is escaped. */
export function literalPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, (c) => `\\${c}`);
}

/** 0 when `value` is `term`, 1 when it starts with it, 2 when it contains it, ignoring case; otherwise null. */
export function matchRank(value: unknown, term: string): 0 | 1 | 2 | null {
  if (typeof value !== 'string') return null;
  const v = value.toLocaleLowerCase('en');
  const t = term.toLocaleLowerCase('en');
  if (v === t) return 0;
  if (v.startsWith(t)) return 1;
  return v.includes(t) ? 2 : null;
}

/**
 * The ids of at most `limit` records whose fields match `term`, best first. Each field is read
 * twice (values starting with the text, and values containing it), each read limited to `limit`
 * records in the order of the field's index.
 */
export async function searchIds(coll: SearchCollection, fields: readonly SearchField[], term: string, limit: number): Promise<string[]> {
  const pattern = literalPattern(term);
  // Every read at once; each stops at `limit` matches in its index's order.
  const reads = fields.flatMap((f) => (f.prefixOnly ? [`^${pattern}`] : [`^${pattern}`, pattern]).map((p) => ({ f, p })));
  const pages = await Promise.all(
    reads.map(({ f, p }) => coll.find({ [f.field]: { $regex: p, $options: 'i' } }, { sort: { [f.field]: f.dir }, limit, projection: { id: 1, [f.field]: 1 }, hint: { orgId: 1, [f.field]: 1 } })),
  );
  const found = new Map<string, { rank: number; seq: number }>();
  let seq = 0;
  pages.forEach((rows, i) => {
    const { field } = reads[i]!.f;
    for (const r of rows) {
      const rank = matchRank(r[field], term);
      if (rank === null) continue;
      const id = String(r.id);
      const had = found.get(id);
      if (!had || rank < had.rank) found.set(id, { rank, seq: had?.seq ?? seq++ });
    }
  });
  return [...found.entries()]
    .sort(([, a], [, b]) => a.rank - b.rank || a.seq - b.seq)
    .slice(0, limit)
    .map(([id]) => id);
}

/** `rows` in the order of `ids`. */
export function inOrder<T extends { id: string }>(rows: T[], ids: readonly string[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is T => !!r);
}
