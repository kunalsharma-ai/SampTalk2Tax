import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/** Automated journal suggestions (GL-036): journal_suggestion_decisions, what was done with each suggestion. */
export default defineMigration({
  id: '20270114100000_journal_suggestions',
  async up(db) {
    for (const info of mirrorModels(['JournalSuggestionDecision'])) await ensureCollection(db, info.def);
  },
});
