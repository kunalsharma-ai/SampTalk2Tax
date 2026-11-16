export type DepreciationMethod = 'STRAIGHT_LINE' | 'WRITTEN_DOWN_VALUE';
export type AccountRef = { id: string; code: string; name: string };
export type EntryRef = { id: string; entryNumber: number } | null;

export interface AssetRow {
  id: string;
  number: number;
  reference: string;
  name: string;
  category: string | null;
  location: string | null;
  status: 'ACTIVE' | 'DISPOSED';
  method: DepreciationMethod;
  assetAccount: AccountRef | null;
  acquisitionDate: string;
  inServiceDate: string;
  cost: string;
  accumulated: string;
  netBookValue: string;
  depreciatedThrough: string | null;
  disposedOn: string | null;
}

export interface Register {
  assets: AssetRow[];
  totals: { active: number; disposed: number; cost: string; accumulated: string; netBookValue: string };
  can: { manage: boolean };
}

export interface ScheduleRow { month: string; charge: string; accumulated: string; netBookValue: string; posted: boolean }

export interface AssetDetail {
  id: string;
  number: number;
  reference: string;
  name: string;
  category: string | null;
  serialNumber: string | null;
  location: string | null;
  status: 'ACTIVE' | 'DISPOSED';
  accounts: { asset: AccountRef | null; accumulated: AccountRef | null; expense: AccountRef | null };
  acquisitionDate: string;
  inServiceDate: string;
  cost: string;
  residualValue: string;
  method: DepreciationMethod;
  usefulLifeMonths: number | null;
  annualRate: string | null;
  openingAccumulated: string;
  depreciatedThrough: string | null;
  accumulated: string;
  netBookValue: string;
  fullyDepreciatedIn: string | null;
  termsFixed: boolean;
  acquisitionEntry: EntryRef;
  disposal: { date: string; proceeds: string; note: string | null; by: string; entry: EntryRef } | null;
  postings: { month: string; amount: string; runMonth: string; runStatus: 'POSTED' | 'REVERSED'; entry: EntryRef; postedBy: string }[];
  schedule: ScheduleRow[];
  createdBy: string;
  createdAt: string;
  can: { manage: boolean };
}

export interface DepreciationView {
  currentMonth: string;
  lastPosted: string | null;
  nextMonth: string | null;
  month: string | null;
  monthName: string | null;
  period: { name: string; status: string } | null;
  alreadyPosted: boolean;
  preview: { assetId: string; reference: string; name: string; month: string; amount: string; catchUp: boolean }[];
  previewTotal: string;
  runs: { id: string; month: string; monthName: string; status: 'POSTED' | 'REVERSED'; total: string; lines: number; entry: EntryRef; reversal: EntryRef; postedBy: string; postedAt: string; reversedBy: string | null; reversedAt: string | null; canReverse: boolean }[];
  can: { manage: boolean };
}

export interface AssetAccounts { asset: AccountRef[]; accumulated: AccountRef[]; expense: AccountRef[]; funding: AccountRef[]; gainLoss: AccountRef[] }

export const METHOD: Record<DepreciationMethod, string> = { STRAIGHT_LINE: 'Straight line', WRITTEN_DOWN_VALUE: 'Written-down value' };
export const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
export const shortMonth = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
export const acct = (a: AccountRef | null) => (a ? `${a.code} ${a.name}` : '—');
