/**
 * Audit reports (RPT-021): what happened in the books in a period, from the hash-chained audit
 * trail and the posted journals.
 *
 * - Activity: events by kind of record and by person (system events have no person).
 * - Sensitive actions, by the action's name (first match wins): reopened periods, access changes,
 *   bank details changed, deletions, voids/reversals/cancellations, settings changed and exports.
 * - Journal checks on entries posted in the period:
 *   BACKDATED (high): posted more than JOURNAL_BACKDATE_DAYS after the entry's date;
 *   ROUND_MANUAL (medium): a manual journal of ROUND_MANUAL_MIN or more in whole ROUND_MANUAL_STEP;
 *   SELF_POSTED (low): a manual journal posted by the person who prepared it.
 * Reversing entries are not manual journals here: the reversal is already a sensitive action.
 */
import { D, type Dec, dec, minorUnits, roundToCurrency } from './money';

export const JOURNAL_BACKDATE_DAYS = 30;
export const ROUND_MANUAL_MIN = '100000';
export const ROUND_MANUAL_STEP = '10000';

export const AUDIT_CATEGORIES = ['PERIOD_REOPENED', 'ACCESS', 'BANK_DETAILS', 'DELETION', 'VOID_REVERSAL', 'SETTINGS', 'EXPORT'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];
export const AUDIT_CATEGORY_LABEL: Record<AuditCategory, string> = {
  PERIOD_REOPENED: 'Periods reopened',
  ACCESS: 'Access changes',
  BANK_DETAILS: 'Bank details changed',
  DELETION: 'Deletions',
  VOID_REVERSAL: 'Voids, reversals and cancellations',
  SETTINGS: 'Settings changed',
  EXPORT: 'Data exported',
};
const RULES: [AuditCategory, RegExp][] = [
  ['PERIOD_REOPENED', /^(period\.unlocked|close\.reopened|year_end\.reopened|bank\.reconciliation_undone)$/],
  ['ACCESS', /^(member\.|invitation\.(created|revoked|accepted)|sso\.(connection|domain)|support\.access_|access_rule\.|security\.settings|platform\.role_changed|user\.mfa)/],
  ['BANK_DETAILS', /bank_details\.changed$|\.bank_account_changed$/],
  ['DELETION', /(deleted|removed)$/],
  ['VOID_REVERSAL', /(void|voided|reversed|cancelled)$/],
  ['SETTINGS', /(settings_saved|settings_changed)$/],
  ['EXPORT', /exported$/],
];

/** The sensitive category of an audit action, or null for routine work. */
export function auditCategory(action: string): AuditCategory | null {
  return RULES.find(([, re]) => re.test(action))?.[0] ?? null;
}

export interface AuditReportEvent {
  id: string;
  at: string;
  action: string;
  entityType: string;
  entityId: string;
  actor: { id: string; name: string } | null;
}

export interface AuditReportJournal {
  id: string;
  number: string;
  date: string;
  postedAt: string;
  /** The business date of postedAt, in the organisation's time zone. */
  postedOn?: string;
  source: string;
  memo: string | null;
  total: string;
  createdById: string;
  postedById: string | null;
  /** A reversal of another entry: listed under sensitive actions, not checked as a manual journal. */
  reverses?: boolean;
}

export const JOURNAL_CHECKS = ['BACKDATED', 'ROUND_MANUAL', 'SELF_POSTED'] as const;
export type JournalCheck = (typeof JOURNAL_CHECKS)[number];
export const JOURNAL_CHECK_SEVERITY: Record<JournalCheck, 'HIGH' | 'MEDIUM' | 'LOW'> = { BACKDATED: 'HIGH', ROUND_MANUAL: 'MEDIUM', SELF_POSTED: 'LOW' };
export const JOURNAL_CHECK_LABEL: Record<JournalCheck, string> = { BACKDATED: 'Posted long after its date', ROUND_MANUAL: 'Large round manual journal', SELF_POSTED: 'Prepared and posted by one person' };

const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000); // not money

export function buildAuditReport(events: readonly AuditReportEvent[], journals: readonly AuditReportJournal[], currency: string) {
  const show = (v: Dec) => roundToCurrency(v, currency).toFixed(minorUnits(currency));
  const byEntity = new Map<string, number>();
  const byPerson = new Map<string, { id: string | null; name: string; events: number; sensitive: number }>();
  const counts = Object.fromEntries(AUDIT_CATEGORIES.map((c) => [c, 0])) as Record<AuditCategory, number>;
  const sensitive: (AuditReportEvent & { category: AuditCategory; label: string })[] = [];
  for (const e of events) {
    byEntity.set(e.entityType, (byEntity.get(e.entityType) ?? 0) + 1);
    const key = e.actor?.id ?? 'system';
    const p = byPerson.get(key) ?? { id: e.actor?.id ?? null, name: e.actor?.name ?? 'System', events: 0, sensitive: 0 };
    p.events += 1;
    const cat = auditCategory(e.action);
    if (cat) {
      p.sensitive += 1;
      counts[cat] += 1;
      sensitive.push({ ...e, category: cat, label: AUDIT_CATEGORY_LABEL[cat] });
    }
    byPerson.set(key, p);
  }

  const exceptions: { code: JournalCheck; severity: 'HIGH' | 'MEDIUM' | 'LOW'; label: string; journalId: string; number: string; date: string; postedAt: string; amount: string; detail: string }[] = [];
  let manualTotal = new D(0);
  let manual = 0;
  for (const j of journals) {
    const flag = (code: JournalCheck, detail: string) => exceptions.push({ code, severity: JOURNAL_CHECK_SEVERITY[code], label: JOURNAL_CHECK_LABEL[code], journalId: j.id, number: j.number, date: j.date, postedAt: j.postedAt, amount: show(dec(j.total)), detail });
    const postedOn = j.postedOn ?? j.postedAt.slice(0, 10);
    const late = days(j.date, postedOn);
    if (late > JOURNAL_BACKDATE_DAYS) flag('BACKDATED', `Dated ${j.date}, posted ${late} days later on ${postedOn}`);
    if (j.source !== 'MANUAL' || j.reverses) continue;
    manual += 1;
    manualTotal = manualTotal.plus(dec(j.total));
    const total = dec(j.total);
    if (total.gte(ROUND_MANUAL_MIN) && total.mod(ROUND_MANUAL_STEP).isZero()) flag('ROUND_MANUAL', `A manual journal of exactly ${show(total)}${j.memo ? `: ${j.memo}` : ''}`);
    if (j.postedById && j.postedById === j.createdById) flag('SELF_POSTED', 'Prepared and posted by the same person, with no second check');
  }
  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  exceptions.sort((a, b) => order[a.severity] - order[b.severity] || b.postedAt.localeCompare(a.postedAt) || a.number.localeCompare(b.number));

  return {
    activity: {
      events: events.length,
      people: [...byPerson.values()].filter((p) => p.id).length,
      byEntity: [...byEntity.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([entityType, n]) => ({ entityType, events: n })),
      byPerson: [...byPerson.values()].sort((a, b) => b.events - a.events || a.name.localeCompare(b.name)),
    },
    sensitive: {
      total: sensitive.length,
      counts: AUDIT_CATEGORIES.map((c) => ({ category: c, label: AUDIT_CATEGORY_LABEL[c], events: counts[c] })),
      events: sensitive.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)),
    },
    journals: { posted: journals.length, manual, manualTotal: show(manualTotal), exceptions },
  };
}

export type AuditReport = ReturnType<typeof buildAuditReport>;

/** The report as CSV, with formula-like text guarded. */
export function auditReportCsv(r: AuditReport, meta: { from: string; to: string; chainValid: boolean; checked: number }): string {
  const risky = (v: string) => /^[=+@]/.test(v) || /^-(?!\d)/.test(v);
  const q = (v: string) => {
    const t = risky(v) ? `'${v}` : v;
    return risky(v) || /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const out: string[] = [];
  const row = (...cells: (string | number)[]) => out.push(cells.map((c) => q(String(c))).join(','));
  row('Audit report', `${meta.from} to ${meta.to}`, meta.chainValid ? `Audit trail intact (${meta.checked} events checked)` : 'Audit trail chain broken');
  row('');
  row('Person', 'Events', 'Sensitive');
  for (const p of r.activity.byPerson) row(p.name, p.events, p.sensitive);
  row('');
  row('Sensitive action', 'Category', 'At', 'Record', 'Record id', 'By');
  for (const e of r.sensitive.events) row(e.action, e.label, e.at, e.entityType, e.entityId, e.actor?.name ?? 'System');
  row('');
  row('Journal check', 'Severity', 'Journal', 'Date', 'Posted at', 'Amount', 'Detail');
  for (const x of r.journals.exceptions) row(x.label, x.severity, x.number, x.date, x.postedAt, x.amount, x.detail);
  return `${out.join('\n')}\n`;
}
