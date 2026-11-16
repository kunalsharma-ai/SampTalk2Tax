export type ReminderStatus = 'DRAFTING' | 'READY' | 'SENT' | 'SEND_FAILED' | 'REJECTED' | 'FAILED';
export type Risk = 'LOW' | 'MEDIUM' | 'HIGH';

export interface DraftCheck {
  ok: boolean;
  label: string;
}
export interface OverdueInvoice {
  number: string;
  issueDate: string;
  dueDate: string;
  total: string;
  balance: string;
  reference: string | null;
  daysOverdue: number;
  documentId: string | null;
}
export interface ReminderFacts {
  customer: string;
  currency: string;
  today: string;
  overdue: OverdueInvoice[];
  notYetDue: { number: string; dueDate: string; balance: string }[];
  totalOverdue: string;
  oldestDaysOverdue: number;
  averageDaysLate: number | null;
  paidInvoicesConsidered: number;
  lastPayment: { date: string; amount: string } | null;
  previousReminders: { sentOn: string; subject: string }[];
}
export interface Reminder {
  id: string;
  runId: string;
  contactId: string;
  customer: string;
  toEmail: string;
  status: ReminderStatus;
  facts: ReminderFacts;
  risk: Risk | null;
  riskReasons: string[];
  aiSubject: string | null;
  aiBody: string | null;
  subject: string | null;
  body: string | null;
  edited: boolean;
  checks: DraftCheck[];
  canSend: boolean;
  model: string;
  servedModel: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  errorCode: string | null;
  errorMessage: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  sendAttempts: number;
  sendLog: { at: string; ok: boolean; status: number | null; error: string | null; responseSnippet: string | null }[];
  sentAt: string | null;
  createdAt: string;
}
export interface CollectionsOverview {
  aiConfigured: boolean;
  aiEnabled: boolean;
  emailReady: boolean;
  emailFrom: string | null;
  model: string;
  canChangeAi: boolean;
  limits: { customersPerRun: number; remindAgainAfterDays: number };
  counts: Partial<Record<ReminderStatus, number>>;
  latestRun: {
    id: string;
    status: 'RUNNING' | 'DONE';
    startedBy: string;
    skipped: { contactId: string; name: string; reason: string }[];
    createdAt: string;
    finishedAt: string | null;
    drafts: number;
  } | null;
}
export interface AiActivity {
  rows: {
    id: string;
    feature: 'COPILOT' | 'COLLECTIONS' | 'BANKING' | 'CLOSE';
    at: string;
    by: string;
    what: string;
    model: string;
    servedModel: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    outcome: string;
    error: string | null;
    decision: string | null;
    link: string | null;
  }[];
  totals: { calls: number; inputTokens: number; outputTokens: number };
}

type Tone = 'neutral' | 'accent' | 'positive' | 'warning' | 'negative' | 'violet';
export const STATUS: Record<ReminderStatus, { label: string; tone: Tone }> = {
  DRAFTING: { label: 'Drafting', tone: 'accent' },
  READY: { label: 'To review', tone: 'warning' },
  SENT: { label: 'Sent', tone: 'positive' },
  SEND_FAILED: { label: 'Not delivered', tone: 'negative' },
  REJECTED: { label: 'Rejected', tone: 'neutral' },
  FAILED: { label: 'Draft failed', tone: 'negative' },
};
export const RISK: Record<Risk, { label: string; tone: Tone }> = {
  LOW: { label: 'Low risk', tone: 'positive' },
  MEDIUM: { label: 'Medium risk', tone: 'warning' },
  HIGH: { label: 'High risk', tone: 'negative' },
};

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

export type BankAiStatus = 'DRAFTING' | 'READY' | 'ACCEPTED' | 'DISMISSED' | 'FAILED';
export type BankAiResolved =
  | { action: 'MATCH'; journalLineIds: string[]; ledger: { ref: string; date: string; amount: string; text: string }[] }
  | { action: 'PAYMENT'; contactId: string; contactName: string; allocations: { documentId: string; number: string; amount: string }[]; unallocated: string }
  | { action: 'ENTRY'; accountId: string; accountCode: string; accountName: string; description: string }
  | { action: 'NONE' };
export interface BankAiSuggestion {
  id: string;
  runId: string;
  status: BankAiStatus;
  line: { id: string; accountId: string; date: string; description: string; reference: string | null; amount: string; status: string };
  lineOpen: boolean;
  action: 'MATCH' | 'PAYMENT' | 'ENTRY' | 'NONE' | null;
  proposal: { accountCode?: string; entryDescription?: string; contactRef?: string; ledgerRefs?: string[]; allocations?: { documentRef: string; amount: string }[] } | null;
  resolved: BankAiResolved | null;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  reason: string | null;
  checks: DraftCheck[];
  canAccept: boolean;
  shown: { ledger: number; documents: number; accounts: number; history: number };
  model: string;
  servedModel: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  errorCode: string | null;
  errorMessage: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  result: { paymentNumber?: string | null; entryNumber?: string | null; journalEntryIds?: string[] } | null;
  createdAt: string;
}
export interface BankAiOverview {
  account: { id: string; code: string; name: string };
  aiConfigured: boolean;
  aiEnabled: boolean;
  model: string;
  canChangeAi: boolean;
  limits: { linesPerRun: number };
  counts: Partial<Record<BankAiStatus, number>>;
  latestRun: { id: string; status: 'RUNNING' | 'DONE'; startedBy: string; skipped: { lineId: string; date: string; amount: string; description: string; reason: string }[]; createdAt: string; finishedAt: string | null; suggestions: number } | null;
}
export const BANK_AI_STATUS: Record<BankAiStatus, { label: string; tone: Tone }> = {
  DRAFTING: { label: 'Thinking', tone: 'accent' },
  READY: { label: 'To review', tone: 'warning' },
  ACCEPTED: { label: 'Accepted', tone: 'positive' },
  DISMISSED: { label: 'Dismissed', tone: 'neutral' },
  FAILED: { label: 'No suggestion', tone: 'negative' },
};
export const CONFIDENCE: Record<'LOW' | 'MEDIUM' | 'HIGH', { label: string; tone: Tone }> = {
  HIGH: { label: 'High confidence', tone: 'positive' },
  MEDIUM: { label: 'Medium confidence', tone: 'warning' },
  LOW: { label: 'Low confidence', tone: 'neutral' },
};
