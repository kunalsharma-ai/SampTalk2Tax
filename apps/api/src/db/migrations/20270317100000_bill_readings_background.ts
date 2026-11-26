import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { billReadings } from '../collections/bill-readings';

/**
 * Bills read in the background (PERF-013): bill readings may now be QUEUED, READING or FAILED,
 * carry the worker's lease, tries and failure, and are found by status for the worker.
 */
export default defineMigration({
  id: '20270317100000_bill_readings_background',
  async up(db) {
    await ensureCollection(db, billReadings);
  },
});
