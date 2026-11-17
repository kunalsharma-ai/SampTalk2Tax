import { DocumentStore, runMigrations } from '@talk2tax/document-db';
import { COLLECTIONS } from './collections';
import { MIGRATIONS } from './migrations';

/**
 * Applies pending MongoDB migrations to MONGODB_URL, then exits.
 *   pnpm --filter @talk2tax/api run db:migrate:mongo
 * The release step runs it once before new API containers start.
 */
export async function migrate(url: string, log: (line: string) => void = console.log): Promise<string[]> {
  const store = new DocumentStore({ url, collections: COLLECTIONS, context: () => ({ bypass: true }) });
  await store.connect();
  try {
    const report = await runMigrations(store.systemDb(), MIGRATIONS);
    log(report.applied.length ? `Applied ${report.applied.join(', ')}` : `Nothing to apply (${report.alreadyApplied} already applied)`);
    return report.applied;
  } finally {
    await store.close();
  }
}

if (require.main === module) {
  const url = process.env.MONGODB_URL;
  if (!url) {
    console.error('MONGODB_URL is required');
    process.exit(1);
  }
  migrate(url).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
