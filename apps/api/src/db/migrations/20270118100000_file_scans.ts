import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/** Upload checks and malware scanning (SEC-018/019): file_scans. */
export default defineMigration({
  id: '20270118100000_file_scans',
  async up(db) {
    for (const info of mirrorModels(['FileScan'])) await ensureCollection(db, info.def);
  },
});
