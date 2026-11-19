import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/** Data retention policies (SEC-020): retention_settings per organisation and kind of data, and retention_runs. */
export default defineMigration({
  id: '20270116100000_data_retention',
  async up(db) {
    for (const info of mirrorModels(['RetentionSetting', 'RetentionRun'])) await ensureCollection(db, info.def);
  },
});
