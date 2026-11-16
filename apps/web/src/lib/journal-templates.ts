import type { RecurringFrequency } from '@talk2tax/accounting-engine';

export interface TemplateLine {
  lineNo: number;
  accountId: string;
  account: { code: string; name: string };
  debit: string | null;
  credit: string | null;
  currency: string;
  description: string | null;
  departmentId: string | null;
  projectId: string | null;
}

export interface TemplateSchedule {
  frequency: RecurringFrequency;
  startDate: string;
  endDate: string | null;
  monthEnd: boolean;
  postMode: 'DRAFT' | 'POST';
  status: 'ACTIVE' | 'PAUSED' | 'ENDED';
  nextRunNo: number;
  runsTotal: number | null;
  description: string;
  nextRun: { no: number; date: string } | null;
  dueNow: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface JournalTemplate {
  id: string;
  number: number;
  reference: string;
  name: string;
  description: string | null;
  journalType: 'STANDARD' | 'ADJUSTING';
  memo: string | null;
  journalReference: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  totals: { currency: string; amount: string }[];
  lines: TemplateLine[];
  schedule: TemplateSchedule | null;
  updatedAt: string;
}

export interface TemplateRun {
  id: string;
  runNo: number | null;
  date: string;
  scheduled: boolean;
  posted: boolean;
  by: string;
  createdAt: string;
  entry: { id: string; status: 'DRAFT' | 'POSTED'; entryNumber: number | null; total: string; memo: string | null; reversed: boolean } | null;
  entryNumber: number | null;
}

export interface TemplateDetail extends JournalTemplate {
  upcoming: { no: number; date: string; memo: string | null }[];
  runs: TemplateRun[];
}

export interface TemplateList {
  items: (JournalTemplate & { runs: number })[];
  counts: { active: number; scheduled: number; archived: number; all: number };
  can: { manage: boolean; post: boolean };
}
