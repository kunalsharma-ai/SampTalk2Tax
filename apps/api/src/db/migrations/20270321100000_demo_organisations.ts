import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { demoOrganisations } from '../collections/demo-organisations';

/** Demonstration organisations (DEMO-001): the profile each was built from and what was made. */
export default defineMigration({
  id: '20270321100000_demo_organisations',
  async up(db) {
    await ensureCollection(db, demoOrganisations);
  },
});
