import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { usVendorTaxProfiles } from '../collections/us-sales-tax';

/** US 1099 reporting (TAX-029): what each vendor's W-9 says. */
export default defineMigration({
  id: '20270312100000_us_vendor_tax_profiles',
  async up(db) {
    await ensureCollection(db, usVendorTaxProfiles);
  },
});
