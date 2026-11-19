import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/**
 * Model access policies (SEC-034): platform_model_policies, each change to the models allowed
 * across Talk2Tax, and copilot_settings.allowedModels, empty (every allowed model) to start with.
 */
export default defineMigration({
  id: '20270120100000_model_access',
  async up(db) {
    for (const info of mirrorModels(['PlatformModelPolicy'])) await ensureCollection(db, info.def);
    await db.collection('copilot_settings').updateMany({ allowedModels: { $exists: false } }, { $set: { allowedModels: [] } });
  },
});
