import { PrismaClient } from '@talk2tax/database';
import { DocumentStore } from '@talk2tax/document-db';
import { COLLECTIONS } from '../src/db/collections';
import { compareMirrored } from '../src/db/mirror-writes';

/**
 * After the whole run: every table whose writes are kept in step must hold the same rows in
 * both databases, for the organisations this run created (older runs predate the mirror).
 */
export async function checkMirrorSince(since: Date): Promise<string[]> {
  const prisma = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
  const store = new DocumentStore({ url: process.env.TEST_MONGODB_URL!, collections: COLLECTIONS, context: () => ({ bypass: true }) });
  await store.connect();
  try {
    const read = <T>(fn: (tx: PrismaClient) => Promise<T>) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('t2t.bypass', 'on', true)`;
        return fn(tx as PrismaClient);
      });
    const orgs = await read((tx) => tx.organization.findMany({ where: { createdAt: { gte: since } }, select: { id: true } }));
    if (!orgs.length) return [];
    return await compareMirrored((model, where) => read((tx) => (tx as unknown as Record<string, { findMany(a: unknown): Promise<Record<string, unknown>[]> }>)[model].findMany({ where })), store, orgs.map((o) => o.id));
  } finally {
    await store.close();
    await prisma.$disconnect();
  }
}
