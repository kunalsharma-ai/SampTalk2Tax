import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { aiDecisionRecords } from '../collections/ai-decision-records';

/** The explainable AI ledger's decision records (AUDIT-018 and others). */
export default defineMigration({
  id: '20270206100000_ai_decision_records',
  async up(db) {
    await ensureCollection(db, aiDecisionRecords);
  },
});
