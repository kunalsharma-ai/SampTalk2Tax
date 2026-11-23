import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { vatSettings } from '../collections/vat-returns';

/** Canada's GST/HST return (TAX-034): a business number with its GST/HST account (123456782RT0001) is 15 characters. */
export default defineMigration({
  id: '20270304100000_vat_settings_business_number',
  async up(db) {
    await ensureCollection(db, vatSettings);
  },
});
