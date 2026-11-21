import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { orgSetup } from '../collections/org-setup';

/** Organisation setup profile and activation (UX-004 to UX-006, UX-017 to UX-019). */
export default defineMigration({
  id: '20270128100000_org_setup',
  async up(db) {
    await ensureCollection(db, orgSetup);
  },
});
