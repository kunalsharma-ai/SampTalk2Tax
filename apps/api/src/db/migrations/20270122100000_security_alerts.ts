import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/** Security event monitoring (SEC-023): security_alerts, what the monitor found in the audit trail. */
export default defineMigration({
  id: '20270122100000_security_alerts',
  async up(db) {
    for (const info of mirrorModels(['SecurityAlert'])) await ensureCollection(db, info.def);
  },
});
