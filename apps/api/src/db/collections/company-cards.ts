import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Company cards (EXP-011 corporate cards, EXP-012 virtual cards). A card programme is one card
 * provider's account with the organisation, paid through one liability account; the provider
 * talks to Talk2Tax with a secret token made for the programme (only its SHA-256 is kept). Cards
 * carry the controls finance sets (holder, monthly limit, frozen or cancelled) and only the last
 * four digits of the card number. Card transactions arrive from the provider, are explained by
 * the cardholder and posted to the books by finance. Everything is kept as a record.
 */
export interface CardProgramDoc {
  id: string;
  orgId: string;
  name: string;
  provider: string;
  liabilityAccountId: string;
  currency: string;
  status: 'ACTIVE' | 'REVOKED';
  prefix: string;
  tokenHash: string;
  createdById: string;
  createdAt: Date;
  revokedAt: Date | null;
  revokedById: string | null;
  lastDeliveryAt: Date | null;
  deliveryCount: number;
  transactionsReceived: number;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const cardPrograms = defineCollection<CardProgramDoc>({
  name: 'card_programs',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'name', 'provider', 'liabilityAccountId', 'currency', 'status', 'prefix', 'tokenHash', 'createdById', 'createdAt', 'deliveryCount', 'transactionsReceived'],
    properties: {
      name: { bsonType: 'string', minLength: 2, maxLength: 80 },
      provider: { bsonType: 'string', minLength: 2, maxLength: 80 },
      currency: { bsonType: 'string', pattern: '^[A-Z]{3}$' },
      status: { enum: ['ACTIVE', 'REVOKED'] },
      prefix: { bsonType: 'string', minLength: 8, maxLength: 8 },
      tokenHash: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
      deliveryCount: { bsonType: ['int', 'long'], minimum: 0 },
      transactionsReceived: { bsonType: ['int', 'long'], minimum: 0 },
    },
  },
  indexes: [
    { key: { tokenHash: 1 }, name: 'card_programs_token', unique: true },
    { key: { orgId: 1, createdAt: -1 }, name: 'card_programs_recent' },
  ],
  guards: {
    afterUpdate(before, after) {
      for (const k of ['liabilityAccountId', 'currency', 'createdById', 'createdAt'] as const) if (!same(before[k], after[k])) throw new GuardViolation('A card programme keeps its account, currency and who set it up');
      if (before.status === 'REVOKED' && (after.status !== 'REVOKED' || after.tokenHash !== before.tokenHash)) throw new GuardViolation('A disconnected card programme stays disconnected');
      if (after.deliveryCount < before.deliveryCount || after.transactionsReceived < before.transactionsReceived) throw new GuardViolation('Card programme counts only go up');
    },
    beforeDelete() {
      throw new GuardViolation('Card programmes are kept as a record');
    },
  },
});

export interface CompanyCardEvent {
  at: Date;
  byId: string | null;
  action: 'REQUESTED' | 'ISSUED' | 'FROZEN' | 'UNFROZEN' | 'CANCELLED' | 'LIMIT_CHANGED';
  note: string | null;
}

export interface CompanyCardDoc {
  id: string;
  orgId: string;
  programId: string;
  number: number;
  kind: 'CORPORATE' | 'VIRTUAL';
  holderId: string;
  label: string;
  /** Spending allowed each calendar month, in the programme's currency; null for no limit. */
  monthlyLimit: string | null;
  status: 'REQUESTED' | 'ACTIVE' | 'FROZEN' | 'CANCELLED';
  /** The last four digits only: full card numbers never reach Talk2Tax. */
  last4: string | null;
  /** The provider's own id for the card. */
  providerRef: string | null;
  /** YYYY-MM. */
  expires: string | null;
  /** For a virtual card made for one supplier, that supplier. */
  contactId: string | null;
  createdById: string;
  createdAt: Date;
  history: CompanyCardEvent[];
}

export const companyCards = defineCollection<CompanyCardDoc>({
  name: 'company_cards',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'programId', 'number', 'kind', 'holderId', 'label', 'status', 'createdById', 'createdAt', 'history'],
    properties: {
      number: { bsonType: 'int', minimum: 1 },
      kind: { enum: ['CORPORATE', 'VIRTUAL'] },
      label: { bsonType: 'string', minLength: 1, maxLength: 80 },
      monthlyLimit: { bsonType: ['string', 'null'], pattern: '^\\d{1,13}(\\.\\d{1,2})?$' },
      status: { enum: ['REQUESTED', 'ACTIVE', 'FROZEN', 'CANCELLED'] },
      last4: { bsonType: ['string', 'null'], pattern: '^\\d{4}$' },
      providerRef: { bsonType: ['string', 'null'], maxLength: 100 },
      expires: { bsonType: ['string', 'null'], pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
      history: { bsonType: 'array', maxItems: 500 },
    },
  },
  indexes: [
    { key: { orgId: 1, number: 1 }, name: 'company_cards_number', unique: true },
    { key: { orgId: 1, programId: 1, providerRef: 1 }, name: 'company_cards_provider_ref', unique: true, partialFilterExpression: { providerRef: { $type: 'string' } } },
    { key: { orgId: 1, holderId: 1 }, name: 'company_cards_holder' },
  ],
  guards: {
    beforeInsert(c) {
      if (c.status !== 'REQUESTED' && !c.last4) throw new GuardViolation('An issued card has its last four digits');
    },
    afterUpdate(before, after) {
      for (const k of ['programId', 'number', 'kind', 'createdById', 'createdAt'] as const) if (!same(before[k], after[k])) throw new GuardViolation('A card keeps its programme, number and kind');
      if (before.status === 'CANCELLED' && after.status !== 'CANCELLED') throw new GuardViolation('A cancelled card stays cancelled');
      if (after.status !== 'REQUESTED' && after.status !== 'CANCELLED' && !after.last4) throw new GuardViolation('An issued card has its last four digits');
      if (after.history.length < before.history.length) throw new GuardViolation('A card keeps its history');
    },
    beforeDelete() {
      throw new GuardViolation('Company cards are kept as a record');
    },
  },
});

export interface CardTransactionDoc {
  id: string;
  orgId: string;
  programId: string;
  cardId: string;
  holderId: string;
  /** The provider's id for the transaction: unique within the programme. */
  externalId: string;
  date: string;
  /** Positive spending, negative refund. */
  amount: string;
  currency: string;
  merchant: string;
  mcc: string | null;
  state: 'AUTHORISED' | 'SETTLED';
  status: 'UNCODED' | 'CODED' | 'POSTED' | 'EXCLUDED';
  accountId: string | null;
  note: string | null;
  codedById: string | null;
  codedAt: Date | null;
  journalEntryId: string | null;
  postedById: string | null;
  postedAt: Date | null;
  excludedReason: string | null;
  excludedById: string | null;
  receivedAt: Date;
  updatedAt: Date;
}

export const cardTransactions = defineCollection<CardTransactionDoc>({
  name: 'card_transactions',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'programId', 'cardId', 'holderId', 'externalId', 'date', 'amount', 'currency', 'merchant', 'state', 'status', 'receivedAt', 'updatedAt'],
    properties: {
      externalId: { bsonType: 'string', minLength: 1, maxLength: 100 },
      date: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      amount: { bsonType: 'string', pattern: '^-?\\d{1,13}(\\.\\d{1,3})?$' },
      currency: { bsonType: 'string', pattern: '^[A-Z]{3}$' },
      merchant: { bsonType: 'string', minLength: 1, maxLength: 120 },
      mcc: { bsonType: ['string', 'null'], pattern: '^\\d{4}$' },
      state: { enum: ['AUTHORISED', 'SETTLED'] },
      status: { enum: ['UNCODED', 'CODED', 'POSTED', 'EXCLUDED'] },
      note: { bsonType: ['string', 'null'], maxLength: 300 },
      excludedReason: { bsonType: ['string', 'null'], maxLength: 300 },
    },
  },
  indexes: [
    { key: { orgId: 1, programId: 1, externalId: 1 }, name: 'card_transactions_external', unique: true },
    { key: { orgId: 1, cardId: 1, date: -1 }, name: 'card_transactions_card' },
    { key: { orgId: 1, holderId: 1, date: -1 }, name: 'card_transactions_holder' },
  ],
  guards: {
    beforeInsert(t) {
      if (t.status !== 'UNCODED' && t.status !== 'CODED') throw new GuardViolation('A card transaction arrives unposted');
    },
    afterUpdate(before, after) {
      for (const k of ['programId', 'cardId', 'holderId', 'externalId', 'currency', 'receivedAt'] as const) if (!same(before[k], after[k])) throw new GuardViolation('A card transaction keeps its card and provider id');
      if (before.status === 'POSTED') throw new GuardViolation('A posted card transaction is final');
      if (after.status === 'POSTED' && (!after.journalEntryId || !after.accountId || after.state !== 'SETTLED')) throw new GuardViolation('A posted card transaction is settled and names its account and journal');
      if (after.status === 'EXCLUDED' && !after.excludedReason) throw new GuardViolation('An excluded card transaction says why');
    },
    beforeDelete() {
      throw new GuardViolation('Card transactions are kept as a record');
    },
  },
});
