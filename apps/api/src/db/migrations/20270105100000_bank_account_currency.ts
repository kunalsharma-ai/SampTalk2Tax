import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { accounts } from '../collections/chart';

/** Bank and cash accounts kept in another currency (BANK-012): the accounts validator gains `currency`. */
export default defineMigration({
  id: '20270105100000_bank_account_currency',
  async up(db) {
    await ensureCollection(db, accounts);
  },
});
