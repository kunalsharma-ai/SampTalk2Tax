import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/** What each AI model costs the organisation per million tokens (AGENT-053): ai_model_prices. */
export default defineMigration({
  id: '20270107100000_ai_model_prices',
  async up(db) {
    for (const info of mirrorModels(['AiModelPrice'])) await ensureCollection(db, info.def);
  },
});
