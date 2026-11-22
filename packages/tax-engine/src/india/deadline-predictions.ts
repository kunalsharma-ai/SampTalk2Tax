/**
 * Compliance deadline predictions (TAX-047): for each return or payment coming due, how likely it
 * is to be late, from how this organisation met the same obligation before and from what the books
 * say now (differences, mistakes, money not yet deposited).
 *
 * - Lead time: days before the due date it was done (negative = after), the median of the past.
 * - Late rate: past periods done after the due date or still not done, out of those that were due.
 * - Predicted date: the due date less the usual lead time.
 * - Risk: points for a high late rate, a predicted date after the due date, a usual date already
 *   gone by with the obligation still open, few days left with no history, and each signal from
 *   the books (a blocking one counts double). HIGH from 3 points, MEDIUM from 1.
 *
 * Deterministic; no AI model. Nothing is filed or paid here.
 */

export type DeadlineRisk = 'HIGH' | 'MEDIUM' | 'LOW';
export const DEADLINE_RISK_LABEL: Record<DeadlineRisk, string> = { HIGH: 'Likely late', MEDIUM: 'At risk', LOW: 'On track' };

export interface PastObligation {
  kind: string;
  dueDate: string;
  /** When it was filed or paid; null when it is not done. */
  doneOn: string | null;
}

export interface DeadlineSignal {
  severity: 'BLOCK' | 'WARN';
  message: string;
}

export interface UpcomingObligation {
  key: string;
  kind: string;
  name: string;
  period: string;
  periodLabel: string;
  dueDate: string;
  /** Whether the period the obligation covers has ended. */
  periodOver: boolean;
  signals?: DeadlineSignal[];
}

export interface DeadlinePrediction extends UpcomingObligation {
  daysLeft: number;
  risk: DeadlineRisk;
  history: number;
  late: number;
  lateRate: string | null;
  /** Median days before the due date it was done; negative means after. */
  usualLeadDays: number | null;
  predictedDate: string | null;
  reasons: string[];
  signals: DeadlineSignal[];
}

const DAY = 86_400_000; // not money
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY); // not money
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10); // not money
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2); // not money
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2); // not money
}
const fmtDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function deadlinePredictions(upcoming: readonly UpcomingObligation[], past: readonly PastObligation[], today: string): DeadlinePrediction[] {
  const out = upcoming.map((o): DeadlinePrediction => {
    const mine = past.filter((p) => p.kind === o.kind && p.dueDate < today && p.dueDate !== o.dueDate);
    const leads = mine.filter((p) => p.doneOn).map((p) => days(p.doneOn!, p.dueDate));
    const late = mine.filter((p) => !p.doneOn || p.doneOn > p.dueDate).length;
    const rate = mine.length ? late / mine.length : null; // not money
    const lead = leads.length ? median(leads) : null;
    const predicted = lead === null ? null : addDays(o.dueDate, -lead);
    const left = days(today, o.dueDate);
    const signals = o.signals ?? [];
    const reasons: string[] = [];
    let points = 0; // not money
    if (left < 0) {
      points += 3;
      reasons.push(`Overdue by ${-left} day${left === -1 ? '' : 's'}`);
    }
    if (rate !== null && mine.length >= 2 && rate >= 0.5) {
      points += 2;
      reasons.push(`Late ${late} of the last ${mine.length} times`);
    } else if (rate !== null && rate > 0) {
      points += 1;
      reasons.push(`Late ${late} of the last ${mine.length} time${mine.length === 1 ? '' : 's'}`);
    }
    if (lead !== null && lead < 0 && left >= 0) {
      points += 2;
      reasons.push(`Usually done ${-lead} day${lead === -1 ? '' : 's'} after the due date`);
    } else if (predicted !== null && predicted < today && left >= 0) {
      points += 1;
      reasons.push(`Usually done by ${fmtDate(predicted)}, and not done yet`);
    }
    if (lead === null && left >= 0 && left <= 3 && o.periodOver) {
      points += 1;
      reasons.push(`Due in ${left} day${left === 1 ? '' : 's'} with no record of how it was done before`);
    }
    for (const s of signals) points += s.severity === 'BLOCK' ? 2 : 1;
    const risk: DeadlineRisk = points >= 3 ? 'HIGH' : points >= 1 ? 'MEDIUM' : 'LOW';
    if (risk === 'LOW') {
      if (lead !== null && mine.length) reasons.push(`Done on time ${mine.length - late} of the last ${mine.length} times, usually ${lead === 0 ? 'on the due date' : `${lead} day${lead === 1 ? '' : 's'} early`}`);
      else if (!o.periodOver) reasons.push('The period has not ended yet');
      else reasons.push('Nothing points to it being late');
    }
    return {
      ...o,
      signals,
      daysLeft: left,
      risk,
      history: mine.length,
      late,
      lateRate: rate === null ? null : (rate * 100).toFixed(0), // not money
      usualLeadDays: lead,
      predictedDate: predicted,
      reasons,
    };
  });
  const rank: Record<DeadlineRisk, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 }; // not money
  return out.sort((a, b) => rank[a.risk] - rank[b.risk] || a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name));
}
