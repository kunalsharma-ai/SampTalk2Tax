import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { accessRules } from '../collections/security';

/** Access rules (SEC-004): network and time conditions on roles and people. */
export default defineMigration({
  id: '20270126100000_access_rules',
  async up(db) {
    await ensureCollection(db, accessRules);
  },
});
