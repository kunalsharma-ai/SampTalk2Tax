import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { attachments } from '../collections/sales';

/** An index on each file's SHA-256, so the same file on other records is found quickly (DOC-018). */
export default defineMigration({
  id: '20261228100000_attachment_hashes',
  async up(db) {
    await ensureCollection(db, attachments);
  },
});
