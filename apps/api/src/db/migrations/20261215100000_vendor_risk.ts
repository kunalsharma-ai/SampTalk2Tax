import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/** The collection for vendor risk reviews (AP-024), kept append-only by the PostgreSQL trigger until its guard replaces it. */
export default defineMigration({
  id: '20261215100000_vendor_risk',
  async up(db) {
    for (const info of mirrorModels(['VendorRiskReview'])) await ensureCollection(db, info.def);
  },
});
