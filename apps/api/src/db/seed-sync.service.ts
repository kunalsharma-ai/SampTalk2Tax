import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DocumentStoreService } from '../common/document-store.service';
import { PrismaService, withSystemAccess } from '../common/prisma.service';
import { copyMirroredTables, pgOf } from './mirror-writes';

/**
 * Reference rows the SQL migrations seed (the plans) are read from MongoDB now, with the same
 * ids PostgreSQL gave them, because subscriptions in both databases point at them. On start,
 * the API copies any such row MongoDB does not have yet. It is a no-op once they are there,
 * and goes away with PostgreSQL in the last part of step 8.
 */
export const SEEDED_BY_SQL = ['Plan'] as const;

@Injectable()
export class SeedSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger('SeedSync');

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const copied = await copyMirroredTables(
      (model, page) => this.prisma.$transaction((tx) => withSystemAccess(tx, () => pgOf((tx as unknown as Record<string, Parameters<typeof pgOf>[0]>)[model]).findMany(page) as Promise<Record<string, unknown>[]>)),
      this.store,
      SEEDED_BY_SQL,
    );
    const n = Object.values(copied).reduce((a, b) => a + b, 0);
    if (n) this.logger.log(`Copied ${n} seeded reference rows to MongoDB`);
  }
}
