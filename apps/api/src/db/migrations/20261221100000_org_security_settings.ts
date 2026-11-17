import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { orgSecuritySettings } from '../collections/security';

/** Organisation sign-in rules: require two-step sign-in for every member. */
export default defineMigration({
  id: '20261221100000_org_security_settings',
  async up(db) {
    await ensureCollection(db, orgSecuritySettings);
  },
});
