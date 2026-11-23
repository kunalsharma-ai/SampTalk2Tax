import { Injectable } from '@nestjs/common';
import { riskMonitor, type RiskArea, type RiskAreaInput } from '@talk2tax/accounting-engine';
import { hasPermission, type Permission } from '@talk2tax/security';
import { AlertsService } from '../alerts/alerts.service';
import type { OrgContext } from '../auth/decorators';
import { BankActivityService } from '../bank-activity/bank-activity.service';
import { todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { runInOrg } from '../common/tenant-context';
import { CompliancePredictionsService } from '../compliance/compliance-predictions.service';
import { riskReadings } from '../db/collections/risk-readings';
import { ExpenseRiskService } from '../expense-risk/expense-risk.service';
import { PaymentFraudService } from '../payment-fraud/payment-fraud.service';
import { VendorRiskService } from '../vendor-risk/vendor-risk.service';

type Level = 'HIGH' | 'MEDIUM' | 'LOW';
interface Finding {
  title: string;
  detail: string;
  level: Level;
}
interface AreaRead {
  counts: Omit<RiskAreaInput, 'area'>;
  top: Finding[];
  window: string;
}

/** What each area reads, who may see it, and where to act on it. */
const AREAS: Record<RiskArea, { name: string; permission: Permission; href: string }> = {
  ALERTS: { name: 'Alerts', permission: 'reports.read', href: '/alerts' },
  PAYMENTS: { name: 'Payment fraud checks', permission: 'reports.read', href: '/purchases/payment-fraud' },
  EXPENSES: { name: 'Expense risk', permission: 'expenses.read', href: '/expenses/risk' },
  BANK: { name: 'Unusual bank activity', permission: 'banking.read', href: '/banking/unusual-activity' },
  COMPLIANCE: { name: 'Compliance deadlines', permission: 'reports.read', href: '/tax/compliance-predictions' },
  VENDORS: { name: 'Vendor risk', permission: 'purchases.read', href: '/purchases/vendor-risk' },
};
const TOP = 3; // not money
const HISTORY_DAYS = 90; // not money
const sev = (s: string): Level => (s === 'CRITICAL' || s === 'HIGH' ? 'HIGH' : s === 'WARNING' || s === 'MEDIUM' ? 'MEDIUM' : 'LOW');

/**
 * Risk monitor (DASH-036): reads the organisation's own risk checks (alerts, payment fraud
 * checks, expense risk, unusual bank activity, compliance deadline risk and vendor risk), scores
 * each area and the whole, and keeps one reading a day so the trend can be shown. An area the
 * member's role cannot read is left out of the score and shown as not available. reports.read.
 */
@Injectable()
export class RiskMonitorService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly alerts: AlertsService,
    private readonly fraud: PaymentFraudService,
    private readonly expenses: ExpenseRiskService,
    private readonly bank: BankActivityService,
    private readonly deadlines: CompliancePredictionsService,
    private readonly vendors: VendorRiskService,
  ) {}

  private async read(org: OrgContext, area: RiskArea, today: string): Promise<AreaRead> {
    const counted = <T>(items: T[], level: (t: T) => Level, finding: (t: T) => Omit<Finding, 'level'>) => ({
      high: items.filter((i) => level(i) === 'HIGH').length,
      medium: items.filter((i) => level(i) === 'MEDIUM').length,
      low: items.filter((i) => level(i) === 'LOW').length,
      top: items.slice(0, TOP).map((i) => ({ ...finding(i), level: level(i) })),
    });
    switch (area) {
      case 'ALERTS': {
        const r = await this.alerts.list(org.id, { status: 'ACTIVE' });
        const c = counted(r.alerts, (a) => sev(a.severity), (a) => ({ title: a.title, detail: a.ruleName }));
        return { counts: { high: c.high, medium: c.medium, low: c.low, active: true }, top: c.top, window: 'Open and acknowledged alerts' };
      }
      case 'PAYMENTS': {
        const r = await this.fraud.report(org, today);
        const c = counted(r.payments, (p) => sev(p.level ?? 'LOW'), (p) => ({ title: p.vendor, detail: `${p.amount} ${p.currency} on ${p.date}` }));
        return { counts: { high: c.high, medium: c.medium, low: c.low, active: true }, top: c.top, window: `Payments of the last ${r.windowDays} days and batches waiting` };
      }
      case 'EXPENSES': {
        const r = await this.expenses.findings(org, { days: 90 }, today);
        const c = counted(r.items, (i) => sev(i.level), (i) => ({ title: i.claim.title, detail: `${i.claim.claimantName}, ${i.claim.total} ${i.claim.currency}` }));
        return { counts: { high: c.high, medium: c.medium, low: c.low, active: true }, top: c.top, window: 'Claims submitted in the last 90 days' };
      }
      case 'BANK': {
        const r = await this.bank.findings(org, { days: 30 }, today);
        const c = counted(r.items, (i) => sev(i.level), (i) => ({ title: i.description ?? 'Bank line', detail: `${i.account.name}, ${i.amount} ${i.account.currency} on ${i.date}` }));
        return { counts: { high: c.high, medium: c.medium, low: c.low, active: true }, top: c.top, window: 'Bank lines of the last 30 days' };
      }
      case 'COMPLIANCE': {
        const r = await this.deadlines.predict(org, 30, today);
        const c = counted(r.items, (i) => sev(i.risk), (i) => ({ title: `${i.name} · ${i.periodLabel}`, detail: `Due ${i.dueDate}` }));
        return { counts: { high: c.high, medium: c.medium, low: c.low, active: r.configured }, top: c.top, window: 'Deadlines overdue or due in the next 30 days' };
      }
      case 'VENDORS': {
        const r = await this.vendors.list(org.id);
        const risky = r.vendors.filter((v) => v.level === 'HIGH' || v.level === 'MEDIUM' || v.level === 'LOW');
        const c = counted(risky, (v) => sev(v.level), (v) => ({ title: v.name, detail: v.factors.length ? `${v.factors.length} risk factor${v.factors.length === 1 ? '' : 's'}` : 'Risk factors found' }));
        return { counts: { high: c.high, medium: c.medium, low: c.low, active: r.totals.vendors > 0 }, top: c.top, window: 'Active vendors' };
      }
    }
  }

  async monitor(org: OrgContext, today = todayIso()) {
    const keys = Object.keys(AREAS) as RiskArea[];
    const reads = await Promise.all(keys.map((k) => (hasPermission(org.role, AREAS[k].permission) ? this.read(org, k, today) : Promise.resolve(null))));
    const col = this.store.collection(riskReadings);
    const previous = await runInOrg(org.id, () => col.findOne({ date: { $lt: today } }, { sort: { date: -1 } }));
    const result = riskMonitor(
      keys.map((area, i) => ({ area, ...(reads[i]?.counts ?? { high: 0, medium: 0, low: 0, active: false }) })),
      previous ? { score: previous.score, areas: Object.fromEntries(previous.areas.map((a) => [a.area, a.score])) } : null,
    );
    // Today's reading is kept only from a full view, so a narrower role does not overwrite it.
    const full = reads.every((r) => r !== null);
    if (full) {
      await runInOrg(org.id, () =>
        col.updateOne({ date: today }, { $set: { score: result.score, level: result.level, areas: result.areas.map((a) => ({ area: a.area, score: a.score, high: a.high, medium: a.medium, low: a.low, active: a.active })), takenAt: new Date() } }, { upsert: true }),
      );
    }
    const history = await runInOrg(org.id, () => col.find({ date: { $gte: new Date(Date.parse(`${today}T00:00:00Z`) - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10) } }, { sort: { date: 1 } }));
    return {
      today,
      ...result,
      complete: full,
      previous: previous ? { date: previous.date, score: previous.score, level: previous.level } : null,
      areas: result.areas.map((a, i) => ({ ...a, name: AREAS[a.area].name, href: AREAS[a.area].href, available: reads[i] !== null, window: reads[i]?.window ?? null, top: reads[i]?.top ?? [] })),
      history: history.map((h) => ({ date: h.date, score: h.score, level: h.level, areas: Object.fromEntries(h.areas.map((a) => [a.area, a.score])) })),
    };
  }
}
