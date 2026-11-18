import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { financialTags } from '../collections/financial-tags';

/** Financial tags: organization-defined reporting dimensions such as locations. */
export default defineMigration({
  id: '20261225100000_financial_tags',
  async up(db) {
    await ensureCollection(db, financialTags);
  },
});
