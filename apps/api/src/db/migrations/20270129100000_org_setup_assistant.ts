import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { orgSetup } from '../collections/org-setup';

/** The onboarding assistant's reading and decisions on the setup record (UX-020 to UX-022). */
export default defineMigration({
  id: '20270129100000_org_setup_assistant',
  async up(db) {
    await ensureCollection(db, orgSetup);
  },
});
