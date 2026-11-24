import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { taxDocumentReadings } from '../collections/tax-document-readings';

/** Tax document interpretation (TAX-043): readings of tax documents people received. */
export default defineMigration({
  id: '20270313100000_tax_document_readings',
  async up(db) {
    await ensureCollection(db, taxDocumentReadings);
  },
});
