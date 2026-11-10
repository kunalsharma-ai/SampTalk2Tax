import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/** The collection for supplier GSTIN checks (AP-019), kept append-only by the PostgreSQL trigger until step 8. */
export default defineMigration({
  id: '20261214100000_supplier_tax_checks',
  async up(db) {
    for (const info of mirrorModels(['SupplierGstinCheck'])) await ensureCollection(db, info.def);
  },
});
