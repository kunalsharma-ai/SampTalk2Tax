import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * UK VAT (TAX-030). `vat_settings` holds one organisation's VAT registration: its number, its
 * return stagger, the treatment of lines with no tax rate and the VAT treatment of each tax rate.
 * `vat_returns` records each return the business has submitted to HMRC: the nine boxes as
 * submitted, the period's own figures (to find later changes) and the corrections of earlier
 * periods it carried. A submitted return is never edited or deleted.
 */
export interface VatSettingsDoc {
  id: string;
  orgId: string;
  vrn: string;
  /** The day the registration took effect (YYYY-MM-DD); no return is due for periods before it. */
  registeredFrom: string;
  stagger: string;
  untaxedTreatment: string;
  treatments: { taxRateId: string; treatment: string }[];
  updatedById: string;
  updatedAt: Date;
}

const TREATMENT = { enum: ['STANDARD', 'REDUCED', 'ZERO', 'EXEMPT', 'OUTSIDE_SCOPE'] };
const MONEY = { bsonType: 'string', pattern: '^-?[0-9]+(\\.[0-9]+)?$' };

export const vatSettings = defineCollection<VatSettingsDoc>({
  name: 'vat_settings',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'vrn', 'registeredFrom', 'stagger', 'untaxedTreatment', 'treatments', 'updatedById', 'updatedAt'],
    properties: {
      vrn: { bsonType: 'string', pattern: '^GB[0-9]{9}([0-9]{3})?$' },
      registeredFrom: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      stagger: { enum: ['MONTHLY', 'QUARTERLY_MAR', 'QUARTERLY_APR', 'QUARTERLY_MAY'] },
      untaxedTreatment: TREATMENT,
      treatments: { bsonType: 'array', maxItems: 200, items: { bsonType: 'object', required: ['taxRateId', 'treatment'], properties: { taxRateId: { bsonType: 'string' }, treatment: TREATMENT } } },
    },
  },
  indexes: [{ key: { orgId: 1 }, name: 'one_per_org', unique: true }],
});

export interface VatBoxesDoc {
  box1: string;
  box2: string;
  box3: string;
  box4: string;
  box5: string;
  box6: string;
  box7: string;
  box8: string;
  box9: string;
}

export interface VatReturnDoc {
  id: string;
  orgId: string;
  periodStart: string;
  periodEnd: string;
  vrn: string;
  boxes: VatBoxesDoc;
  own: { box1: string; box4: string; box6: string; box7: string };
  corrections: { periodEnd: string; box1: string; box4: string }[];
  /** The day it was submitted to HMRC, and HMRC's reference for it, as the business records them. */
  submittedOn: string;
  reference: string | null;
  recordedById: string;
  recordedAt: Date;
}

export const vatReturns = defineCollection<VatReturnDoc>({
  name: 'vat_returns',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'periodStart', 'periodEnd', 'vrn', 'boxes', 'own', 'corrections', 'submittedOn', 'recordedById', 'recordedAt'],
    properties: {
      periodStart: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      periodEnd: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      submittedOn: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      boxes: { bsonType: 'object', required: ['box1', 'box2', 'box3', 'box4', 'box5', 'box6', 'box7', 'box8', 'box9'], properties: { box1: MONEY, box4: MONEY, box5: MONEY, box6: MONEY, box7: MONEY } },
      own: { bsonType: 'object', required: ['box1', 'box4', 'box6', 'box7'] },
      corrections: { bsonType: 'array', items: { bsonType: 'object', required: ['periodEnd', 'box1', 'box4'], properties: { box1: MONEY, box4: MONEY } } },
      reference: { bsonType: ['string', 'null'], maxLength: 100 },
    },
  },
  indexes: [{ key: { orgId: 1, periodEnd: 1 }, name: 'one_return_a_period', unique: true }],
  guards: {
    afterUpdate() {
      throw new GuardViolation('A submitted VAT return is not changed; correct it on a later return');
    },
    beforeDelete() {
      throw new GuardViolation('A submitted VAT return is kept');
    },
  },
});
