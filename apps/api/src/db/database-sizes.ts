import type { CollectionSize } from '@talk2tax/document-db';
import type { DocumentStoreService } from '../common/document-store.service';
import { COLLECTIONS } from './collections';

/** Database partitioning (PERF-009): the database's size and each collection's documents and bytes (data plus indexes). Sizes only. */
export async function databaseSizes(store: DocumentStoreService): Promise<{ databaseBytes: number; documents: number; sizes: CollectionSize[] }> {
  const db = store.systemDb();
  const stats = (await db.command({ dbStats: 1 })) as { dataSize?: number; indexSize?: number; objects?: number };
  const databaseBytes = Number(stats.dataSize ?? 0) + Number(stats.indexSize ?? 0);
  const sizes: CollectionSize[] = [];
  // A few collections at a time, so a database with hundreds of collections answers in seconds.
  const queue = [...COLLECTIONS];
  const worker = async () => {
    for (let def = queue.shift(); def; def = queue.shift()) {
      // $collStats storageStats: size is the documents' data, totalIndexSize their indexes.
      const row = await db
        .collection(def.name)
        .aggregate<{ storageStats?: { count?: number; size?: number; totalIndexSize?: number } }>([{ $collStats: { storageStats: {} } }])
        .next()
        .catch(() => null);
      const s = row?.storageStats;
      if (s) sizes.push({ name: def.name, documents: Number(s.count ?? 0), bytes: Number(s.size ?? 0) + Number(s.totalIndexSize ?? 0) });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { databaseBytes, documents: Number(stats.objects ?? 0), sizes };
}
