import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { MIRRORED } from '../mirrored-models';

/**
 * Large volumes (PERF-002): the shared tables whose rows may belong to an organisation (the audit
 * trail, usage and error events, security alerts, ...) get an index on orgId, and the audit trail
 * its other indexes, so reading one organisation's rows no longer scans everyone's.
 */
export default defineMigration({
  id: '20270315100000_shared_table_indexes',
  async up(db) {
    for (const info of MIRRORED) if (!info.tenant && info.scalars.some((f) => f.name === 'orgId')) await ensureCollection(db, info.def);
  },
});
