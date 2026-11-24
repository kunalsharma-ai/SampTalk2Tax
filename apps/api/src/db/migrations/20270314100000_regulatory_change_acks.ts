import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { regulatoryChangeAcks } from '../collections/regulatory-changes';

/** Regulatory change monitoring (TAX-046): the law changes each organisation has dealt with. */
export default defineMigration({
  id: '20270314100000_regulatory_change_acks',
  async up(db) {
    await ensureCollection(db, regulatoryChangeAcks);
  },
});
