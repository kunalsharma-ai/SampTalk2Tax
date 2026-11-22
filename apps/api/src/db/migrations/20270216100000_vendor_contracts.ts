import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { vendorContracts } from '../collections/vendor-contracts';

/** Vendor contracts (AP-032), which posted bills are checked against. */
export default defineMigration({
  id: '20270216100000_vendor_contracts',
  async up(db) {
    await ensureCollection(db, vendorContracts);
  },
});
