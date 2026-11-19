import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { attachments } from '../collections/sales';
import { taxNoticeFiles } from '../collections/tax-notices';
import { mirrorModels } from '../mirror-writes';

/**
 * Encryption at rest for uploaded files (SEC-011): attachments, tax notice files and vendor
 * portal invoices carry contentKeyId, the key that sealed their bytes. Files stored before keep
 * no key id and are sealed later under Platform admin → Encryption keys.
 */
export default defineMigration({
  id: '20270125100000_file_encryption',
  async up(db) {
    await ensureCollection(db, attachments);
    await ensureCollection(db, taxNoticeFiles);
    for (const info of mirrorModels(['VendorPortalSubmission'])) await ensureCollection(db, info.def);
  },
});
