import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * The explainable AI ledger (AUDIT-018, AUDIT-020, AUDIT-021, AUDIT-027, AUDIT-029, AUDIT-030):
 * one record for every call to an AI model, written when the call ends. A record is never
 * changed or deleted, and never holds the model's hidden reasoning.
 */
export interface AiDecisionRecordDoc {
  id: string;
  orgId: string;
  /** Which agent made the call (AUDIT-018). */
  agent: string;
  /** The member the agent acted for, or null for a call no member started. */
  actingForUserId: string | null;
  /** Whose key the call used: the organisation's own, or the server's. */
  keySource: 'ORGANISATION' | 'SERVER';
  modelRequested: string;
  servedModel: string | null;
  /** Fingerprints of the exact instructions and tools sent (AUDIT-020). */
  promptVersion: string;
  toolsVersion: string;
  toolNames: string[];
  /** The data the model was given (AUDIT-021). */
  dataSources: string[];
  subjectType: string | null;
  subjectId: string | null;
  /** The model's own short account of what it decided (AUDIT-030); never its hidden reasoning (AUDIT-029). */
  explanation: string | null;
  reasoningWithheld: boolean;
  stopReason: string | null;
  outcome: 'ANSWERED' | 'FAILED';
  errorName: string | null;
  inputTokens: number;
  outputTokens: number;
  /** When it ran (AUDIT-027). */
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
}

export const aiDecisionRecords = defineCollection<AiDecisionRecordDoc>({
  name: 'ai_decision_records',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'agent', 'keySource', 'modelRequested', 'promptVersion', 'toolsVersion', 'toolNames', 'dataSources', 'reasoningWithheld', 'outcome', 'startedAt', 'completedAt', 'durationMs'],
    properties: {
      agent: { bsonType: 'string', maxLength: 40 },
      keySource: { enum: ['ORGANISATION', 'SERVER'] },
      promptVersion: { bsonType: 'string', pattern: '^[0-9a-f]{12}$' },
      toolsVersion: { bsonType: 'string', pattern: '^[0-9a-f]{12}$' },
      toolNames: { bsonType: 'array', maxItems: 100 },
      dataSources: { bsonType: 'array', maxItems: 50 },
      explanation: { bsonType: ['string', 'null'], maxLength: 500 },
      reasoningWithheld: { bsonType: 'bool' },
      outcome: { enum: ['ANSWERED', 'FAILED'] },
    },
  },
  indexes: [
    { key: { orgId: 1, startedAt: -1 }, name: 'by_time' },
    { key: { orgId: 1, agent: 1, startedAt: -1 }, name: 'by_agent' },
    { key: { orgId: 1, subjectId: 1 }, name: 'by_subject', partialFilterExpression: { subjectId: { $type: 'string' } } },
  ],
  guards: {
    afterUpdate() {
      throw new GuardViolation('An AI decision record is kept as written');
    },
    beforeDelete() {
      throw new GuardViolation('AI decision records are kept as a record');
    },
  },
});
