import { Prisma } from '@talk2tax/database';
import type { Guard, Row, Rule } from './guard';

const MODELS = Prisma.dmmf.datamodel.models;
const MODEL_OF_TABLE = new Map(MODELS.map((m) => [m.dbName ?? m.name, m]));

/**
 * The rules of the tables kept in step (db/mirror-writes.ts), by Prisma model. Each replaces a
 * PostgreSQL trigger, written against the table's column names as the trigger was; the
 * PostgreSQL copy still runs that trigger too until step 10.
 */
export const GUARDS: Record<string, Guard> = {};

/** Registers rules by table name (`budgets`, `budget_lines`, ...). */
export function registerGuards(rules: Record<string, Rule>): void {
  for (const [table, rule] of Object.entries(rules)) {
    const g = rule as Guard;
    const m = MODEL_OF_TABLE.get(table);
    if (!m) throw new Error(`No table ${table} in the schema`);
    const prior = GUARDS[m.name];
    GUARDS[m.name] = prior ? async (op, b, a, ctx) => { await prior(op, b, a, ctx); await g(op, b, a, ctx); } : g;
  }
}

/** A record with its column names (`fiscal_year`), as a trigger saw it as OLD and NEW. */
export function asColumns(model: string, row: Row | null): Row | null {
  if (!row) return null;
  const m = MODELS.find((x) => x.name === model)!;
  const out: Row = {};
  for (const f of m.fields) if (f.kind === 'scalar' || f.kind === 'enum') out[f.dbName ?? f.name] = row[f.name] ?? null;
  return out;
}
