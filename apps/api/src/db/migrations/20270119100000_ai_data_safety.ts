import { defineMigration } from '@talk2tax/document-db';

/** AI data safety (SEC-029/031): copilot_settings.redaction (defaults) and copilot_messages.safety (none recorded before). */
export default defineMigration({
  id: '20270119100000_ai_data_safety',
  async up(db) {
    await db.collection('copilot_settings').updateMany({ redaction: { $exists: false } }, { $set: { redaction: {} } });
    await db.collection('copilot_messages').updateMany({ safety: { $exists: false } }, { $set: { safety: null } });
  },
});
