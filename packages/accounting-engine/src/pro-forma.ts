/**
 * Pro forma invoices (AR-008). A pro forma invoice tells the customer what they will be billed
 * before the sale (often to pay an advance or to arrange an import licence or a letter of credit).
 * It is not a tax invoice and posts nothing. Once issued its lines and figures are fixed; it is
 * then turned into a draft tax invoice with the same lines, or cancelled.
 */

export type ProFormaStatus = 'DRAFT' | 'ISSUED' | 'CANCELLED';
export type ProFormaState = 'DRAFT' | 'ISSUED' | 'EXPIRED' | 'INVOICED' | 'CANCELLED';
export type ProFormaAction = 'EDIT' | 'ISSUE' | 'INVOICE' | 'CANCEL' | 'DELETE';

export const PRO_FORMA_STATE_LABEL: Record<ProFormaState, string> = {
  DRAFT: 'Draft',
  ISSUED: 'Issued',
  EXPIRED: 'Past valid date',
  INVOICED: 'Invoiced',
  CANCELLED: 'Cancelled',
};

export const proFormaRef = (n: number) => `PF-${String(n).padStart(4, '0')}`;

export class ProFormaError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Where a pro forma stands. `invoice` is the tax invoice made from it, if that still exists and is
 * not void (deleting or voiding it frees the pro forma to be invoiced again).
 */
export function proFormaState(status: ProFormaStatus, validUntil: string, invoice: { status: string } | null, today: string): ProFormaState {
  if (status === 'CANCELLED') return 'CANCELLED';
  if (status === 'DRAFT') return 'DRAFT';
  if (invoice && invoice.status !== 'VOID') return 'INVOICED';
  return validUntil < today ? 'EXPIRED' : 'ISSUED';
}

/** Throws ProFormaError when `action` is not allowed in `state`. */
export function proFormaAllows(state: ProFormaState, action: ProFormaAction): void {
  const ok: Record<ProFormaAction, ProFormaState[]> = {
    EDIT: ['DRAFT'],
    DELETE: ['DRAFT'],
    ISSUE: ['DRAFT'],
    // A pro forma past its valid date can still be invoiced: the customer may pay late.
    INVOICE: ['ISSUED', 'EXPIRED'],
    CANCEL: ['ISSUED', 'EXPIRED'],
  };
  if (ok[action].includes(state)) return;
  const why: Record<ProFormaState, string> = {
    DRAFT: 'This pro forma invoice is still a draft; issue it first',
    ISSUED: 'This pro forma invoice is issued; its lines can no longer change',
    EXPIRED: 'This pro forma invoice is issued; its lines can no longer change',
    INVOICED: 'This pro forma invoice is already invoiced; void or delete that invoice first',
    CANCELLED: 'This pro forma invoice is cancelled',
  };
  throw new ProFormaError('PRO_FORMA_STATE', why[state]);
}
