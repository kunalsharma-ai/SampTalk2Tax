/**
 * Duplicate files across records (DOC-018). The same file (same SHA-256) on two records is often
 * fine, such as a remittance advice on an invoice and on its receipt. It is a warning sign when it
 * supports spending twice: one receipt on two expense claims, one vendor invoice on two bills, or
 * a receipt claimed by an employee that a vendor also billed.
 */

export type DuplicateRisk = 'HIGH' | 'MEDIUM' | 'LOW';

/** What a record is, for this check: spending claimed or billed, or anything else. */
export type FileUse = 'EXPENSE_CLAIM' | 'BILL' | 'OTHER';

export interface DuplicateVerdict {
  risk: DuplicateRisk;
  reason: string;
}

export function duplicateFileRisk(uses: readonly FileUse[]): DuplicateVerdict {
  const claims = uses.filter((u) => u === 'EXPENSE_CLAIM').length;
  const bills = uses.filter((u) => u === 'BILL').length;
  if (claims >= 2) return { risk: 'HIGH', reason: 'The same receipt supports more than one expense claim: it may be claimed twice' };
  if (bills >= 2) return { risk: 'HIGH', reason: 'The same file supports more than one bill: the vendor may be paid twice' };
  if (claims && bills) return { risk: 'MEDIUM', reason: 'An employee claimed this receipt and it is also on a bill: the cost may be counted twice' };
  return { risk: 'LOW', reason: 'The same file is on several records; usually supporting evidence shared between them' };
}

const ORDER: Record<DuplicateRisk, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/** Most serious first, then the most recent upload first. */
export function compareDuplicates(a: { risk: DuplicateRisk; latest: string }, b: { risk: DuplicateRisk; latest: string }): number {
  return ORDER[a.risk] - ORDER[b.risk] || b.latest.localeCompare(a.latest);
}
