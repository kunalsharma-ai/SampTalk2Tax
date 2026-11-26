import { Inject, Injectable } from '@nestjs/common';
import { partitioningAdvice, shardReadiness, type CollectionSize } from '@talk2tax/document-db';
import { DocumentStoreService } from '../common/document-store.service';
import { AppConfig, CONFIG } from '../config';
import { COLLECTIONS } from '../db/collections';

const GB = 1024 ** 3;

/**
 * Database partitioning (PERF-009): how big the database and its largest collections are, the
 * sizes at which splitting it across shards is worth reviewing, and which collections could be
 * sharded by organisation as they are. Sizes only, never an organisation's rows.
 */
@Injectable()
export class PartitioningService {
  constructor(
    private readonly documents: DocumentStoreService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async status(top = 10) {
    const db = this.documents.systemDb();
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
    sizes.sort((a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : 1));
    const thresholds = { databaseBytes: this.config.PARTITIONING_REVIEW_DATABASE_GB * GB, collectionBytes: this.config.PARTITIONING_REVIEW_COLLECTION_GB * GB };
    const largest = sizes.slice(0, Math.max(1, Math.min(top, 50)));
    const readiness = shardReadiness(COLLECTIONS);
    const states = new Map(readiness.collections.map((c) => [c.name, c.state]));
    return {
      checkedAt: new Date(),
      shardKey: { orgId: 1 },
      databaseBytes,
      documents: Number(stats.objects ?? 0),
      thresholds,
      advice: partitioningAdvice(databaseBytes, sizes, thresholds),
      largest: largest.map((c) => ({ ...c, state: states.get(c.name) ?? 'GLOBAL' })),
      readiness: { counts: readiness.counts, notReady: readiness.collections.filter((c) => c.state === 'NEEDS_ORG_PREFIX' || c.state === 'GLOBAL_LOOKUP') },
    };
  }
}
