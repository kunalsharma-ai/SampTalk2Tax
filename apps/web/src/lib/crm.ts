import type { DealStage, LeadSource, LeadStatus } from '@talk2tax/accounting-engine';

export type { DealStage, LeadSource, LeadStatus };
export type Person = { id: string; name: string } | null;
export interface Can { manage: boolean; manageContacts: boolean }

export interface Activity {
  id: string;
  kind: 'CREATED' | 'NOTE' | 'CALL' | 'EMAIL' | 'MEETING' | 'STATUS_CHANGED' | 'STAGE_CHANGED' | 'CONVERTED' | 'UPDATED';
  body: string | null;
  data: Record<string, unknown> | null;
  actor: Person;
  createdAt: string;
}

export interface Lead {
  id: string;
  reference: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  source: LeadSource;
  status: LeadStatus;
  owner: Person;
  estimatedValue: string | null;
  notes: string | null;
  disqualifiedReason: string | null;
  convertedContactId: string | null;
  convertedDealId: string | null;
  convertedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeadList { leads: Lead[]; counts: Record<LeadStatus, number>; openEstimatedValue: string; can: Can }

export interface LeadDetail extends Lead {
  convertedContact: { id: string; name: string } | null;
  convertedDeal: { id: string; reference: string; name: string; stage: DealStage } | null;
  duplicates: { leads: { id: string; reference: string; name: string; status: LeadStatus }[]; contacts: { id: string; name: string; isCustomer: boolean }[] };
  activities: Activity[];
  can: Can;
}

export interface Deal {
  id: string;
  reference: string;
  name: string;
  contact: { id: string; name: string } | null;
  leadId: string | null;
  amount: string;
  stage: DealStage;
  probability: number;
  weighted: string;
  expectedCloseDate: string;
  overdue: boolean;
  owner: Person;
  closedOn: string | null;
  lostReason: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

type Sums = { count: number; amount: string; weighted: string };
export interface DealList {
  today: string;
  deals: Deal[];
  summary: {
    open: Sums;
    stages: (Sums & { stage: DealStage })[];
    overdue: { count: number; amount: string };
    window: { days: number; won: number; lost: number; wonAmount: string; winRate: number | null; averageDaysToWin: number | null };
  };
  byCloseMonth: { months: (Sums & { month: string })[]; later: Sums };
  can: Can;
}

export interface DealDetail extends Deal {
  lead: { id: string; reference: string; name: string; source: LeadSource } | null;
  activities: Activity[];
  can: Can;
}

export interface Owner { id: string; name: string; email: string; role: string }
