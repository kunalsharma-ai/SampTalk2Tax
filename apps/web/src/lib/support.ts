/** Support tickets and support access, as the API returns them. */
export type SupportStatus = 'OPEN' | 'PENDING' | 'RESOLVED' | 'CLOSED';
export type SupportPriority = 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
export type SupportCategory = 'BILLING' | 'TECHNICAL' | 'ACCOUNTING' | 'TAX' | 'ACCOUNT' | 'OTHER';
export type TargetState = 'MET' | 'MISSED' | 'RUNNING' | 'DUE_SOON' | 'OVERDUE';
export interface Target { dueAt: string; state: TargetState; doneAt: string | null }

export interface TicketSummary {
  id: string;
  reference: string;
  subject: string;
  category: SupportCategory;
  priority: SupportPriority;
  status: SupportStatus;
  openedBy: { id: string; name: string; email: string };
  assignee: { id: string; name: string } | null;
  createdAt: string;
  lastMessageAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  targets: { firstResponse: Target; resolution: Target };
}
export interface Grant { id: string; ticketId: string | null; reason: string; createdAt: string; expiresAt: string; revokedAt: string | null; state: 'ACTIVE' | 'EXPIRED' | 'REVOKED' }
export interface OrgTicket extends TicketSummary {
  messages: { id: string; side: 'CUSTOMER' | 'SUPPORT'; author: { name: string; email?: string }; body: string; createdAt: string }[];
  accessGrants: Grant[];
}
export interface SupportAccess {
  active: Grant | null;
  grants: (Grant & { grantedBy: string | null; revokedBy: string | null; ticket: { id: string; reference: string | null } | null })[];
  views: { id: string; grantId: string; by: string | null; path: string; at: string }[];
}
export interface QueueTicket extends TicketSummary {
  org: { id: string; name: string; countryCode: string };
  supportAccessUntil: string | null;
  next: Target;
}
export interface SupportTicket extends TicketSummary {
  org: { id: string; name: string; countryCode: string; suspended: boolean; plan: { name: string; status: string } | null } | null;
  supportAccess: Grant | null;
  messages: { id: string; side: 'CUSTOMER' | 'SUPPORT'; internal: boolean; author: { name: string; email: string }; body: string; createdAt: string }[];
  staff: { id: string; name: string; email: string }[];
}

export const CATEGORY: Record<SupportCategory, string> = { BILLING: 'Billing and plans', TECHNICAL: 'Something is not working', ACCOUNTING: 'Accounting', TAX: 'Tax and compliance', ACCOUNT: 'Sign-in and team', OTHER: 'Something else' };
export const PRIORITY: Record<SupportPriority, { label: string; hint: string; tone: 'negative' | 'warning' | 'neutral' | 'accent' }> = {
  URGENT: { label: 'Urgent', hint: 'work has stopped; first answer within 1 hour', tone: 'negative' },
  HIGH: { label: 'High', hint: 'a deadline is close; first answer within 4 hours', tone: 'warning' },
  NORMAL: { label: 'Normal', hint: 'first answer within 24 hours', tone: 'neutral' },
  LOW: { label: 'Low', hint: 'a question; first answer within 3 days', tone: 'accent' },
};
/** The customer's view of whose turn it is. */
export const CUSTOMER_STATUS: Record<SupportStatus, { label: string; tone: 'positive' | 'neutral' | 'warning' | 'accent' }> = {
  OPEN: { label: 'Waiting on support', tone: 'accent' },
  PENDING: { label: 'Waiting on you', tone: 'warning' },
  RESOLVED: { label: 'Resolved', tone: 'positive' },
  CLOSED: { label: 'Closed', tone: 'neutral' },
};
export const SUPPORT_STATUS: Record<SupportStatus, { label: string; tone: 'positive' | 'neutral' | 'warning' | 'accent' }> = {
  OPEN: { label: 'Open', tone: 'warning' },
  PENDING: { label: 'Waiting on customer', tone: 'accent' },
  RESOLVED: { label: 'Resolved', tone: 'positive' },
  CLOSED: { label: 'Closed', tone: 'neutral' },
};
export const TARGET: Record<TargetState, { label: string; tone: 'positive' | 'negative' | 'warning' | 'neutral' }> = {
  MET: { label: 'Met', tone: 'positive' },
  MISSED: { label: 'Missed', tone: 'negative' },
  RUNNING: { label: 'On track', tone: 'neutral' },
  DUE_SOON: { label: 'Due soon', tone: 'warning' },
  OVERDUE: { label: 'Overdue', tone: 'negative' },
};
