import { PrismaClient } from '@talk2tax/database';
import { afterAll, describe, expect, it } from 'vitest';
import catalog from '../src/db/constraints/catalog.json';
import { parseCheck, passes } from '../src/db/constraints/sql-expr';

/**
 * The CHECK constraints are evaluated by the API (src/db/constraints) so MongoDB records are held
 * to them. While PostgreSQL is still here it is the oracle: for records of every checked table,
 * and for each record with one column at a time changed to edge values, the evaluator must give
 * the same answer as PostgreSQL evaluating the constraint itself.
 */
const checks = catalog.checks as Record<string, { name: string; def: string }[]>;
const prisma = new PrismaClient({
  datasourceUrl: process.env.TEST_DATABASE_URL,
});
afterAll(() => prisma.$disconnect());

const EDGES: unknown[] = [null, '', ' ', 'x', '-1', '0', '1', '100', '1000000', 'ACTIVE', 'CANCELLED', 'DRAFT', 'POSTED', 'VOID', '2000-01-01', '2999-12-31T00:00:00Z', [], {}, ['a'], true, false];

describe('CHECK constraints', () => {
  it('parse, every one of them', () => {
    const failed: string[] = [];
    for (const [table, list] of Object.entries(checks))
      for (const c of list)
        try {
          parseCheck(c.def);
        } catch (e) {
          failed.push(`${table}.${c.name}: ${(e as Error).message.slice(0, 200)}`);
        }
    expect(failed).toEqual([]);
  });

  // A comparison with PostgreSQL itself, so only while it runs.
  it.skipIf(process.env.T2T_POSTGRES === 'off')('agree with PostgreSQL on existing and edited records', async () => {
    let compared = 0;
    const mismatches: string[] = [];
    for (const [table, list] of Object.entries(checks)) {
      await prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
          const rows = await tx.$queryRawUnsafe<{ j: Record<string, unknown> }[]>(`SELECT to_jsonb(t) AS j FROM ${table} t ORDER BY random() LIMIT 6`);
          const columns = (await tx.$queryRawUnsafe<{ c: string }[]>(`SELECT attname AS c FROM pg_attribute WHERE attrelid = '${table}'::regclass AND attnum > 0 AND NOT attisdropped`)).map(
            (r) => r.c,
          );
          // Edges only for the columns the table's checks name.
          const named = columns.filter((c) => list.some((x) => new RegExp(`\\b${c}\\b`).test(x.def)));
          const verdicts = list.map((c) => `(${c.def.replace(/^CHECK\s*/i, '').replace(/\s+NOT VALID$/i, '')}) IS NOT FALSE AS "${c.name}"`).join(', ');
          const parsed = new Map(list.map((c) => [c.name, parseCheck(c.def)]));
          const variants: Record<string, unknown>[] = [];
          for (const { j } of rows) {
            variants.push(j);
            for (const col of named) for (const e of EDGES) variants.push({ ...j, [col]: e });
          }
          for (const v of variants) {
            await tx.$executeRawUnsafe('SAVEPOINT probe');
            let res: Record<string, unknown>;
            try {
              // The edited record in its column types, as PostgreSQL would store it, and each check's verdict.
              [res] = await tx.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT t.*, ${verdicts} FROM (SELECT (jsonb_populate_record(null::${table}, $1::jsonb)).*) t`, JSON.stringify(v));
              await tx.$executeRawUnsafe('RELEASE SAVEPOINT probe');
            } catch {
              // The edit is not a value of that column's type (or the check itself errors in PostgreSQL).
              await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT probe');
              continue;
            }
            const row = Object.fromEntries(columns.map((c) => [c, res[c] ?? null]));
            for (const c of list) {
              compared++;
              const ours = passes(parsed.get(c.name)!, row);
              if (ours !== res[c.name]) mismatches.push(`${table}.${c.name}: PostgreSQL ${res[c.name]}, ours ${ours} for ${JSON.stringify(v).slice(0, 300)}`);
            }
          }
        },
        { timeout: 120_000, maxWait: 30_000 },
      );
    }
    expect(mismatches.slice(0, 20)).toEqual([]);
    expect(compared).toBeGreaterThan(0);
  }, 900_000);
});
