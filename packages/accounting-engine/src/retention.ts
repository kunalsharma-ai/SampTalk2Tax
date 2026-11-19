/**
 * Data retention policies (SEC-020).
 *
 * Two kinds of data are distinguished:
 *
 * * **Records the law requires to be kept** (books, vouchers, tax and payroll records, the audit
 *   trail). Talk2Tax never deletes them on a schedule; the minimum periods are shown so an
 *   organisation knows how long it must keep them, including after it stops using the app.
 * * **Working data** that is not a record of the business (AI conversations, webhook delivery
 *   logs). An organisation may choose to delete it after a number of days; until it does, it is
 *   kept.
 */

export type RetentionCategory = 'COPILOT_CONVERSATIONS' | 'CRM_WEBHOOK_DELIVERIES';

export interface RetentionCategoryDef {
  key: RetentionCategory;
  title: string;
  what: string;
  /** Fewest days a period may be: below this, data still in use would go. */
  minDays: number;
  maxDays: number;
}

export const RETENTION_CATEGORIES: readonly RetentionCategoryDef[] = [
  {
    key: 'COPILOT_CONVERSATIONS',
    title: 'Copilot conversations',
    what: 'Questions asked of the finance copilot and its answers, deleted once a conversation has had no new question for the period. Token usage for budgets and invoices is kept separately.',
    minDays: 90,
    maxDays: 3650,
  },
  {
    key: 'CRM_WEBHOOK_DELIVERIES',
    title: 'CRM webhook delivery log',
    what: 'The record of each delivery to a connected CRM (request, response and attempts), deleted once the delivery finished more than the period ago. Deliveries still being retried are kept.',
    minDays: 30,
    maxDays: 3650,
  },
];

/** Records kept for at least these periods by law, which Talk2Tax never deletes on a schedule. */
export interface StatutoryRecord {
  title: string;
  minimum: string;
  basis: string;
}

export const STATUTORY_RECORDS: Record<string, readonly StatutoryRecord[]> = {
  IN: [
    { title: 'Books of account and vouchers', minimum: 'At least 8 financial years', basis: 'Companies Act, 2013, section 128(5)' },
    { title: 'GST records (invoices, returns, input credit)', minimum: 'At least 72 months from the due date of the annual return for the year', basis: 'CGST Act, 2017, section 36' },
    { title: 'Income-tax books and documents', minimum: 'At least 6 years from the end of the relevant assessment year', basis: 'Income-tax Rules, 1962, rule 6F(5)' },
  ],
};

/** The statutory records shown for an organisation's country; other countries get a general note. */
export function statutoryRecords(countryCode: string): readonly StatutoryRecord[] {
  return STATUTORY_RECORDS[countryCode] ?? [{ title: 'Books of account, tax and payroll records', minimum: 'As your country requires', basis: 'Check the record-keeping rules that apply to you' }];
}

export function retentionCategory(key: string): RetentionCategoryDef | undefined {
  return RETENTION_CATEGORIES.find((c) => c.key === key);
}

/** Problems with a retention period: null keeps the data. */
export function retentionProblems(key: string, days: number | null): string[] {
  const c = retentionCategory(key);
  if (!c) return [`Not a kind of data with a retention period: ${key}`];
  if (days === null) return [];
  if (!Number.isInteger(days)) return ['Use a whole number of days'];
  if (days < c.minDays) return [`${c.title}: the shortest period is ${c.minDays} days`];
  if (days > c.maxDays) return [`${c.title}: the longest period is ${c.maxDays} days; choose Keep to keep it for good`];
  return [];
}

/** The moment before which data of a period of this many days is deleted. */
export function retentionCutoff(days: number, now: Date): Date {
  return new Date(now.getTime() - days * 86_400_000);
}
