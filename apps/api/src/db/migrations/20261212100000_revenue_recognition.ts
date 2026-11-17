import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/** Collections for revenue recognition (AR-028): each organisation's settings and each invoice line's terms. */
export default defineMigration({
  id: '20261212100000_revenue_recognition',
  async up(db) {
    for (const info of mirrorModels(['RevenueRecognitionSettings', 'InvoiceLineRecognition'])) await ensureCollection(db, info.def);
  },
});
