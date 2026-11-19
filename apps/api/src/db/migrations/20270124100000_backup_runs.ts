import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/** Backups and restore drills (SEC-021/022): backup_runs, what the backup command did. */
export default defineMigration({
  id: '20270124100000_backup_runs',
  async up(db) {
    for (const info of mirrorModels(['BackupRun'])) await ensureCollection(db, info.def);
  },
});
