import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { vatReturns } from '../collections/vat-returns';

/** Australia's BAS (TAX-035): its GST items are G1, 1A and 1B, so a return's boxes no longer need a box 1. */
export default defineMigration({
  id: '20270303100000_vat_returns_bas',
  async up(db) {
    await ensureCollection(db, vatReturns);
  },
});
