/**
 * Reimbursement routing (EXP-026): how and when to pay each person's approved expense claims.
 * Deterministic and explainable: every route says why.
 *
 * - Claims are grouped per claimant: one payment each.
 * - Order: groups waiting longer than the target (7 days from the earliest approval) first, then
 *   the earliest approval, then the smaller amount, then the name.
 * - Payee: a claimant matched to an employee record with a salary account is paid by bank
 *   transfer; one without is paid in cash, or waits for bank details when there is no cash account.
 * - Account: the account the claimant was last reimbursed from when it still has room, otherwise
 *   the one with the most room. Room = balance − buffer − what earlier groups in this plan take.
 *   Only active accounts in the functional currency count.
 * - When no account has room the group waits for cash; later, smaller groups may still fit.
 */
import { daysBetween } from './documents';
import { D, type Dec, dec, minorUnits, sum } from './money';

export const REIMBURSEMENT_TARGET_DAYS = 7;
export const REIMBURSEMENT_ROUTES = ['BANK_TRANSFER', 'CASH', 'WAIT_FOR_CASH', 'NEEDS_BANK_DETAILS'] as const;
export type ReimbursementRoute = (typeof REIMBURSEMENT_ROUTES)[number];
export const REIMBURSEMENT_ROUTE_LABEL: Record<ReimbursementRoute, string> = {
  BANK_TRANSFER: 'Bank transfer',
  CASH: 'Pay in cash',
  WAIT_FOR_CASH: 'Wait for cash',
  NEEDS_BANK_DETAILS: 'Needs bank details',
};

export interface RoutingClaim {
  id: string;
  number: string;
  claimantId: string;
  claimant: string;
  total: string;
  /** The day the claim was approved. */
  approvedOn: string;
}

export interface RoutingPayee {
  claimantId: string;
  /** The matched employee, or null when no employee record has the claimant's email. */
  employee: { id: string; name: string } | null;
  hasSalaryAccount: boolean;
  /** The account the claimant was last reimbursed from. */
  lastAccountId: string | null;
}

export interface RoutingAccount {
  id: string;
  code: string;
  name: string;
  kind: 'BANK' | 'CASH';
  balance: string;
}

export interface RoutingGroup {
  claimantId: string;
  claimant: string;
  employee: { id: string; name: string } | null;
  claims: { id: string; number: string; total: string; approvedOn: string }[];
  total: string;
  approvedOn: string;
  daysWaiting: number;
  overdue: boolean;
  route: ReimbursementRoute;
  account: { id: string; code: string; name: string } | null;
  reason: string;
}

export interface RoutingPlan {
  groups: RoutingGroup[];
  accounts: (RoutingAccount & { planned: string; left: string })[];
  totals: { claims: number; people: number; total: string; ready: string; waiting: string; overdue: number };
}

export function routeReimbursements(input: { claims: RoutingClaim[]; payees: RoutingPayee[]; accounts: RoutingAccount[]; buffer: string; today: string; currency: string }): RoutingPlan {
  const m = minorUnits(input.currency);
  const buffer = dec(input.buffer);
  const payees = new Map(input.payees.map((p) => [p.claimantId, p]));
  const planned = new Map<string, Dec>(input.accounts.map((a) => [a.id, new D(0)]));
  const room = (a: RoutingAccount) => dec(a.balance).minus(buffer).minus(planned.get(a.id)!);

  const byClaimant = new Map<string, RoutingClaim[]>();
  for (const c of input.claims) byClaimant.set(c.claimantId, [...(byClaimant.get(c.claimantId) ?? []), c]);
  const pending = [...byClaimant.values()].map((list) => {
    const claims = [...list].sort((a, b) => a.approvedOn.localeCompare(b.approvedOn) || a.number.localeCompare(b.number));
    const approvedOn = claims[0]!.approvedOn;
    const daysWaiting = Math.max(0, daysBetween(approvedOn, input.today)); // not money
    return { claims, total: sum(claims.map((c) => dec(c.total))), approvedOn, daysWaiting, overdue: daysWaiting > REIMBURSEMENT_TARGET_DAYS };
  });
  pending.sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.approvedOn.localeCompare(b.approvedOn) || a.total.cmp(b.total) || a.claims[0]!.claimant.localeCompare(b.claims[0]!.claimant)); // not money

  const groups: RoutingGroup[] = pending.map((g) => {
    const first = g.claims[0]!;
    const payee = payees.get(first.claimantId);
    const byTransfer = !!payee?.hasSalaryAccount;
    const kind = byTransfer ? 'BANK' : 'CASH';
    const candidates = input.accounts.filter((a) => a.kind === kind);
    const fits = candidates.filter((a) => room(a).gte(g.total));
    const last = fits.find((a) => a.id === payee?.lastAccountId);
    const best = last ?? [...fits].sort((a, b) => room(b).cmp(room(a)) || a.code.localeCompare(b.code))[0];
    let route: ReimbursementRoute;
    let reason: string;
    const who = payee?.employee ? `${payee.employee.name}'s salary account is on the employee record` : null;
    if (best) {
      planned.set(best.id, planned.get(best.id)!.plus(g.total));
      route = byTransfer ? 'BANK_TRANSFER' : 'CASH';
      const why = last ? 'the account they were last reimbursed from' : 'the account with the most room';
      reason = byTransfer ? `${who}. Pay from ${best.name}, ${why}.` : `No salary account on file for them, so pay in cash from ${best.name}, ${why}.`;
    } else if (!byTransfer && !candidates.length) {
      route = 'NEEDS_BANK_DETAILS';
      reason = payee?.employee ? `${payee.employee.name} has no salary account on the employee record and there is no cash account. Add their bank details to pay them.` : 'They are not matched to an employee record by email, so there are no bank details to pay into. Add them as an employee with a salary account.';
    } else {
      route = 'WAIT_FOR_CASH';
      reason = candidates.length
        ? `No ${byTransfer ? 'bank' : 'cash'} account has room for ${g.total.toFixed(m)} after keeping the buffer and paying the claims above. Pay when money comes in.`
        : 'There is no active bank account in your currency to pay from.';
    }
    return {
      claimantId: first.claimantId,
      claimant: first.claimant,
      employee: payee?.employee ?? null,
      claims: g.claims.map((c) => ({ id: c.id, number: c.number, total: dec(c.total).toFixed(m), approvedOn: c.approvedOn })),
      total: g.total.toFixed(m),
      approvedOn: g.approvedOn,
      daysWaiting: g.daysWaiting,
      overdue: g.overdue,
      route,
      account: best && (route === 'BANK_TRANSFER' || route === 'CASH') ? { id: best.id, code: best.code, name: best.name } : null,
      reason,
    };
  });

  const ready = groups.filter((g) => g.account);
  return {
    groups,
    accounts: input.accounts.map((a) => ({ ...a, planned: planned.get(a.id)!.toFixed(m), left: dec(a.balance).minus(planned.get(a.id)!).toFixed(m) })),
    totals: {
      claims: input.claims.length,
      people: groups.length,
      total: sum(groups.map((g) => dec(g.total))).toFixed(m),
      ready: sum(ready.map((g) => dec(g.total))).toFixed(m),
      waiting: sum(groups.filter((g) => !g.account).map((g) => dec(g.total))).toFixed(m),
      overdue: groups.filter((g) => g.overdue).length,
    },
  };
}
