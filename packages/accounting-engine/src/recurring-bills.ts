import type { RecurringFrequency } from './recurring-journals';

/**
 * Recurring bills (AP-005): a vendor bill entered again and again (rent, a maintenance contract,
 * a software subscription). A recurring bill keeps the vendor, the lines and a schedule; every run
 * that falls due becomes a bill dated the run date, as a draft to review or posted straight away,
 * made by the same code as a bill entered by hand (GST, TDS, approval rules, periods).
 *
 * The schedule itself (runDate, dueRuns, upcomingRuns, scheduleFinished, runCount,
 * describeSchedule) and the text placeholders ({month}, {period}, ...) are those of recurring
 * journals.
 */

export const recurringBillRef = (n: number) => `RB-${String(n).padStart(4, '0')}`;

/** Placeholders that give each run of a schedule of this frequency a different value. */
const VARYING: Record<RecurringFrequency, string[]> = {
  MONTHLY: ['{date}', '{month}', '{period}'],
  QUARTERLY: ['{date}', '{month}', '{period}', '{quarter}'],
  HALF_YEARLY: ['{date}', '{month}', '{period}', '{quarter}'],
  YEARLY: ['{date}', '{month}', '{period}', '{quarter}', '{fy}', '{year}'],
};

/**
 * A bill's vendor reference must not repeat for the same vendor (a duplicate bill is refused). So
 * a reference on a recurring bill must change from run to run: it needs a placeholder that differs
 * between runs of its frequency, such as "Rent {month}" for a monthly bill. Returns the problem, or
 * null when the reference is fine (or empty: the runs then carry no vendor reference).
 */
export function recurringReferenceIssue(reference: string | null | undefined, frequency: RecurringFrequency): string | null {
  const r = reference?.trim();
  if (!r) return null;
  if (VARYING[frequency].some((p) => r.includes(p))) return null;
  return `The vendor reference "${r}" would repeat on every bill, and a vendor's reference cannot be entered twice. Add a placeholder that changes each run, such as ${VARYING[frequency][1]}, or leave it empty.`;
}
