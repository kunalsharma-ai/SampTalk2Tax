/** Types and labels for the relationship explorer (the connections between records in the books). */
export type GraphNodeType = 'CONTACT' | 'DOCUMENT' | 'PAYMENT' | 'JOURNAL' | 'ACCOUNT' | 'PROJECT' | 'DEPARTMENT' | 'LOAN' | 'ASSET' | 'ALERT';
export interface GraphNode { type: GraphNodeType; id: string; label: string; subtitle: string | null; path: string | null }
export interface GraphEdge { relation: string; explanation: string; node: GraphNode }
export interface GraphNeighbourhood { node: GraphNode; edges: GraphEdge[]; more: { relation: string; count: number }[] }
/** Where a general ledger line came from. */
export interface EntrySource { type: string; id: string; label: string; path: string | null; role: string }

export const NODE_TYPE_LABEL: Record<GraphNodeType, string> = {
  CONTACT: 'Contact',
  DOCUMENT: 'Document',
  PAYMENT: 'Payment',
  JOURNAL: 'Journal entry',
  ACCOUNT: 'Account',
  PROJECT: 'Project',
  DEPARTMENT: 'Department',
  LOAN: 'Loan',
  ASSET: 'Fixed asset',
  ALERT: 'Alert',
};

/** Headings for each kind of connection, read from the centre record's point of view. */
export const RELATION_LABEL: Record<string, string> = {
  ISSUED_TO: 'Issued to / invoices',
  RECEIVED_FROM: 'Received from / bills',
  PAID_BY: 'Payments received',
  PAID_TO: 'Payments made',
  SETTLED_BY: 'Settled by',
  SETTLES: 'Settles',
  POSTED_BY: 'Journal entry',
  VOIDED_BY: 'Voided by',
  CREATED_BY: 'Created by',
  BOOKED_TO: 'Booked to accounts',
  DEBITS: 'Debits',
  CREDITS: 'Credits',
  POSTED_IN: 'Journal entries',
  DEPOSITED_TO: 'Deposited to',
  PAID_FROM: 'Paid from',
  FOR_PROJECT: 'Projects',
  FOR_DEPARTMENT: 'Departments',
  WORKS_ON: 'Projects and customers',
  SERVED_BY: 'Departments and contacts',
  TAGGED_IN: 'Tagged journal entries',
  FLAGGED_BY: 'Alerts',
  EVIDENCE: 'Evidence',
  REVERSES: 'Reverses',
  REVERSED_BY: 'Reversed by',
  USES_ACCOUNT: 'Accounts it uses',
  USED_BY_LOAN: 'Loans using this account',
  USED_BY_ASSET: 'Assets using this account',
  DEPRECIATED_IN: 'Depreciation entries',
};
export const relationLabel = (r: string) => RELATION_LABEL[r] ?? r.charAt(0) + r.slice(1).toLowerCase().replace(/_/g, ' ');
export const graphHref = (orgId: string, n: { type: string; id: string }) => `/orgs/${orgId}/graph?type=${n.type}&id=${n.id}`;
