import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { accountReconciliations } from '../collections/account-reconciliations';

/** Balance sheet account reconciliations. */
export default defineMigration({
  id: '20261227100000_account_reconciliations',
  async up(db) {
    await ensureCollection(db, accountReconciliations);
  },
});
