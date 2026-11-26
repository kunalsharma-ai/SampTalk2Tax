import { Inject, Injectable } from '@nestjs/common';
import { partitioningAdvice, shardReadiness } from '@talk2tax/document-db';
import { DocumentStoreService } from '../common/document-store.service';
import { AppConfig, CONFIG } from '../config';
import { COLLECTIONS } from '../db/collections';
import { databaseSizes } from '../db/database-sizes';

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
    const { databaseBytes, documents, sizes } = await databaseSizes(this.documents);
    sizes.sort((a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : 1));
    const thresholds = { databaseBytes: this.config.PARTITIONING_REVIEW_DATABASE_GB * GB, collectionBytes: this.config.PARTITIONING_REVIEW_COLLECTION_GB * GB };
    const largest = sizes.slice(0, Math.max(1, Math.min(top, 50)));
    const readiness = shardReadiness(COLLECTIONS);
    const states = new Map(readiness.collections.map((c) => [c.name, c.state]));
    return {
      checkedAt: new Date(),
      shardKey: { orgId: 1 },
      databaseBytes,
      documents,
      thresholds,
      advice: partitioningAdvice(databaseBytes, sizes, thresholds),
      largest: largest.map((c) => ({ ...c, state: states.get(c.name) ?? 'GLOBAL' })),
      readiness: { counts: readiness.counts, notReady: readiness.collections.filter((c) => c.state === 'NEEDS_ORG_PREFIX' || c.state === 'GLOBAL_LOOKUP') },
    };
  }
}
