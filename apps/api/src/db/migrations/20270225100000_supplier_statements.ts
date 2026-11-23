import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { supplierStatements } from '../collections/supplier-statements';

/** Supplier statements (AP-011). */
export default defineMigration({
  id: '20270225100000_supplier_statements',
  async up(db) {
    await ensureCollection(db, supplierStatements);
  },
});
