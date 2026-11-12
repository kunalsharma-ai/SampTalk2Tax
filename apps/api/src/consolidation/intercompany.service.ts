import { HttpStatus, Injectable } from '@nestjs/common';
import { D, minorUnits, type JournalLineInput } from '@talk2tax/accounting-engine';
import type { IntercompanyTransaction } from '@talk2tax/database';
import { hasPermission, type Permission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import type { OrgContext } from '../auth/decorators';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx, useOrgInTx } from '../common/prisma.service';
import { currentTenantContext, tenantStorage } from '../common/tenant-context';
import { JournalsService } from '../journals/journals.service';
import { nextCounter } from '../db/counters';
import { holdLock, lockRow } from '../db/locks';

type Actor = { id: string };

export interface IntercompanyInput {
  kind: 'CHARGE' | 'SETTLEMENT';
  fromOrgId: string;
  toOrgId: string;
  date: string;
  description: string;
  amount: string;
  toAmount?: string | null;
  fromBankCode?: string | null;
  toBankCode?: string | null;
}

/**
 * Runs the deferred ledger checks (every posted entry balances, with at least two lines) now,
 * while the transaction still points at the company that owns the entry. At commit they would
 * run under whichever company the transaction points at last, where row-level security hides
 * the other company's lines.
 */
async function checkNow(tx: Tx) {
  await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
  await tx.$executeRawUnsafe('SET CONSTRAINTS ALL DEFERRED');
}

const AMOUNT = /^\d{1,14}(\.\d{1,4})?$/;

/**
 * Intercompany transactions between two companies of a consolidation group. A charge (one company
 * invoices another for goods, services or fees) or a settlement (the buyer pays) is posted in both
 * companies' books in one database transaction: either both entries exist or neither does. Each
 * entry goes through the same validation, period locks, numbering and audit as any other journal,
 * in its own company. The consolidation then eliminates the posted amounts exactly.
 */
@Injectable()
export class IntercompanyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journals: JournalsService,
  ) {}

  private async roles(userId: string) {
    const ms = await this.prisma.membership.findMany({ where: { userId }, select: { orgId: true, role: true } });
    return new Map(ms.map((m) => [m.orgId, m.role as RoleName]));
  }

  private async group(org: OrgContext, id: string) {
    const g = await this.prisma.consolidationGroup.findFirst({ where: { id, orgId: org.id }, include: { members: true } });
    if (!g) throw new DomainError('NOT_FOUND', 'Group not found', HttpStatus.NOT_FOUND);
    return g;
  }

  private async orgs(ids: string[]) {
    const os = await this.prisma.organization.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, functionalCurrency: true } });
    return new Map(os.map((o) => [o.id, o]));
  }

  /** Accounts by code in one company, read inside that company's tenant context. */
  private async accounts(orgId: string, codes: string[]) {
    const list = await tenantStorage.run({ ...currentTenantContext(), orgId, inTx: false }, async () => await this.prisma.account.findMany({ where: { orgId, code: { in: codes } } }));
    return new Map(list.map((a) => [a.code, a]));
  }

  private need(roles: Map<string, RoleName>, orgId: string, perm: Permission, name: string, issues: string[]) {
    const role = roles.get(orgId);
    if (!role || !hasPermission(role, perm)) issues.push(`You need ${perm} in ${name}`);
  }

  async list(org: OrgContext, userId: string, groupId: string) {
    const g = await this.group(org, groupId);
    const roles = await this.roles(userId);
    const canRead = (oid: string) => {
      const r = roles.get(oid);
      return !!r && hasPermission(r, 'journals.read');
    };
    const txns = await this.prisma.intercompanyTransaction.findMany({ where: { groupId, orgId: org.id }, orderBy: { number: 'desc' }, take: 500 });
    const visible = txns.filter((t) => canRead(t.fromOrgId) && canRead(t.toOrgId));
    const names = await this.orgs(g.members.map((m) => m.memberOrgId));
    const entryNumbers = new Map<string, number | null>();
    for (const t of visible) {
      for (const [oid, ids] of [
        [t.fromOrgId, [t.fromEntryId, t.fromReversalId]],
        [t.toOrgId, [t.toEntryId, t.toReversalId]],
      ] as const) {
        const want = ids.filter((x): x is string => !!x && !entryNumbers.has(x));
        if (!want.length) continue;
        const es = await tenantStorage.run({ ...currentTenantContext(), orgId: oid, inTx: false }, async () => await this.prisma.journalEntry.findMany({ where: { id: { in: want } }, select: { id: true, entryNumber: true } }));
        for (const e of es) entryNumbers.set(e.id, e.entryNumber);
      }
    }
    return {
      items: visible.map((t) => this.view(t, names, entryNumbers)),
      hidden: txns.length - visible.length,
    };
  }

  private view(t: IntercompanyTransaction, names: Map<string, { name: string }>, numbers: Map<string, number | null>) {
    const entry = (id: string | null) => (id ? { id, entryNumber: numbers.get(id) ?? null } : null);
    return {
      id: t.id,
      number: t.number,
      reference: `IC-${String(t.number).padStart(4, '0')}`,
      kind: t.kind,
      date: fromDbDate(t.date),
      description: t.description,
      from: { orgId: t.fromOrgId, name: names.get(t.fromOrgId)?.name ?? null, currency: t.fromCurrency, amount: t.amount.toFixed(minorUnits(t.fromCurrency)), entry: entry(t.fromEntryId), reversal: entry(t.fromReversalId) },
      to: { orgId: t.toOrgId, name: names.get(t.toOrgId)?.name ?? null, currency: t.toCurrency, amount: t.toAmount.toFixed(minorUnits(t.toCurrency)), entry: entry(t.toEntryId), reversal: entry(t.toReversalId) },
      accounts: { fromReceivable: t.fromReceivableCode, toPayable: t.toPayableCode, fromRevenue: t.fromRevenueCode, toExpense: t.toExpenseCode, fromBank: t.fromBankCode, toBank: t.toBankCode },
      reversedOn: t.reversedOn ? fromDbDate(t.reversedOn) : null,
      createdAt: t.createdAt.toISOString(),
    };
  }

  async create(org: OrgContext, actor: Actor, groupId: string, input: IntercompanyInput) {
    const g = await this.group(org, groupId);
    const issues: string[] = [];
    const from = g.members.find((m) => m.memberOrgId === input.fromOrgId);
    const to = g.members.find((m) => m.memberOrgId === input.toOrgId);
    if (!from || !to) throw new DomainError('VALIDATION_FAILED', 'Both companies must be in the group', HttpStatus.UNPROCESSABLE_ENTITY);
    if (input.fromOrgId === input.toOrgId) throw new DomainError('VALIDATION_FAILED', 'Pick two different companies', HttpStatus.UNPROCESSABLE_ENTITY);
    const orgs = await this.orgs([input.fromOrgId, input.toOrgId]);
    const roles = await this.roles(actor.id);
    // Organisations the user does not belong to are not readable, and are not named.
    const label = (oid: string) => orgs.get(oid)?.name ?? 'a company you are not a member of';
    this.need(roles, input.fromOrgId, 'journals.post', label(input.fromOrgId), issues);
    this.need(roles, input.toOrgId, 'journals.post', label(input.toOrgId), issues);
    if (issues.length) throw new DomainError('FORBIDDEN', 'You need to be able to post journals in both companies', HttpStatus.FORBIDDEN, { issues });
    const fromOrg = orgs.get(input.fromOrgId)!;
    const toOrg = orgs.get(input.toOrgId)!;

    // Amounts in each company's own currency.
    const fc = fromOrg.functionalCurrency;
    const tc = toOrg.functionalCurrency;
    const money = (v: string | null | undefined, cur: string, label: string) => {
      if (!v || !AMOUNT.test(v) || new D(v).lte(0)) return issues.push(`Enter the ${label} as an amount above zero`), null;
      if (new D(v).decimalPlaces() > minorUnits(cur)) return issues.push(`The ${label} has more decimals than ${cur} allows`), null;
      return new D(v).toFixed(minorUnits(cur));
    };
    const amount = money(input.amount, fc, `amount in ${fc}`);
    let toAmount: string | null;
    if (fc === tc) {
      toAmount = amount;
      if (input.toAmount && amount && !new D(input.toAmount).eq(amount)) issues.push(`Both companies keep their books in ${fc}, so the amounts must be the same`);
    } else {
      toAmount = money(input.toAmount, tc, `amount in ${tc} for ${toOrg.name}`);
    }

    // Each company's intercompany accounts.
    const charge = input.kind === 'CHARGE';
    const need = (code: string | null, label: string) => {
      if (!code) issues.push(`Set ${label} in the group's intercompany accounts`);
      return code ?? '';
    };
    const fromReceivable = need(from.icReceivableCode, `${fromOrg.name}'s receivable account`);
    const toPayable = need(to.icPayableCode, `${toOrg.name}'s payable account`);
    const fromRevenue = charge ? need(from.icRevenueCode, `${fromOrg.name}'s revenue account`) : null;
    const toExpense = charge ? need(to.icExpenseCode, `${toOrg.name}'s expense account`) : null;
    let fromBank: string | null = null;
    let toBank: string | null = null;
    if (!charge) {
      fromBank = input.fromBankCode?.trim() || null;
      toBank = input.toBankCode?.trim() || null;
      if (!fromBank) issues.push(`Choose the bank account ${fromOrg.name} receives the money in`);
      if (!toBank) issues.push(`Choose the bank account ${toOrg.name} pays from`);
    } else if (input.fromBankCode || input.toBankCode) {
      issues.push('A charge does not use bank accounts');
    }
    if (issues.length) throw new DomainError('VALIDATION_FAILED', issues[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { issues });

    const fromAcc = await this.accounts(fromOrg.id, [fromReceivable, fromRevenue, fromBank].filter((c): c is string => !!c));
    const toAcc = await this.accounts(toOrg.id, [toPayable, toExpense, toBank].filter((c): c is string => !!c));
    const id = (accs: typeof fromAcc, code: string, who: string) => {
      const a = accs.get(code);
      if (!a) return issues.push(`${who} has no account ${code}`), '';
      if (!a.isActive || !a.isPostable) return issues.push(`${who}: ${code} ${a.name} is not an active posting account`), '';
      return a.id;
    };
    const bankOk = (accs: typeof fromAcc, code: string | null, who: string) => {
      const a = code ? accs.get(code) : null;
      if (a && !(a.type === 'ASSET' && ['BANK', 'CASH'].includes(a.subtype ?? ''))) issues.push(`${who}: ${code} ${a.name} is not a bank or cash account`);
    };
    const ref = (n: number) => `IC-${String(n).padStart(4, '0')}`;
    const memo = input.description.trim();
    const fromLines = (): JournalLineInput[] =>
      charge
        ? [
            { accountId: id(fromAcc, fromReceivable, fromOrg.name), debit: amount!, description: `Due from ${toOrg.name}` },
            { accountId: id(fromAcc, fromRevenue!, fromOrg.name), credit: amount!, description: memo },
          ]
        : [
            { accountId: id(fromAcc, fromBank!, fromOrg.name), debit: amount!, description: `Received from ${toOrg.name}` },
            { accountId: id(fromAcc, fromReceivable, fromOrg.name), credit: amount!, description: `Settled by ${toOrg.name}` },
          ];
    const toLines = (): JournalLineInput[] =>
      charge
        ? [
            { accountId: id(toAcc, toExpense!, toOrg.name), debit: toAmount!, description: memo },
            { accountId: id(toAcc, toPayable, toOrg.name), credit: toAmount!, description: `Due to ${fromOrg.name}` },
          ]
        : [
            { accountId: id(toAcc, toPayable, toOrg.name), debit: toAmount!, description: `Settled with ${fromOrg.name}` },
            { accountId: id(toAcc, toBank!, toOrg.name), credit: toAmount!, description: `Paid to ${fromOrg.name}` },
          ];
    const fl = fromLines();
    const tl = toLines();
    bankOk(fromAcc, fromBank, fromOrg.name);
    bankOk(toAcc, toBank, toOrg.name);
    if (issues.length) throw new DomainError('VALIDATION_FAILED', issues[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { issues });

    const created = await this.prisma.$transaction(async (tx) => {
      const number = await this.nextNumber(tx, org.id);
      const reference = ref(number);
      const kindLabel = charge ? 'Intercompany charge' : 'Intercompany settlement';
      // Each company's entry is posted with the transaction pointed at that company, so its
      // row-level security, period locks and numbering apply exactly as for its own journals.
      await useOrgInTx(tx, fromOrg.id);
      const fe = await this.journals.postSystemEntry(tx, { id: fromOrg.id, functionalCurrency: fc }, actor, {
        date: input.date,
        memo: `${kindLabel} ${charge ? 'to' : 'from'} ${toOrg.name}: ${memo}`,
        reference,
        source: 'INTERCOMPANY',
        lines: fl,
      });
      await checkNow(tx);
      await useOrgInTx(tx, toOrg.id);
      const te = await this.journals.postSystemEntry(tx, { id: toOrg.id, functionalCurrency: tc }, actor, {
        date: input.date,
        memo: `${kindLabel} ${charge ? 'from' : 'to'} ${fromOrg.name}: ${memo}`,
        reference,
        source: 'INTERCOMPANY',
        lines: tl,
      });
      await checkNow(tx);
      await useOrgInTx(tx, org.id);
      const t = await tx.intercompanyTransaction.create({
        data: {
          orgId: org.id,
          groupId,
          number,
          kind: input.kind,
          fromOrgId: fromOrg.id,
          toOrgId: toOrg.id,
          date: toDbDate(input.date),
          description: memo,
          amount: amount!,
          fromCurrency: fc,
          toAmount: toAmount!,
          toCurrency: tc,
          fromReceivableCode: fromReceivable,
          toPayableCode: toPayable,
          fromRevenueCode: fromRevenue,
          toExpenseCode: toExpense,
          fromBankCode: fromBank,
          toBankCode: toBank,
          fromEntryId: fe.id,
          toEntryId: te.id,
          createdById: actor.id,
        },
      });
      await this.audit.append(tx, {
        orgId: org.id,
        actorId: actor.id,
        action: 'intercompany.posted',
        entityType: 'intercompany_transaction',
        entityId: t.id,
        data: { groupId, reference, kind: input.kind, fromOrgId: fromOrg.id, toOrgId: toOrg.id, date: input.date, amount, toAmount, fromEntry: fe.entryNumber, toEntry: te.entryNumber },
      });
      return { t, numbers: new Map<string, number | null>([[fe.id, fe.entryNumber], [te.id, te.entryNumber]]) };
    });
    return this.view(created.t, new Map([[fromOrg.id, fromOrg], [toOrg.id, toOrg]]), created.numbers);
  }

  async reverse(org: OrgContext, actor: Actor, groupId: string, txnId: string, input: { date: string }) {
    await this.group(org, groupId);
    const t = await this.prisma.intercompanyTransaction.findFirst({ where: { id: txnId, groupId, orgId: org.id } });
    if (!t) throw new DomainError('NOT_FOUND', 'Intercompany transaction not found', HttpStatus.NOT_FOUND);
    const orgs = await this.orgs([t.fromOrgId, t.toOrgId]);
    const roles = await this.roles(actor.id);
    const issues: string[] = [];
    const label = (oid: string) => orgs.get(oid)?.name ?? 'a company you are not a member of';
    this.need(roles, t.fromOrgId, 'journals.reverse', label(t.fromOrgId), issues);
    this.need(roles, t.toOrgId, 'journals.reverse', label(t.toOrgId), issues);
    const fromOrg = orgs.get(t.fromOrgId)!;
    const toOrg = orgs.get(t.toOrgId)!;
    if (issues.length) throw new DomainError('FORBIDDEN', 'You need to be able to reverse journals in both companies', HttpStatus.FORBIDDEN, { issues });
    if (t.reversedOn) throw new DomainError('ALREADY_REVERSED', 'This transaction is already reversed', HttpStatus.CONFLICT);
    const reference = `IC-${String(t.number).padStart(4, '0')}`;
    const done = await this.prisma.$transaction(async (tx) => {
      // Lock the row so two reversals cannot both pass the check above.
      await lockRow(tx, 'intercompany_transactions', t.id);
      const locked = await tx.intercompanyTransaction.findFirst({ where: { id: t.id }, select: { reversedOn: true } });
      if (locked?.reversedOn) throw new DomainError('ALREADY_REVERSED', 'This transaction is already reversed', HttpStatus.CONFLICT);
      await useOrgInTx(tx, fromOrg.id);
      const fr = await this.journals.reverseSystemEntry(tx, { id: fromOrg.id, functionalCurrency: fromOrg.functionalCurrency }, actor, t.fromEntryId, { date: input.date, memo: `Reversal of ${reference}` });
      await checkNow(tx);
      await useOrgInTx(tx, toOrg.id);
      const tr = await this.journals.reverseSystemEntry(tx, { id: toOrg.id, functionalCurrency: toOrg.functionalCurrency }, actor, t.toEntryId, { date: input.date, memo: `Reversal of ${reference}` });
      await checkNow(tx);
      await useOrgInTx(tx, org.id);
      const u = await tx.intercompanyTransaction.update({ where: { id: t.id }, data: { reversedOn: toDbDate(input.date), fromReversalId: fr.id, toReversalId: tr.id, reversedById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'intercompany.reversed', entityType: 'intercompany_transaction', entityId: t.id, data: { groupId, reference, date: input.date, fromReversal: fr.entryNumber, toReversal: tr.entryNumber } });
      return { u, fr, tr };
    });
    const numbers = new Map<string, number | null>([
      [done.fr.id, done.fr.entryNumber],
      [done.tr.id, done.tr.entryNumber],
    ]);
    for (const [oid, eid] of [
      [fromOrg.id, t.fromEntryId],
      [toOrg.id, t.toEntryId],
    ] as const) {
      const e = await tenantStorage.run({ ...currentTenantContext(), orgId: oid, inTx: false }, async () => await this.prisma.journalEntry.findFirst({ where: { id: eid }, select: { entryNumber: true } }));
      numbers.set(eid, e?.entryNumber ?? null);
    }
    return this.view(done.u, orgs, numbers);
  }

  private async nextNumber(tx: Tx, orgId: string) {
    const [{ value }] = [{ value: await nextCounter(tx, orgId, 'intercompany') }];
    return value;
  }
}
