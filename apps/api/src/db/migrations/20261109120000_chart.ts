import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { accounts, fiscalPeriods } from '../collections/chart';

/** The chart of accounts and fiscal periods move from PostgreSQL. */
export default defineMigration({
  id: '20261109120000_chart',
  async up(db) {
    for (const def of [accounts, fiscalPeriods]) await ensureCollection(db, def);
  },
});
