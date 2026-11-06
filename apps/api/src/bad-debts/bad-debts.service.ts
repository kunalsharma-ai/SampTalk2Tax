import { ForbiddenException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  AGEING_BUCKETS,
  ageingBucket,
  D,
  DEFAULT_PROVISION_RATES,
  dec,
  minorUnits,
  PROVISION_BUCKET_LABEL,
  provisionAdjustment,
  provisionMatrix,
  rateIssues,
  toFunctional,
  writeOffIssues,
  type AgeingBucket,
  type ProvisionResult,
} from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate, todayIso } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { JournalsService } from '../journals/journals.service';
import { SubledgerService } from '../ledgers/subledger.service';

type Actor = { id: string };
export interface BadDebtOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
}

export const writeOffRef = (n: number) => `WO-${String(n).padStart(4, '0')}`;
export const provisionRef = (n: number) => `PV-${String(n).padStart(4, '0')}`;

/** The accounts made on request when an organisation has none for bad debts. */
const DEFAULT_ACCOUNTS = {
  allowance: { codes: ['1210', '1215', '1290'], name: 'Allowance for Doubtful Debts', type: 'ASSET' as const, subtype: 'OTHER_CURRENT_ASSET', parent: '1100', description: 'Contra-asset: the part of receivables not expected to be collected (carries a credit balance).' },
  expense: { codes: ['6950', '6960', '6990'], name: 'Bad Debts', type: 'EXPENSE' as const, subtype: 'OPERATING_EXPENSE', parent: '6000', description: 'Receivables written off, and changes in the allowance for doubtful debts.' },
};

/**
 * Bad debts: the provision for doubtful debts worked out from the receivables ageing (AR-026), and
 * write-offs of what customers will not pay (AR-027). Every posting goes through the journal code
 * as a BAD_DEBT system journal in an open period. A write-off settles the invoice through an
 * allocation (a third kind of source, beside receipts and credit notes), so receivables, ageing,
 * statements and the control account all move together; reversing it reverses both.
 */
@Injectable()
export class BadDebtsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journals: JournalsService,
    private readonly subledger: SubledgerService,
  ) {}

  // ---------- reads ----------

  async overview(org: BadDebtOrg, asOfIn?: string) {
    const asOf = asOfIn ?? todayIso();
    const settings = await this.prisma.badDebtSettings.findUnique({ where: { orgId: org.id } });
    const rates = this.rates(settings?.rates);
    const [preview, carried, provisions, writeOffs, accounts] = await Promise.all([
      this.preview(org, asOf, rates),
      settings ? this.allowanceBalance(this.prisma, org.id, settings.allowanceAccountId, asOf) : Promise.resolve(new D(0)),
      this.prisma.badDebtProvision.findMany({ where: { orgId: org.id }, orderBy: { number: 'desc' }, take: 24 }),
      this.writeOffs(org),
      settings ? this.prisma.account.findMany({ where: { orgId: org.id, id: { in: [settings.expenseAccountId, settings.allowanceAccountId] } }, select: { id: true, code: true, name: true } }) : Promise.resolve([]),
    ]);
    const scale = minorUnits(org.functionalCurrency);
    const acc = (id: string) => accounts.find((a) => a.id === id) ?? null;
    return {
      asOf,
      currency: org.functionalCurrency,
      settings: settings
        ? { expenseAccount: acc(settings.expenseAccountId), allowanceAccount: acc(settings.allowanceAccountId), rates, updatedAt: settings.updatedAt.toISOString() }
        : null,
      suggestedAccounts: settings ? null : await this.suggestedAccounts(org.id),
      defaultRates: DEFAULT_PROVISION_RATES,
      labels: PROVISION_BUCKET_LABEL,
      preview: {
        ...preview.result,
        carried: carried.toFixed(scale),
        adjustment: provisionAdjustment(preview.result.total, carried.toFixed(), org.functionalCurrency),
      },
      invoices: preview.invoices,
      provisions: provisions.map((p) => ({
        id: p.id,
        reference: provisionRef(p.number),
        asOf: fromDbDate(p.asOf),
        required: p.required.toFixed(scale),
        carried: p.carried.toFixed(scale),
        adjustment: p.adjustment.toFixed(scale),
        journalEntryId: p.journalEntryId,
        memo: p.memo,
        result: p.result as unknown as ProvisionResult,
        createdAt: p.createdAt.toISOString(),
      })),
      writeOffs,
      can: this.can(org),
    };
  }

  // ---------- settings ----------

  async saveSettings(org: BadDebtOrg, actor: Actor, input: { expenseAccountId: string; allowanceAccountId: string; rates: Record<AgeingBucket, string> }) {
    this.assertManage(org);
    const issues = rateIssues(input.rates, (k) => PROVISION_BUCKET_LABEL[k as AgeingBucket] ?? k);
    if (issues.length) throw new DomainError('BAD_DEBT_RATES', issues[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    if (input.expenseAccountId === input.allowanceAccountId) throw new DomainError('BAD_DEBT_ACCOUNTS', 'Choose two different accounts: one for the expense and one for the allowance');
    const [o, accounts] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { arAccountId: true, apAccountId: true } }),
      this.prisma.account.findMany({ where: { orgId: org.id, id: { in: [input.expenseAccountId, input.allowanceAccountId] } } }),
    ]);
    const exp = accounts.find((a) => a.id === input.expenseAccountId);
    const all = accounts.find((a) => a.id === input.allowanceAccountId);
    if (!exp || !all) throw new DomainError('BAD_DEBT_ACCOUNTS', 'Account not found');
    if (exp.type !== 'EXPENSE') throw new DomainError('BAD_DEBT_ACCOUNTS', `${exp.code} ${exp.name} is not an expense account`);
    if (all.type !== 'ASSET') throw new DomainError('BAD_DEBT_ACCOUNTS', `${all.code} ${all.name} is not an asset account; the allowance is a contra-asset beside receivables`);
    if ([o.arAccountId, o.apAccountId].includes(all.id)) throw new DomainError('BAD_DEBT_ACCOUNTS', 'The allowance needs its own account, not the receivables control account');
    for (const a of [exp, all]) if (!a.isPostable || !a.isActive) throw new DomainError('BAD_DEBT_ACCOUNTS', `${a.code} ${a.name} does not take postings`);
    const rates = Object.fromEntries(AGEING_BUCKETS.map((b) => [b, new D(input.rates[b]).toFixed()]));
    await this.prisma.$transaction(async (tx) => {
      await tx.badDebtSettings.upsert({
        where: { orgId: org.id },
        create: { orgId: org.id, expenseAccountId: exp.id, allowanceAccountId: all.id, rates, updatedById: actor.id },
        update: { expenseAccountId: exp.id, allowanceAccountId: all.id, rates, updatedById: actor.id },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'bad_debts.settings_saved', entityType: 'organization', entityId: org.id, data: { expenseAccount: exp.code, allowanceAccount: all.code, rates } });
    });
    return this.overview(org);
  }

  /** Make the Bad Debts expense and the Allowance for Doubtful Debts accounts (where missing) and use them. */
  async createDefaultAccounts(org: BadDebtOrg, actor: Actor) {
    this.assertManage(org);
    const ids = await this.prisma.$transaction(async (tx) => {
      const out: Record<'allowance' | 'expense', string> = { allowance: '', expense: '' };
      for (const key of ['allowance', 'expense'] as const) {
        const d = DEFAULT_ACCOUNTS[key];
        const same = await tx.account.findFirst({ where: { orgId: org.id, name: d.name, type: d.type, isPostable: true, isActive: true } });
        if (same) {
          out[key] = same.id;
          continue;
        }
        const taken = new Set((await tx.account.findMany({ where: { orgId: org.id, code: { in: d.codes } }, select: { code: true } })).map((a) => a.code));
        const code = d.codes.find((c) => !taken.has(c));
        if (!code) throw new DomainError('BAD_DEBT_ACCOUNTS', `Codes ${d.codes.join(', ')} are all taken. Add a "${d.name}" account in the chart of accounts and choose it here.`);
        const parent = await tx.account.findFirst({ where: { orgId: org.id, code: d.parent, type: d.type, isPostable: false } });
        const a = await tx.account.create({ data: { orgId: org.id, code, name: d.name, type: d.type, subtype: d.subtype, description: d.description, parentId: parent?.id ?? null } });
        await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'account.created', entityType: 'account', entityId: a.id, data: { code, name: d.name, type: d.type, subtype: d.subtype, by: 'bad_debts' } });
        out[key] = a.id;
      }
      return out;
    });
    const existing = await this.prisma.badDebtSettings.findUnique({ where: { orgId: org.id } });
    return this.saveSettings(org, actor, { expenseAccountId: ids.expense, allowanceAccountId: ids.allowance, rates: this.rates(existing?.rates) });
  }

  // ---------- provisions ----------

  /** Work out the allowance as of `asOf` and post the difference from what the books carry. */
  async provide(org: BadDebtOrg, actor: Actor, input: { asOf: string; memo?: string | null }) {
    this.assertManage(org);
    const settings = await this.requireSettings(org.id);
    const rates = this.rates(settings.rates);
    const id = await this.prisma.$transaction(async (tx) => {
      // One provision run at a time per organisation.
      await tx.$queryRaw`SELECT org_id FROM bad_debt_settings WHERE org_id = ${org.id}::uuid FOR UPDATE`;
      const { result } = await this.preview(org, input.asOf, rates, tx);
      const carried = await this.allowanceBalance(tx, org.id, settings.allowanceAccountId, input.asOf);
      if (carried.isNegative()) {
        throw new DomainError('BAD_DEBT_ALLOWANCE', `The allowance account has a debit balance (${carried.negated().toFixed(minorUnits(org.functionalCurrency))}) as of ${input.asOf}. Check the postings to it before providing.`);
      }
      const adjustment = dec(provisionAdjustment(result.total, carried.toFixed(), org.functionalCurrency));
      const [{ value: number }] = await tx.$queryRaw<{ value: number }[]>`
        INSERT INTO org_counters (org_id, key, value) VALUES (${org.id}::uuid, 'bad_debt_provision', 1)
        ON CONFLICT (org_id, key) DO UPDATE SET value = org_counters.value + 1 RETURNING value`;
      let journalEntryId: string | null = null;
      if (!adjustment.isZero()) {
        const amount = adjustment.abs().toFixed();
        const up = adjustment.isPositive();
        const memo = `${up ? 'Increase' : 'Release of'} the allowance for doubtful debts to ${result.total} ${org.functionalCurrency} as of ${input.asOf}`;
        const je = await this.journals.postSystemEntry(tx, org, actor, {
          date: input.asOf,
          source: 'BAD_DEBT',
          reference: provisionRef(number),
          memo: input.memo ? `${memo}: ${input.memo}` : memo,
          lines: [
            { accountId: up ? settings.expenseAccountId : settings.allowanceAccountId, debit: amount, description: up ? 'Provision for doubtful debts' : 'Allowance released' },
            { accountId: up ? settings.allowanceAccountId : settings.expenseAccountId, credit: amount, description: up ? 'Allowance for doubtful debts' : 'Provision for doubtful debts written back' },
          ],
        });
        journalEntryId = je.id;
      }
      const p = await tx.badDebtProvision.create({
        data: {
          orgId: org.id,
          number,
          asOf: toDbDate(input.asOf),
          rates,
          result: result as unknown as Prisma.InputJsonValue,
          required: result.total,
          carried: carried.toFixed(),
          adjustment: adjustment.toFixed(),
          journalEntryId,
          memo: input.memo?.trim() || null,
          createdById: actor.id,
        },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'bad_debts.provided', entityType: 'bad_debt_provision', entityId: p.id, data: { reference: provisionRef(number), asOf: input.asOf, required: result.total, carried: carried.toFixed(), adjustment: adjustment.toFixed(), journalEntryId } });
      return p.id;
    });
    const p = await this.prisma.badDebtProvision.findUniqueOrThrow({ where: { id } });
    const scale = minorUnits(org.functionalCurrency);
    return { id, reference: provisionRef(p.number), asOf: input.asOf, required: p.required.toFixed(scale), carried: p.carried.toFixed(scale), adjustment: p.adjustment.toFixed(scale), journalEntryId: p.journalEntryId };
  }

  // ---------- specific provisions ----------

  async markDoubtful(org: BadDebtOrg, actor: Actor, documentId: string, input: { percent: string; reason: string }) {
    if (!hasPermission(org.role, 'sales.manage')) throw new ForbiddenException({ error: 'FORBIDDEN', message: `Your role (${org.role}) does not have sales.manage` });
    const issues = rateIssues({ percent: input.percent }, () => 'Percentage');
    if (issues.length || dec(input.percent).isZero()) throw new DomainError('BAD_DEBT_RATES', issues[0] ?? 'Percentage: enter more than 0');
    const doc = await this.prisma.document.findFirst({ where: { id: documentId, orgId: org.id }, select: { id: true, kind: true, status: true, number: true } });
    if (!doc || doc.kind !== 'INVOICE') throw new NotFoundException({ error: 'NOT_FOUND', message: 'Invoice not found' });
    if (doc.status !== 'POSTED') throw new DomainError('NOT_POSTED', 'Only a posted invoice can be marked doubtful', HttpStatus.CONFLICT);
    await this.prisma.$transaction(async (tx) => {
      await tx.doubtfulInvoice.upsert({
        where: { documentId },
        create: { orgId: org.id, documentId, percent: input.percent, reason: input.reason.trim(), createdById: actor.id },
        update: { percent: input.percent, reason: input.reason.trim() },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'bad_debts.marked_doubtful', entityType: 'document', entityId: documentId, data: { number: doc.number, percent: input.percent, reason: input.reason.trim() } });
    });
    return { documentId, percent: new D(input.percent).toFixed(), reason: input.reason.trim() };
  }

  async clearDoubtful(org: BadDebtOrg, actor: Actor, documentId: string) {
    if (!hasPermission(org.role, 'sales.manage')) throw new ForbiddenException({ error: 'FORBIDDEN', message: `Your role (${org.role}) does not have sales.manage` });
    await this.prisma.$transaction(async (tx) => {
      const d = await tx.doubtfulInvoice.findFirst({ where: { documentId, orgId: org.id } });
      if (!d) throw new NotFoundException({ error: 'NOT_FOUND', message: 'This invoice is not marked doubtful' });
      await tx.doubtfulInvoice.delete({ where: { id: d.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'bad_debts.doubtful_cleared', entityType: 'document', entityId: documentId, data: { percent: d.percent.toFixed() } });
    });
  }

  // ---------- write-offs ----------

  /**
   * Write off `amount` of a posted invoice on `date`: a BAD_DEBT journal at the invoice's own rate
   * (Dr the bad-debt expense, or the allowance when it was provided for; Cr receivables) and an
   * allocation that settles that much of the invoice.
   */
  async writeOff(org: BadDebtOrg, actor: Actor, input: { documentId: string; date: string; amount: string; against: 'EXPENSE' | 'ALLOWANCE'; reason: string }) {
    this.assertManage(org);
    const settings = await this.requireSettings(org.id);
    const id = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM documents WHERE id = ${input.documentId}::uuid AND org_id = ${org.id}::uuid FOR UPDATE`;
      const doc = await tx.document.findFirst({ where: { id: input.documentId, orgId: org.id }, include: { contact: { select: { name: true } } } });
      if (!doc || doc.kind !== 'INVOICE') throw new NotFoundException({ error: 'NOT_FOUND', message: 'Invoice not found' });
      if (doc.status !== 'POSTED') throw new DomainError('NOT_POSTED', 'Only a posted invoice can be written off', HttpStatus.CONFLICT);
      if (input.date < fromDbDate(doc.issueDate)) throw new DomainError('INVALID_DATE', 'The write-off cannot be dated before the invoice');
      const used = await tx.allocation.aggregate({ where: { targetId: doc.id, removedOn: null }, _sum: { amount: true } });
      const open = new D(doc.total.toFixed()).minus((used._sum.amount ?? 0).toString());
      const issues = writeOffIssues(input.amount, open.toFixed(), doc.currency);
      if (issues.length) throw new DomainError('WRITE_OFF_INVALID', issues[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { issues });
      const o = await tx.organization.findUniqueOrThrow({ where: { id: org.id }, select: { arAccountId: true } });
      if (!o.arAccountId) throw new DomainError('NO_AR_ACCOUNT', 'Set the receivables control account first');
      const foreign = doc.currency !== org.functionalCurrency;
      const rate = doc.exchangeRate.toFixed();
      const amount = dec(input.amount).toFixed();
      const functional = foreign ? toFunctional(dec(amount), rate, org.functionalCurrency) : dec(amount);
      if (input.against === 'ALLOWANCE') {
        // The allowance is a credit balance; charging more than it holds would turn it into a debit.
        await tx.$queryRaw`SELECT org_id FROM bad_debt_settings WHERE org_id = ${org.id}::uuid FOR UPDATE`;
        const held = await this.allowanceBalance(tx, org.id, settings.allowanceAccountId, input.date);
        if (functional.gt(held)) {
          throw new DomainError('ALLOWANCE_SHORT', `The allowance holds ${held.toFixed(2)} ${org.functionalCurrency} on ${input.date}, less than this write-off. Charge it to the bad-debt expense, or write off the provided part against the allowance and the rest against the expense.`, HttpStatus.CONFLICT);
        }
      }
      const [{ value: number }] = await tx.$queryRaw<{ value: number }[]>`
        INSERT INTO org_counters (org_id, key, value) VALUES (${org.id}::uuid, 'bad_debt_write_off', 1)
        ON CONFLICT (org_id, key) DO UPDATE SET value = org_counters.value + 1 RETURNING value`;
      const debitAccount = input.against === 'ALLOWANCE' ? settings.allowanceAccountId : settings.expenseAccountId;
      const fx = foreign ? { currency: doc.currency, exchangeRate: rate } : {};
      const je = await this.journals.postSystemEntry(tx, org, actor, {
        date: input.date,
        source: 'BAD_DEBT',
        reference: writeOffRef(number),
        memo: `${doc.number} written off (${doc.contact.name}): ${input.reason.trim()}`,
        lines: [
          { accountId: debitAccount, debit: amount, description: input.against === 'ALLOWANCE' ? `${doc.number} charged to the allowance` : `Bad debt: ${doc.number}`, ...fx },
          { accountId: o.arAccountId, credit: amount, description: `${doc.number} written off`, ...fx },
        ],
      });
      const w = await tx.badDebtWriteOff.create({
        data: {
          orgId: org.id,
          number,
          documentId: doc.id,
          contactId: doc.contactId,
          date: toDbDate(input.date),
          currency: doc.currency,
          amount,
          exchangeRate: rate,
          functionalAmount: functional.toFixed(),
          accountId: debitAccount,
          reason: input.reason.trim(),
          journalEntryId: je.id,
          createdById: actor.id,
        },
      });
      await tx.allocation.create({ data: { orgId: org.id, targetId: doc.id, writeOffId: w.id, amount, date: toDbDate(input.date), createdById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'bad_debts.written_off', entityType: 'bad_debt_write_off', entityId: w.id, data: { reference: writeOffRef(number), invoice: doc.number, amount, currency: doc.currency, functionalAmount: functional.toFixed(), against: input.against, journalEntryId: je.id } });
      return w.id;
    });
    return (await this.writeOffs(org, id))[0]!;
  }

  /** Undo a write-off (the customer paid after all, or it was a mistake): reverse its journal and its allocation on `date`. */
  async reverseWriteOff(org: BadDebtOrg, actor: Actor, id: string, input: { date: string; reason: string }) {
    this.assertManage(org);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM bad_debt_write_offs WHERE id = ${id}::uuid AND org_id = ${org.id}::uuid FOR UPDATE`;
      const w = await tx.badDebtWriteOff.findFirst({ where: { id, orgId: org.id }, include: { allocations: { where: { removedOn: null } } } });
      if (!w) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Write-off not found' });
      if (w.status === 'REVERSED') throw new DomainError('WRITE_OFF_REVERSED', 'This write-off was already reversed', HttpStatus.CONFLICT);
      if (input.date < fromDbDate(w.date)) throw new DomainError('INVALID_DATE', 'The reversal cannot be dated before the write-off');
      const rev = await this.journals.reverseSystemEntry(tx, org, actor, w.journalEntryId, { date: input.date, memo: `${writeOffRef(w.number)} reversed: ${input.reason.trim()}` });
      for (const a of w.allocations) await tx.allocation.update({ where: { id: a.id }, data: { removedOn: toDbDate(input.date), removedById: actor.id } });
      await tx.badDebtWriteOff.update({ where: { id }, data: { status: 'REVERSED', reversedOn: toDbDate(input.date), reversalReason: input.reason.trim(), reversalJournalEntryId: rev.id, reversedById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'bad_debts.write_off_reversed', entityType: 'bad_debt_write_off', entityId: id, data: { reference: writeOffRef(w.number), date: input.date, reason: input.reason.trim(), reversalJournalEntryId: rev.id } });
    });
    return (await this.writeOffs(org, id))[0]!;
  }

  // ---------- helpers ----------

  private async writeOffs(org: BadDebtOrg, id?: string) {
    const rows = await this.prisma.badDebtWriteOff.findMany({ where: { orgId: org.id, ...(id ? { id } : {}) }, orderBy: { number: 'desc' }, take: 200 });
    const [docs, contacts, accounts] = await Promise.all([
      this.prisma.document.findMany({ where: { orgId: org.id, id: { in: [...new Set(rows.map((r) => r.documentId))] } }, select: { id: true, number: true } }),
      this.prisma.contact.findMany({ where: { orgId: org.id, id: { in: [...new Set(rows.map((r) => r.contactId))] } }, select: { id: true, name: true } }),
      this.prisma.account.findMany({ where: { orgId: org.id, id: { in: [...new Set(rows.map((r) => r.accountId))] } }, select: { id: true, code: true, name: true } }),
    ]);
    const fs = minorUnits(org.functionalCurrency);
    return rows.map((w) => ({
      id: w.id,
      reference: writeOffRef(w.number),
      invoice: { id: w.documentId, number: docs.find((d) => d.id === w.documentId)?.number ?? null },
      contact: { id: w.contactId, name: contacts.find((c) => c.id === w.contactId)?.name ?? '' },
      date: fromDbDate(w.date),
      currency: w.currency,
      amount: w.amount.toFixed(minorUnits(w.currency)),
      functionalAmount: w.functionalAmount.toFixed(fs),
      account: accounts.find((a) => a.id === w.accountId) ?? null,
      reason: w.reason,
      status: w.status,
      journalEntryId: w.journalEntryId,
      reversedOn: w.reversedOn ? fromDbDate(w.reversedOn) : null,
      reversalReason: w.reversalReason,
      reversalJournalEntryId: w.reversalJournalEntryId,
    }));
  }

  /** The matrix as of `asOf`, and the open invoices behind it (with any specific percentage). */
  private async preview(org: BadDebtOrg, asOf: string, rates: Record<AgeingBucket, string>, db: Tx | PrismaService = this.prisma) {
    const items = (await this.subledger.openItems(db, org.id, 'SALES', asOf)).filter((i) => i.type === 'charge');
    const doubtful = await db.doubtfulInvoice.findMany({ where: { orgId: org.id, documentId: { in: items.map((i) => i.id) } } });
    const byDoc = new Map(doubtful.map((d) => [d.documentId, d]));
    const scale = minorUnits(org.functionalCurrency);
    const rows = items.map((i) => {
      const bucket = ageingBucket(i.dueDate!, asOf);
      const d = byDoc.get(i.id);
      const pct = d ? d.percent.toFixed() : rates[bucket];
      return {
        id: i.id,
        number: i.number,
        contactId: i.contactId,
        contactName: i.contactName,
        date: i.date,
        dueDate: i.dueDate,
        daysOverdue: Math.max(0, Math.round((Date.parse(asOf) - Date.parse(i.dueDate!)) / 86_400_000)),
        bucket,
        currency: i.currency,
        foreignOpen: i.foreignOpen.toFixed(minorUnits(i.currency)),
        open: i.open.toFixed(scale),
        doubtful: d ? { percent: d.percent.toFixed(), reason: d.reason } : null,
        provision: i.open.times(pct).div(100).toDecimalPlaces(scale, D.ROUND_HALF_EVEN).toFixed(scale),
      };
    });
    const result = provisionMatrix(rows.map((r) => ({ bucket: r.bucket, open: r.open, specificPercent: r.doubtful?.percent ?? null })), rates, org.functionalCurrency);
    return { result, invoices: rows.sort((a, b) => b.daysOverdue - a.daysOverdue || a.number.localeCompare(b.number)) };
  }

  /** The allowance as the books carry it on `asOf` (credit balance, posted entries). */
  private async allowanceBalance(db: Tx | PrismaService, orgId: string, accountId: string, asOf: string) {
    const agg = await db.journalLine.aggregate({ where: { orgId, accountId, entry: { status: 'POSTED', date: { lte: toDbDate(asOf) } } }, _sum: { functionalDebit: true, functionalCredit: true } });
    return new D((agg._sum.functionalCredit ?? 0).toString()).minus((agg._sum.functionalDebit ?? 0).toString());
  }

  private async suggestedAccounts(orgId: string) {
    const [exp, all] = await Promise.all([
      this.prisma.account.findFirst({ where: { orgId, type: 'EXPENSE', isPostable: true, isActive: true, name: { contains: 'bad debt', mode: 'insensitive' } }, select: { id: true, code: true, name: true } }),
      this.prisma.account.findFirst({ where: { orgId, type: 'ASSET', isPostable: true, isActive: true, name: { contains: 'doubtful', mode: 'insensitive' } }, select: { id: true, code: true, name: true } }),
    ]);
    return { expenseAccount: exp, allowanceAccount: all };
  }

  private async requireSettings(orgId: string) {
    const s = await this.prisma.badDebtSettings.findUnique({ where: { orgId } });
    if (!s) throw new DomainError('BAD_DEBT_SETUP', 'Choose the bad-debt expense and allowance accounts first (Sales → Bad debts → Settings)', HttpStatus.CONFLICT);
    return s;
  }

  private rates(raw: unknown): Record<AgeingBucket, string> {
    const r = (raw ?? {}) as Partial<Record<AgeingBucket, string>>;
    return Object.fromEntries(AGEING_BUCKETS.map((b) => [b, r[b] ?? DEFAULT_PROVISION_RATES[b]])) as Record<AgeingBucket, string>;
  }

  private can(org: BadDebtOrg) {
    return { manage: hasPermission(org.role, 'sales.manage') && hasPermission(org.role, 'journals.post'), markDoubtful: hasPermission(org.role, 'sales.manage') };
  }

  private assertManage(org: BadDebtOrg) {
    if (!this.can(org).manage) throw new ForbiddenException({ error: 'FORBIDDEN', message: `Bad-debt postings need sales.manage and journals.post, which your role (${org.role}) does not have` });
  }
}
