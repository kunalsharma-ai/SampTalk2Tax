export type TripStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export const TRIP_STATUS_LABEL: Record<TripStatus, string> = { REQUESTED: 'Waiting for approval', APPROVED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Cancelled' };
export const TRIP_STATUS_TONE = { REQUESTED: 'warning', APPROVED: 'positive', REJECTED: 'negative', CANCELLED: 'neutral' } as const;

export interface TripRow {
  id: string;
  reference: string;
  traveller: string;
  travellerId: string;
  purpose: string;
  destination: string;
  startDate: string;
  endDate: string;
  status: TripStatus;
  estimate: string;
  claims: number;
}

export interface ClaimRef { id: string; number: string; title: string; status: string; total: string }

export interface Trip {
  id: string;
  reference: string;
  traveller: string;
  travellerId: string;
  purpose: string;
  destination: string;
  startDate: string;
  endDate: string;
  currency: string;
  status: TripStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  claims: (ClaimRef & { canUnlink: boolean })[];
  costs: {
    days: number;
    estimate: { total: string; lines: { key: string; label: string; amount: string }[] };
    spent: string;
    pending: string;
    remaining: string;
    perDay: string;
    byCategory: { account: string; spent: string; pending: string }[];
    outsideDates: { claimId: string; number: string; lineNo: number; date: string; amount: string }[];
    flags: { code: string; message: string }[];
  };
  canDecide: boolean;
  canCancel: boolean;
  linkable: ClaimRef[];
}
