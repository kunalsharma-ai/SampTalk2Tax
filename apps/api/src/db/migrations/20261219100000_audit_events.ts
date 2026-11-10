import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/**
 * The audit trail and workflow cursors kept in step with PostgreSQL (step 10b), and a numeric copy of the id
 * (idNumber) for every table keyed by a sequence number, so ranges and order compare numbers.
 */
export default defineMigration({
  id: '20261219100000_audit_events',
  async up(db) {
    for (const info of mirrorModels(['AuditEvent', 'UsageEvent', 'ErrorEvent', 'SupportAccessView', 'PlatformBillingProfile'])) {
      await db.collection(info.def.name).updateMany({ idNumber: { $exists: false } }, [{ $set: { idNumber: { $toLong: '$_id' } } }]);
      await ensureCollection(db, info.def);
    }
    // Where each organisation's workflows have read its audit trail to.
    for (const info of mirrorModels(['WorkflowCursor'])) await ensureCollection(db, info.def);
  },
});
