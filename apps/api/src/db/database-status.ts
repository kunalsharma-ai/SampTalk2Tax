import type { DocumentStoreService } from '../common/document-store.service';
import { MIGRATIONS } from './migrations';

/** The database for System health (ADMIN-010): how fast it answers, its size, connections, version and migrations. */
export async function databaseStatus(store: DocumentStoreService) {
  const db = store.systemDb();
  const t0 = process.hrtime.bigint();
  try {
    await db.command({ ping: 1 });
    const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const [stats, status, build, last, applied] = await Promise.all([
      db.command({ dbStats: 1 }) as Promise<{ dataSize?: number; indexSize?: number }>,
      // serverStatus needs the clusterMonitor role; without it the connection counts are left out.
      (db.admin().command({ serverStatus: 1, repl: 0, metrics: 0, locks: 0 }) as Promise<{ connections?: { current: number; available: number } }>).catch(() => null),
      db.admin().command({ buildInfo: 1 }) as Promise<{ version?: string }>,
      db.collection<{ _id: string; appliedAt: Date }>('_migrations').find().sort({ _id: -1 }).limit(1).toArray(),
      db.collection('_migrations').countDocuments(),
    ]);
    const conn = status?.connections;
    return {
      status: latencyMs > 500 ? 'SLOW' : 'OK',
      latencyMs: Math.round(latencyMs * 10) / 10,
      sizeBytes: Number(stats.dataSize ?? 0) + Number(stats.indexSize ?? 0),
      connections: conn ? conn.current : null,
      maxConnections: conn ? conn.current + conn.available : null,
      mongodb: build.version ?? null,
      lastMigration: last[0] ? { name: last[0]._id, at: last[0].appliedAt } : null,
      unfinishedMigrations: Math.max(0, MIGRATIONS.length - applied),
    };
  } catch (e) {
    return { status: 'DOWN', error: (e as Error).message.slice(0, 300), latencyMs: null, sizeBytes: null, connections: null, maxConnections: null, mongodb: null, lastMigration: null, unfinishedMigrations: null };
  }
}
