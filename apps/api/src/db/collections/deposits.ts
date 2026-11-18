import { defineCollection } from '@talk2tax/document-db';

/**
 * Term deposits (BANK-011, TRS-012): money placed with a bank for a fixed term at a fixed rate.
 * Placing one posts Dr deposit, Cr bank; interest earned is accrued to dates the user chooses
 * (Dr accrued interest, Cr interest income); closing it, at maturity or early, posts what the
 * bank paid and any tax deducted at source, clearing the deposit and the accrued interest.
 */
export interface DepositDoc {
  id: string;
  orgId: string;
  /** FD-000001, per organisation. */
  number: string;
  name: string;
  /** The bank or institution holding it, and its own reference (receipt or account number). */
  institution: string;
  institutionRef: string | null;
  principal: string;
  /** Percent a year. */
  annualRate: string;
  compounding: 'SIMPLE' | 'MONTHLY' | 'QUARTERLY' | 'HALF_YEARLY' | 'YEARLY';
  startDate: Date;
  maturityDate: Date;
  bankAccountId: string;
  depositAccountId: string;
  accruedInterestAccountId: string;
  interestIncomeAccountId: string;
  /** Interest accrued so far and the date it runs to (null before the first accrual). */
  accrued: string;
  accruedTo: Date | null;
  status: 'OPEN' | 'CLOSED';
  placementEntryId: string;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export const deposits = defineCollection<DepositDoc>({
  name: 'deposits',
  scope: 'tenant',
  decimals: ['principal', 'annualRate', 'accrued'],
  schema: {
    bsonType: 'object',
    required: ['orgId', 'number', 'name', 'institution', 'principal', 'annualRate', 'compounding', 'startDate', 'maturityDate', 'bankAccountId', 'depositAccountId', 'accruedInterestAccountId', 'interestIncomeAccountId', 'accrued', 'status', 'placementEntryId', 'createdById', 'createdAt', 'updatedAt'],
    properties: {
      number: { bsonType: 'string', pattern: '^FD-[0-9]{6}$' },
      name: { bsonType: 'string', minLength: 1, maxLength: 120 },
      institution: { bsonType: 'string', minLength: 1, maxLength: 120 },
      compounding: { enum: ['SIMPLE', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY'] },
      status: { enum: ['OPEN', 'CLOSED'] },
    },
  },
  indexes: [
    { key: { orgId: 1, number: 1 }, name: 'org_number', unique: true },
    { key: { orgId: 1, status: 1, maturityDate: 1 }, name: 'org_status_maturity' },
  ],
});

/** One posting on a deposit: placed, interest accrued, or closed. Reversing marks it reversed. */
export interface DepositEventDoc {
  id: string;
  orgId: string;
  depositId: string;
  kind: 'PLACED' | 'ACCRUED' | 'CLOSED';
  date: Date;
  amount: string;
  /** CLOSED: what the bank paid in, the tax it deducted, the interest in all and income booked now. */
  received: string | null;
  tds: string | null;
  interest: string | null;
  incomeNow: string | null;
  early: boolean;
  entryId: string;
  /** ACCRUED: the accrual it replaced (accrued and accruedTo before). */
  accruedBefore: string | null;
  accruedToBefore: Date | null;
  reversedAt: Date | null;
  reversalEntryId: string | null;
  note: string | null;
  createdById: string;
  createdAt: Date;
}

export const depositEvents = defineCollection<DepositEventDoc>({
  name: 'deposit_events',
  scope: 'tenant',
  decimals: ['amount', 'received', 'tds', 'interest', 'incomeNow', 'accruedBefore'],
  schema: {
    bsonType: 'object',
    required: ['orgId', 'depositId', 'kind', 'date', 'amount', 'early', 'entryId', 'createdById', 'createdAt'],
    properties: { kind: { enum: ['PLACED', 'ACCRUED', 'CLOSED'] }, early: { bsonType: 'bool' } },
  },
  indexes: [{ key: { orgId: 1, depositId: 1, date: 1 }, name: 'org_deposit_date' }],
});
