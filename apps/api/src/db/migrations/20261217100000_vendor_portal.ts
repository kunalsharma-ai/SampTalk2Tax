import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/** Vendor portal links and submissions (AP-013) kept in step with PostgreSQL. */
export default defineMigration({
  id: '20261217100000_vendor_portal',
  async up(db) {
    for (const info of mirrorModels(['VendorPortalLink', 'VendorPortalSubmission'])) await ensureCollection(db, info.def);
  },
});
