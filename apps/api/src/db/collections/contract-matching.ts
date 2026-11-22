import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Contract-to-invoice matches a person dismissed (AR-041): this invoice is not billing for this
 * contract, with why. Kept as recorded; a dismissed pair is not suggested again.
 */
export interface ContractMatchDismissalDoc {
  id: string;
  orgId: string;
  documentId: string;
  contractId: string;
  reason: string;
  dismissedById: string;
  dismissedAt: Date;
}

export const contractMatchDismissals = defineCollection<ContractMatchDismissalDoc>({
  name: 'contract_match_dismissals',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'documentId', 'contractId', 'reason', 'dismissedById', 'dismissedAt'],
    properties: {
      reason: { bsonType: 'string', minLength: 3, maxLength: 500 },
      dismissedAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { orgId: 1, documentId: 1, contractId: 1 }, name: 'org_document_contract', unique: true }],
  guards: {
    afterUpdate() {
      throw new GuardViolation('Dismissed contract matches are kept as recorded');
    },
    beforeDelete() {
      throw new GuardViolation('Dismissed contract matches are kept as recorded');
    },
  },
});
