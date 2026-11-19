import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/**
 * The platform-wide AI emergency shutdown (SEC-038): platform_ai_switches, each stop and resume.
 * Copilot tool permissions (SEC-030): copilot_settings.disabledTools, empty for every organisation.
 */
export default defineMigration({
  id: '20270115100000_platform_ai_switch',
  async up(db) {
    for (const info of mirrorModels(['PlatformAiSwitch'])) await ensureCollection(db, info.def);
    await db.collection('copilot_settings').updateMany({ disabledTools: { $exists: false } }, { $set: { disabledTools: [] } });
  },
});
