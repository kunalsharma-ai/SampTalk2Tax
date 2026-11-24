import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { usSalesTaxRegistrations } from '../collections/us-sales-tax';
import { contacts } from '../collections/sales';

/** US sales tax (TAX-028): state registrations, and contacts carry their state or region. */
export default defineMigration({
  id: '20270311100000_us_sales_tax',
  async up(db) {
    await ensureCollection(db, usSalesTaxRegistrations);
    await ensureCollection(db, contacts);
  },
});
