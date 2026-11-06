/**
 * Support tickets (M9 slice 4): response targets by priority, how a ticket moves between
 * states, and the limits on support access to an organisation's books. Pure rules; the API
 * stores tickets and enforces who may do what.
 */

export const SUPPORT_CATEGORIES = ['BILLING', 'TECHNICAL', 'ACCOUNTING', 'TAX', 'ACCOUNT', 'OTHER'] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export const SUPPORT_PRIORITIES = ['URGENT', 'HIGH', 'NORMAL', 'LOW'] as const;
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];

/** OPEN: support's turn. PENDING: waiting on the customer. RESOLVED: support thinks it is done. CLOSED: final. */
export const SUPPORT_STATUSES = ['OPEN', 'PENDING', 'RESOLVED', 'CLOSED'] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

/** Hours, counted on the clock (not business hours), from the ticket being opened. */
export const FIRST_RESPONSE_HOURS: Record<SupportPriority, number> = { URGENT: 1, HIGH: 4, NORMAL: 24, LOW: 72 };
export const RESOLUTION_HOURS: Record<SupportPriority, number> = { URGENT: 8, HIGH: 24, NORMAL: 72, LOW: 168 };

/** Support access to an organisation's books lasts at most three days per grant. */
export const SUPPORT_GRANT_MAX_HOURS = 72;

export type TargetState = 'MET' | 'MISSED' | 'RUNNING' | 'DUE_SOON' | 'OVERDUE';

export interface TargetResult {
  dueAt: Date;
  state: TargetState;
  /** When the target was met or missed; null while running. */
  doneAt: Date | null;
}

const HOUR_MS = 3_600_000;

function target(start: Date, hours: number, doneAt: Date | null, now: Date): TargetResult {
  const dueAt = new Date(start.getTime() + hours * HOUR_MS);
  if (doneAt) return { dueAt, state: doneAt <= dueAt ? 'MET' : 'MISSED', doneAt };
  if (now > dueAt) return { dueAt, state: 'OVERDUE', doneAt: null };
  // The last quarter of the window is "due soon", so the queue can be sorted by urgency.
  const soon = dueAt.getTime() - hours * HOUR_MS * 0.25;
  return { dueAt, state: now.getTime() >= soon ? 'DUE_SOON' : 'RUNNING', doneAt: null };
}

export interface TicketTimes {
  priority: SupportPriority;
  createdAt: Date;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
}

/**
 * Where a ticket stands against its targets. The first response is support's first reply
 * the customer can see (internal notes do not count). Resolution is the first time it was
 * resolved or closed; reopening does not reset the clock.
 */
export function supportTargets(t: TicketTimes, now: Date): { firstResponse: TargetResult; resolution: TargetResult } {
  const resolvedAt = t.resolvedAt && t.closedAt ? (t.resolvedAt < t.closedAt ? t.resolvedAt : t.closedAt) : (t.resolvedAt ?? t.closedAt);
  return {
    firstResponse: target(t.createdAt, FIRST_RESPONSE_HOURS[t.priority], t.firstResponseAt, now),
    resolution: target(t.createdAt, RESOLUTION_HOURS[t.priority], resolvedAt, now),
  };
}

export type TicketAction = 'CUSTOMER_REPLY' | 'SUPPORT_REPLY' | 'SUPPORT_NOTE' | 'RESOLVE' | 'CLOSE' | 'REOPEN';

export class TicketStateError extends Error {
  constructor(
    readonly code: 'TICKET_CLOSED' | 'TICKET_NOT_RESOLVED' | 'TICKET_ALREADY_RESOLVED',
    message: string,
  ) {
    super(message);
  }
}

/**
 * The state after an action. A customer reply hands the ticket back to support (and
 * reopens a resolved one); a support reply waits on the customer; a closed ticket is final,
 * so a customer with more to say opens a new one.
 */
export function ticketTransition(status: SupportStatus, action: TicketAction): SupportStatus {
  if (status === 'CLOSED') throw new TicketStateError('TICKET_CLOSED', 'This ticket is closed. Open a new ticket if there is more to do.');
  switch (action) {
    case 'CUSTOMER_REPLY':
      return 'OPEN';
    case 'SUPPORT_REPLY':
      return status === 'RESOLVED' ? 'RESOLVED' : 'PENDING';
    case 'SUPPORT_NOTE':
      return status;
    case 'RESOLVE':
      if (status === 'RESOLVED') throw new TicketStateError('TICKET_ALREADY_RESOLVED', 'This ticket is already resolved.');
      return 'RESOLVED';
    case 'CLOSE':
      return 'CLOSED';
    case 'REOPEN':
      if (status !== 'RESOLVED') throw new TicketStateError('TICKET_NOT_RESOLVED', 'Only a resolved ticket can be reopened.');
      return 'OPEN';
  }
}

/** The number people quote: T-000042. */
export function ticketReference(n: number | bigint): string {
  return `T-${String(n).padStart(6, '0')}`;
}

/** The end of a support access grant, or an error message when the length is not allowed. */
export function supportGrantEnd(hours: number, from: Date): Date {
  if (!Number.isInteger(hours) || hours < 1 || hours > SUPPORT_GRANT_MAX_HOURS) {
    throw new RangeError(`Support access lasts between 1 and ${SUPPORT_GRANT_MAX_HOURS} hours`);
  }
  return new Date(from.getTime() + hours * HOUR_MS);
}

const URGENCY: Record<TargetState, number> = { OVERDUE: 0, DUE_SOON: 1, RUNNING: 2, MISSED: 3, MET: 4 };

/** Queue order: support's turn first, then the most urgent target, then the oldest. */
export function queueOrder(a: { status: SupportStatus; createdAt: Date; next: TargetResult }, b: { status: SupportStatus; createdAt: Date; next: TargetResult }): number {
  const turn = (s: SupportStatus) => (s === 'OPEN' ? 0 : s === 'PENDING' ? 1 : s === 'RESOLVED' ? 2 : 3);
  return turn(a.status) - turn(b.status) || URGENCY[a.next.state] - URGENCY[b.next.state] || a.next.dueAt.getTime() - b.next.dueAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime();
}
