import { HttpStatus, Injectable } from '@nestjs/common';
import { REIMBURSEMENT_ROUTE_LABEL, routeReimbursements, type RoutingAccount } from '@talk2tax/accounting-engine';
import type { OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { BankingService } from '../banking/banking.service';
import { ExpensesService } from '../expenses/expenses.service';

type Actor = { id: string };

/**
 * Reimbursement routing (EXP-026): approved expense claims still to be paid, grouped per person,
 * each routed to a bank transfer (salary account on the employee record), cash, or waiting (no
 * room in the accounts after the buffer, or no bank details), with the account to pay from. The
 * ready groups can be paid in one step; each claim is reimbursed through the usual journal.
 * Bank account numbers are never shown.
 */
@Injectable()
export class ReimbursementRoutingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly banking: BankingService,
    private readonly expenses: ExpensesService,
  ) {}

  async plan(org: OrgContext, q: { buffer: string }, today = todayIso()) {
    const claims = await this.prisma.expenseClaim.findMany({
      where: { orgId: org.id, status: 'APPROVED', postingDate: { lte: toDbDate(today) } },
      select: { id: true, number: true, claimantId: true, total: true, postingDate: true },
    });
    const claimantIds = [...new Set(claims.map((c) => c.claimantId))];
    const [people, previous, accounts] = await Promise.all([
      claimantIds.length ? this.prisma.user.findMany({ where: { id: { in: claimantIds } }, select: { id: true, name: true, email: true } }) : [],
      claimantIds.length
        ? this.prisma.expenseClaim.findMany({ where: { orgId: org.id, status: 'REIMBURSED', claimantId: { in: claimantIds } }, orderBy: [{ reimbursedOn: 'desc' }, { updatedAt: 'desc' }], select: { claimantId: true, bankAccountId: true } })
        : [],
      this.banking.listAccounts(org),
    ]);
    const emails = people.map((p) => p.email.toLowerCase());
    const employees = emails.length
      ? (await this.prisma.employee.findMany({ where: { orgId: org.id }, select: { id: true, name: true, email: true, dateOfLeaving: true, bankAccountNumber: true, bankIfsc: true } })).filter(
          (e) => e.email && emails.includes(e.email.toLowerCase()) && (!e.dateOfLeaving || fromDbDate(e.dateOfLeaving) >= today),
        )
      : [];
    const name = new Map(people.map((p) => [p.id, p.name || p.email]));
    const lastAccount = new Map<string, string>();
    for (const p of previous) if (p.bankAccountId && !lastAccount.has(p.claimantId)) lastAccount.set(p.claimantId, p.bankAccountId);
    const payees = people.map((p) => {
      const e = employees.find((x) => x.email!.toLowerCase() === p.email.toLowerCase());
      return { claimantId: p.id, employee: e ? { id: e.id, name: e.name } : null, hasSalaryAccount: !!(e?.bankAccountNumber && e.bankIfsc), lastAccountId: lastAccount.get(p.id) ?? null };
    });
    const usable: RoutingAccount[] = accounts
      .filter((a) => a.isActive && a.currency === org.functionalCurrency)
      .map((a) => ({ id: a.id, code: a.code, name: a.name, kind: a.subtype === 'CASH' ? 'CASH' : 'BANK', balance: a.ledgerBalance }));
    const plan = routeReimbursements({
      claims: claims.map((c) => ({ id: c.id, number: c.number, claimantId: c.claimantId, claimant: name.get(c.claimantId) ?? 'Former member', total: c.total.toFixed(), approvedOn: fromDbDate(c.postingDate!) })),
      payees,
      accounts: usable,
      buffer: q.buffer,
      today,
      currency: org.functionalCurrency,
    });
    return {
      asOf: today,
      currency: org.functionalCurrency,
      buffer: q.buffer,
      ...plan,
      groups: plan.groups.map((g) => ({ ...g, routeLabel: REIMBURSEMENT_ROUTE_LABEL[g.route] })),
    };
  }

  /** Reimburses every claim of the chosen people whose route is ready, from the planned account, dated today. */
  async pay(org: OrgContext, actor: Actor, input: { claimantIds: string[]; buffer: string; reference?: string | null }, today = todayIso()) {
    const plan = await this.plan(org, { buffer: input.buffer }, today);
    const chosen = plan.groups.filter((g) => input.claimantIds.includes(g.claimantId));
    const ready = chosen.filter((g) => g.account);
    if (!ready.length) throw new DomainError('NOTHING_READY', 'None of the chosen people can be paid now: look at the reason on each', HttpStatus.CONFLICT);
    const paid = [];
    for (const g of ready) {
      for (const c of g.claims) await this.expenses.reimburse(org, actor, c.id, { bankAccountId: g.account!.id, date: today, reference: input.reference?.trim() || `Reimbursement routing ${g.routeLabel.toLowerCase()}` });
      paid.push({ claimantId: g.claimantId, claimant: g.claimant, claims: g.claims.map((c) => c.number), total: g.total, account: g.account, route: g.route });
    }
    return {
      paid,
      skipped: chosen.filter((g) => !g.account).map((g) => ({ claimantId: g.claimantId, claimant: g.claimant, route: g.route, reason: g.reason })),
      notFound: input.claimantIds.filter((id) => !plan.groups.some((g) => g.claimantId === id)).length,
    };
  }
}
