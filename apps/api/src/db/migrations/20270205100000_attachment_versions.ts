import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { attachments } from '../collections/sales';

/** Document versioning (AUDIT-007): each file is replaced by a later version at most once. */
export default defineMigration({
  id: '20270205100000_attachment_versions',
  async up(db) {
    await ensureCollection(db, attachments);
  },
});
