import { Prisma } from '@talk2tax/database';
import type { PrismaService, Tx } from '../common/prisma.service';

/**
 * What is still open on documents: their total less the allocations not removed, with the date of
 * the last allocation. Replaces the SQL subqueries over allocations (target_id = d.id AND
 * removed_on IS NULL), counting only allocations up to `asOf` when given; the reads go to MongoDB
 * through Prisma.
 */
export async function withOpen<T extends { id: string; total: Prisma.Decimal }>(db: Tx | PrismaService, orgId: string, docs: T[], asOf?: Date): Promise<(T & { allocated: Prisma.Decimal; open: Prisma.Decimal; lastAllocated: Date | null })[]> {
  if (!docs.length) return [];
  const allocs = await db.allocation.findMany({ where: { orgId, targetId: { in: docs.map((d) => d.id) }, removedOn: null, ...(asOf ? { date: { lte: asOf } } : {}) }, select: { targetId: true, amount: true, date: true } });
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

/**
 * What was still open on documents on a past or present date: allocations made by then and not
 * removed by then. Replaces the SQL `d.total - SUM(a.amount WHERE a.date <= asOf AND (removed_on
 * IS NULL OR removed_on > asOf))`.
 */
export async function openAsOf<T extends { id: string; total: Prisma.Decimal }>(db: Tx | PrismaService, orgId: string, docs: T[], asOf: Date): Promise<(T & { open: Prisma.Decimal })[]> {
  if (!docs.length) return [];
  const allocs = await db.allocation.findMany({ where: { orgId, targetId: { in: docs.map((d) => d.id) }, date: { lte: asOf }, OR: [{ removedOn: null }, { removedOn: { gt: asOf } }] }, select: { targetId: true, amount: true } });
  const by = new Map<string, Prisma.Decimal>();
  for (const a of allocs) by.set(a.targetId, (by.get(a.targetId) ?? new Prisma.Decimal(0)).plus(a.amount));
  return docs.map((d) => ({ ...d, open: d.total.minus(by.get(d.id) ?? 0) }));
}

/** Documents with an open dispute (the SQL NOT_DISPUTED filter, inverted). */
export async function disputedIds(db: Tx | PrismaService, orgId: string, documentIds?: string[]): Promise<Set<string>> {
  const rows = await db.invoiceDispute.findMany({ where: { orgId, status: 'OPEN', ...(documentIds ? { documentId: { in: documentIds } } : {}) }, select: { documentId: true } });
  return new Set(rows.map((r) => r.documentId));
}
