import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { contractMatchDismissals } from '../collections/contract-matching';

/** Contract-to-invoice matches a person dismissed (AR-041). */
export default defineMigration({
  id: '20270212100000_contract_matching',
  async up(db) {
    await ensureCollection(db, contractMatchDismissals);
  },
});
