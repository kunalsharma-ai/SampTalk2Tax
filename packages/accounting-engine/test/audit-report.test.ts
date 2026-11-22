import { describe, expect, it } from 'vitest';
import { auditCategory, auditReportCsv, buildAuditReport, type AuditReportEvent, type AuditReportJournal } from '../src/audit-report';

const asha = { id: 'u1', name: 'Asha Accountant' };
const ravi = { id: 'u2', name: 'Ravi Owner' };
const ev = (id: string, action: string, actor: AuditReportEvent['actor'], entityType = action.split('.')[0]!): AuditReportEvent => ({ id, at: `2026-11-${id.padStart(2, '0')}T10:00:00.000Z`, action, entityType, entityId: `e${id}`, actor });
const je = (id: string, x: Partial<AuditReportJournal>): AuditReportJournal => ({ id, number: `JE-00000${id}`, date: '2026-11-10', postedAt: '2026-11-10T09:00:00.000Z', source: 'MANUAL', memo: null, total: '5000', createdById: 'u1', postedById: 'u2', ...x });

describe('audit reports (RPT-021)', () => {
  it('sorts actions into sensitive categories', () => {
    expect(['period.unlocked', 'member.role_changed', 'vendor_bank_details.changed', 'budget.deleted', 'document.voided', 'journal.reversed', 'payment_batch.cancelled', 'compliance.settings_saved', 'tax_report.exported', 'journal.posted', 'invitation.renewed'].map(auditCategory)).toEqual([
      'PERIOD_REOPENED', 'ACCESS', 'BANK_DETAILS', 'DELETION', 'VOID_REVERSAL', 'VOID_REVERSAL', 'VOID_REVERSAL', 'SETTINGS', 'EXPORT', null, null,
    ]);
  });

  const r = buildAuditReport(
    [ev('1', 'journal.posted', asha), ev('2', 'journal.posted', asha), ev('3', 'document.voided', ravi, 'document'), ev('4', 'period.unlocked', ravi, 'fiscal_period'), ev('5', 'member.role_changed', ravi, 'membership'), ev('6', 'bank.statement_imported', null, 'bank')],
    [
      je('1', { date: '2026-09-01', postedAt: '2026-11-05T09:00:00.000Z', source: 'INVOICE', createdById: 'u1', postedById: 'u1' }),
      je('2', { total: '250000', memo: 'Year-end provision' }),
      je('3', { postedById: 'u1' }),
      je('4', { total: '120000.50' }),
      je('5', { total: '250000', postedById: 'u1', reverses: true }),
    ],
    'INR',
  );

  it('counts activity by record and person, and lists sensitive actions newest first', () => {
    expect(r.activity).toMatchObject({ events: 6, people: 2 });
    expect(r.activity.byEntity[0]).toEqual({ entityType: 'journal', events: 2 });
    expect(r.activity.byPerson).toEqual([
      { id: 'u2', name: 'Ravi Owner', events: 3, sensitive: 3 },
      { id: 'u1', name: 'Asha Accountant', events: 2, sensitive: 0 },
      { id: null, name: 'System', events: 1, sensitive: 0 },
    ]);
    expect(r.sensitive.total).toBe(3);
    expect(r.sensitive.events.map((e) => [e.action, e.category])).toEqual([['member.role_changed', 'ACCESS'], ['period.unlocked', 'PERIOD_REOPENED'], ['document.voided', 'VOID_REVERSAL']]);
    expect(r.sensitive.counts.find((c) => c.category === 'DELETION')!.events).toBe(0);
  });

  it('checks journals: back-dated, large round manual and self-posted', () => {
    expect(r.journals).toMatchObject({ posted: 5, manual: 3, manualTotal: '375000.50' });
    expect(r.journals.exceptions.map((x) => [x.code, x.number])).toEqual([['BACKDATED', 'JE-000001'], ['ROUND_MANUAL', 'JE-000002'], ['SELF_POSTED', 'JE-000003']]);
    expect(r.journals.exceptions[0]!.detail).toBe('Dated 2026-09-01, posted 65 days later on 2026-11-05');
    expect(r.journals.exceptions[1]!.detail).toBe('A manual journal of exactly 250000.00: Year-end provision');
  });

  it('writes a CSV with the chain result and formulas guarded', () => {
    const csv = auditReportCsv(buildAuditReport([ev('1', 'budget.deleted', { id: 'u9', name: '=CMD()' })], [], 'INR'), { from: '2026-11-01', to: '2026-11-30', chainValid: true, checked: 12 }).trim().split('\n');
    expect(csv[0]).toBe('Audit report,2026-11-01 to 2026-11-30,Audit trail intact (12 events checked)');
    expect(csv).toContain(`"'=CMD()",1,1`);
    expect(csv).toContain(`budget.deleted,Deletions,2026-11-01T10:00:00.000Z,budget,e1,"'=CMD()"`);
  });
});
