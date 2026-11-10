import { Prisma } from '@talk2tax/database';
import type { PrismaService, Tx } from '../common/prisma.service';

/**
 * What is still open on documents: their total less the allocations not removed, with the date of
 * the last allocation. Replaces the SQL subqueries over allocations (target_id = d.id AND
 * removed_on IS NULL); the reads go to MongoDB through Prisma.
 */
export async function withOpen<T extends { id: string; total: Prisma.Decimal }>(db: Tx | PrismaService, orgId: string, docs: T[]): Promise<(T & { allocated: Prisma.Decimal; open: Prisma.Decimal; lastAllocated: Date | null })[]> {
  if (!docs.length) return [];
  const allocs = await db.allocation.findMany({ where: { orgId, targetId: { in: docs.map((d) => d.id) }, removedOn: null }, select: { targetId: true, amount: true, date: true } });
  const by = new Map<string, { allocated: Prisma.Decimal; last: Date | null }>();
  for (const a of allocs) {
    const t = by.get(a.targetId) ?? { allocated: new Prisma.Decimal(0), last: null };
    by.set(a.targetId, { allocated: t.allocated.plus(a.amount), last: !t.last || a.date > t.last ? a.date : t.last });
  }
  return docs.map((d) => {
    const a = by.get(d.id);
    const allocated = a?.allocated ?? new Prisma.Decimal(0);
    return { ...d, allocated, open: d.total.minus(allocated), lastAllocated: a?.last ?? null };
  });
}

/** PostgreSQL's ROUND(numeric, n): half away from zero. */
export const roundPg = (v: Prisma.Decimal, places: number) => v.toDecimalPlaces(places, Prisma.Decimal.ROUND_HALF_UP);

/** Whole days from `a` to `b` (both UTC-midnight dates), as PostgreSQL's date subtraction. */
export const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);

/** Codes compared as PostgreSQL compares them in the C collation (byte order). */
export const byCode = <T extends { code: string }>(a: T, b: T) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
