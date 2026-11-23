import { Injectable } from '@nestjs/common';
import { addDays, D, EXPENSE_RISK_HISTORY_DAYS, EXPENSE_RISK_INDICATORS, EXPENSE_RISK_RECEIPTS_FROM, EXPENSE_RISK_STATUSES, expenseRisk, formatAmountText, minorUnits } from '@talk2tax/accounting-engine';
import { businessDate, fromDbDate, todayIso } from '../common/dates';
import { PrismaService } from '../common/prisma.service';
import { runInOrg } from '../common/tenant-context';
import { DocumentStoreService } from '../common/document-store.service';
import { claimAllowances } from '../db/collections/allowances';
import { expensePolicyRules } from '../db/collections/expense-policy';
import { ReceiptFilesService } from '../expenses/receipt-files.service';

export interface ExpenseRiskQuery {
  days: number;
  receiptsFrom?: string;
}

/**
 * Unusual expenses and fraud risk indicators (EXP-023, EXP-024): expense claims submitted in the
 * last `days` with warning signs (the exact receipt file on another claim or a bill, the same receipt on two claims, receipts split around a limit,
 * unusually large amounts, lines just under a limit and people who keep landing there, old
 * receipts, missing receipts, Sundays, round amounts), compared with the year before, and the
 * people with the most of them. Read-only. The alert check of the same name uses the same findings.
 */
@Injectable()
export class ExpenseRiskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
    private readonly receiptFiles: ReceiptFilesService,
  ) {}

  async findings(org: { id: string }, q: ExpenseRiskQuery, today = todayIso()) {
    const from = addDays(today, -(q.days - 1));
    const rows = await this.prisma.expenseClaim.findMany({
      where: { orgId: org.id, status: { in: [...EXPENSE_RISK_STATUSES] }, submittedAt: { gte: new Date(Date.parse(`${addDays(from, -EXPENSE_RISK_HISTORY_DAYS - 1)}T00:00:00Z`)) } },
      include: { lines: { include: { account: { select: { code: true, name: true } } }, orderBy: { lineNo: 'asc' } } },
    });
    const ids = rows.map((r) => r.id);
    const [users, files, allowances, limits, shared] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.claimantId))] } }, select: { id: true, name: true } }),
      ids.length ? this.prisma.attachment.findMany({ where: { orgId: org.id, entityType: 'EXPENSE_CLAIM', entityId: { in: ids }, removedAt: null }, select: { entityId: true } }) : [],
      runInOrg(org.id, () => this.store.collection(claimAllowances).find({ claimId: { $in: ids } })),
      runInOrg(org.id, () => this.store.collection(expensePolicyRules).find({ isActive: true, kind: 'LINE_MAX' })),
      runInOrg(org.id, () => this.receiptFiles.forClaims(org.id, ids)),
    ]);
    const names = new Map(users.map((u) => [u.id, u.name]));
    const fileCount = new Map<string, number>();
    for (const f of files) fileCount.set(f.entityId, (fileCount.get(f.entityId) ?? 0) + 1);
    const allowance = new Set(allowances.map((a) => `${a.claimId}|${a.lineNo}`));
    const fmt = (amount: string, currency: string) => formatAmountText(new D(amount).toFixed(minorUnits(currency)), currency);

    const r = expenseRisk(
      rows.map((c) => ({
        id: c.id,
        number: c.number,
        claimantId: c.claimantId,
        claimantName: names.get(c.claimantId) ?? 'Former member',
        status: c.status,
        submittedOn: businessDate(c.submittedAt!),
        currency: c.currency,
        total: c.total.toFixed(minorUnits(c.currency)),
        receiptCount: fileCount.get(c.id) ?? 0,
        sharedFiles: shared.get(c.id),
        lines: c.lines.map((l) => ({
          lineNo: l.lineNo,
          date: fromDbDate(l.date),
          accountId: l.accountId,
          accountLabel: `${l.account.code} · ${l.account.name}`,
          merchant: l.merchant,
          amount: l.amount.toFixed(minorUnits(c.currency)),
          isAllowance: allowance.has(`${c.id}|${l.lineNo}`),
        })),
      })),
      { from, asOf: today, limits: limits.filter((x) => x.amount != null).map((x) => ({ accountId: x.accountId, amount: x.amount! })), receiptsFrom: q.receiptsFrom, money: fmt },
    );
    const inPeriod = rows.filter((c) => businessDate(c.submittedAt!) >= from && businessDate(c.submittedAt!) <= today);
    const items = r.findings.map((f) => ({ ...f, claim: { ...f.claim, title: rows.find((c) => c.id === f.claim.id)!.title } }));
    return {
      asOf: today,
      from,
      days: q.days,
      receiptsFrom: q.receiptsFrom ?? EXPENSE_RISK_RECEIPTS_FROM,
      summary: {
        claims: inPeriod.length,
        flagged: items.length,
        high: items.filter((i) => i.level === 'HIGH').length,
        medium: items.filter((i) => i.level === 'MEDIUM').length,
        low: items.filter((i) => i.level === 'LOW').length,
        people: r.people.length,
        byIndicator: Object.fromEntries(EXPENSE_RISK_INDICATORS.map((c) => [c, items.filter((i) => i.indicators.some((x) => x.code === c)).length])),
      },
      items,
      people: r.people,
    };
  }
}
