import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { billReadings } from '../collections/bill-readings';

/** Bills read from a file or pasted text (AP-025). */
export default defineMigration({
  id: '20270306100000_bill_readings',
  async up(db) {
    await ensureCollection(db, billReadings);
  },
});
