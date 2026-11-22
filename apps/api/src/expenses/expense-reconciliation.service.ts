import { Injectable } from '@nestjs/common';
import { addDays, D, EXPENSE_RECON_REIMBURSED_DAYS, minorUnits, reconcileExpenseClaims, type ExpenseReconClaim, type ExpenseReconReimbursement } from '@talk2tax/accounting-engine';
import type { OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { bankMatches, bankStatementLines } from '../db/collections/banking';
import { accounts } from '../db/collections/chart';
import { expenseClaims } from '../db/collections/expenses';
import { users } from '../db/collections/identity';
import { journalEntries } from '../db/collections/ledger';
import { organizations } from '../db/collections/tenancy';

/**
 * Expense reconciliation (EXP-016): the Employee Reimbursements Payable account against the
 * approved claims still owed, reimbursements against the bank statements, and what is owed by age
 * and employee. MongoDB only; read-only.
 */
@Injectable()
export class ExpenseReconciliationService {
  constructor(private readonly store: DocumentStoreService) {}

  async reconcile(org: OrgContext, q: { asOf?: string }) {
    const asOf = q.asOf ?? todayIso();
    const scale = minorUnits(org.functionalCurrency);
    const accountId = (await this.store.collection(organizations).findById(org.id))?.claimsAccountId ?? null;
    const [claimDocs, entries] = await Promise.all([
      this.store.collection(expenseClaims).find({ status: { $in: ['APPROVED', 'REIMBURSED', 'VOID'] }, postingDate: { $lte: toDbDate(asOf) } }),
      accountId ? this.store.collection(journalEntries).find({ status: 'POSTED', 'lines.accountId': accountId, date: { $lte: toDbDate(asOf) } }) : [],
    ]);
    const people = new Map((await this.store.collection(users).find({ id: { $in: [...new Set(claimDocs.map((c) => c.claimantId))] } })).map((u) => [u.id, u.name]));
    const claims: ExpenseReconClaim[] = claimDocs.map((c) => ({
      id: c.id,
      number: c.number,
      claimantId: c.claimantId,
      claimant: people.get(c.claimantId) ?? 'Former member',
      title: c.title,
      total: new D(c.total).toFixed(),
      approvedOn: fromDbDate(c.postingDate!),
      reimbursedOn: c.reimbursedOn ? fromDbDate(c.reimbursedOn) : null,
      voidDate: c.voidDate ? fromDbDate(c.voidDate) : null,
      entryIds: [c.journalEntryId, c.reimbursementJournalEntryId, c.voidJournalEntryId].filter((x): x is string => !!x),
    }));
    const ledger = entries.flatMap((e) =>
      e.lines
        .filter((l) => l.accountId === accountId)
        .map((l) => ({ entryId: e.id, entryNumber: e.entryNumber, date: fromDbDate(e.date), memo: e.memo, source: e.source, net: new D(l.functionalCredit).minus(l.functionalDebit).toFixed() })),
    );

    // Reimbursements of the last 90 days and their bank lines.
    const since = addDays(asOf, -EXPENSE_RECON_REIMBURSED_DAYS);
    const paid = claimDocs.filter((c) => c.reimbursementJournalEntryId && c.reimbursedOn && fromDbDate(c.reimbursedOn) > since && fromDbDate(c.reimbursedOn) <= asOf);
    const payEntries = new Map((paid.length ? await this.store.collection(journalEntries).find({ id: { $in: paid.map((c) => c.reimbursementJournalEntryId!) } }) : []).map((e) => [e.id, e]));
    const bankLine = new Map(paid.map((c) => [c.id, payEntries.get(c.reimbursementJournalEntryId!)?.lines.find((l) => l.accountId === c.bankAccountId) ?? null]));
    const lineIds = [...bankLine.values()].filter((l) => l).map((l) => l!.id);
    const bankIds = [...new Set(paid.map((c) => c.bankAccountId!))];
    const [matches, banks, latest] = await Promise.all([
      lineIds.length ? this.store.collection(bankMatches).find({ journalLineId: { $in: lineIds }, removedAt: null }) : [],
      bankIds.length ? this.store.collection(accounts).find({ id: { $in: bankIds } }, { projection: { id: 1, code: 1, name: 1 } }) : [],
      Promise.all(bankIds.map(async (id) => [id, (await this.store.collection(bankStatementLines).find({ accountId: id }, { sort: { date: -1 }, limit: 1 }))[0]?.date ?? null] as const)),
    ]);
    const matched = new Set(matches.map((m) => m.journalLineId));
    const bankName = new Map(banks.map((b) => [b.id, `${b.code} · ${b.name}`]));
    const through = new Map(latest.map(([id, d]) => [id, d ? fromDbDate(d) : null]));
    const reimbursements: ExpenseReconReimbursement[] = paid.map((c) => ({
      claimId: c.id,
      number: c.number,
      claimant: people.get(c.claimantId) ?? 'Former member',
      amount: new D(c.total).toFixed(),
      date: fromDbDate(c.reimbursedOn!),
      bankAccount: bankName.get(c.bankAccountId!) ?? '',
      matched: !!bankLine.get(c.id) && matched.has(bankLine.get(c.id)!.id),
      statementThrough: through.get(c.bankAccountId!) ?? null,
    }));

    const r = reconcileExpenseClaims({ claims, ledger, reimbursements, asOf, currency: org.functionalCurrency, scale });
    const account = accountId ? await this.store.collection(accounts).findById(accountId) : null;
    return { ...r, currency: org.functionalCurrency, account: account ? { id: account.id, code: account.code, name: account.name } : null };
  }
}
