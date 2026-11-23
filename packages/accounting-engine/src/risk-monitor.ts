/**
 * Risk monitor (DASH-036): one reading of the organisation's risk across areas that each have
 * their own checks (alerts, payments, expenses, bank activity, compliance deadlines, vendors).
 * Each area scores 0 to 100 from how many high, medium and low findings it has; the overall score
 * leans on the worst area, so one area in trouble cannot be hidden by quiet ones. Pure.
 */
export const RISK_AREAS = ['ALERTS', 'PAYMENTS', 'EXPENSES', 'BANK', 'COMPLIANCE', 'VENDORS'] as const;
export type RiskArea = (typeof RISK_AREAS)[number];
export const RISK_MONITOR_LEVELS = ['CLEAR', 'LOW', 'ELEVATED', 'HIGH', 'SEVERE'] as const;
export type RiskMonitorLevel = (typeof RISK_MONITOR_LEVELS)[number];

/** Points per finding: a high finding weighs as much as two and a half medium ones. */
export const RISK_WEIGHTS = { high: 25, medium: 10, low: 3 } as const;

export interface RiskAreaInput {
  area: RiskArea;
  high: number;
  medium: number;
  low: number;
  /** False when the area has nothing to check yet (no bank accounts, no compliance set-up). */
  active: boolean;
}

export const riskLevel = (score: number): RiskMonitorLevel => (score === 0 ? 'CLEAR' : score < 25 ? 'LOW' : score < 50 ? 'ELEVATED' : score < 75 ? 'HIGH' : 'SEVERE');

export function riskAreaScore(a: Pick<RiskAreaInput, 'high' | 'medium' | 'low'>): number {
  return Math.min(100, a.high * RISK_WEIGHTS.high + a.medium * RISK_WEIGHTS.medium + a.low * RISK_WEIGHTS.low); // not money: counts
}

export function riskMonitor(areas: readonly RiskAreaInput[], previous?: { score: number; areas: Partial<Record<RiskArea, number>> } | null) {
  const scored = RISK_AREAS.map((area) => {
    const a = areas.find((x) => x.area === area) ?? { area, high: 0, medium: 0, low: 0, active: false };
    const score = riskAreaScore(a);
    const before = previous?.areas[area];
    return { area, high: a.high, medium: a.medium, low: a.low, findings: a.high + a.medium + a.low, active: a.active, score, level: riskLevel(score), change: before === undefined ? null : score - before }; // not money
  });
  const active = scored.filter((a) => a.active);
  const worst = active.reduce((m, a) => Math.max(m, a.score), 0); // not money
  const mean = active.length ? active.reduce((t, a) => t + a.score, 0) / active.length : 0; // not money
  const score = Math.round(worst * 0.6 + mean * 0.4); // not money
  const order = (l: RiskMonitorLevel) => RISK_MONITOR_LEVELS.indexOf(l);
  return {
    score,
    level: riskLevel(score),
    change: previous ? score - previous.score : null, // not money
    areas: scored,
    /** Areas to look at first: the worst level, then the most high findings. */
    focus: [...scored].filter((a) => a.score > 0).sort((a, b) => order(b.level) - order(a.level) || b.high - a.high || b.score - a.score || RISK_AREAS.indexOf(a.area) - RISK_AREAS.indexOf(b.area)).map((a) => a.area), // not money
  };
}
