import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D, minorUnits, naturalBalance, reconcileAccount, reconItemIssues, reconState, type ReconItemInput } from '@talk2tax/accounting-engine';
import { isDuplicateKeyError } from '@talk2tax/document-db';
import { AuditService } from '../audit/audit.service';
import { OrgContext } from '../auth/decorators';
import { toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { AccountReconciliationDoc, AccountReconEventKind, accountReconciliations } from '../db/collections/account-reconciliations';
import { AccountDoc, accounts } from '../db/collections/chart';
import { users } from '../db/collections/identity';
import { organizations } from '../db/collections/tenancy';
import { lineSums, postedBetween } from '../db/ledger-queries';
import { SubledgerService } from '../ledgers/subledger.service';

type Dec = InstanceType<typeof D>;

const BANK_SUBTYPES = new Set(['BANK', 'CASH']);
const RECONCILED_TYPES = ['ASSET', 'LIABILITY'] as const;

export interface ReconInput {
  asOf: string;
  items: ReconItemInput[];
  notes?: string | null;
}

/**
 * Balance sheet account reconciliations (GL-032) with the receivable and payable control
 * accounts checked against their subsidiary ledgers (GL-023). MongoDB only. reports.read sees
 * them; close.manage prepares, reviews and reopens them, and the reviewer is never the preparer.
 */
@Injectable()
export class AccountReconciliationsService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly subledger: SubledgerService,
  ) {}

  private scale(org: OrgContext) {
    return minorUnits(org.functionalCurrency);
  }

  /** Natural balances at the date of the balance sheet accounts, by account id. */
  private async balances(org: OrgContext, asOf: string, accountId?: string) {
    const sums = await lineSums(this.store, org.id, {
      entry: postedBetween(null, toDbDate(asOf)),
      ...(accountId ? { line: { accountId } } : {}),
      by: { accountId: 'lines.accountId' },
    });
    return new Map(sums.map((s) => [s.key.accountId as string, { debit: s.debit, credit: s.credit }]));
  }

  /** The receivable and payable control accounts and their subsidiary ledger balances at the date. */
  private async controls(org: OrgContext, asOf: string) {
    const o = await this.store.collection(organizations).findById(org.id);
    const out = new Map<string, { ledger: 'SALES' | 'PURCHASES'; label: string; balance: Dec }>();
    for (const [ledger, accountId, label] of [
      ['SALES', o?.arAccountId, 'Open items in the receivables ledger'],
      ['PURCHASES', o?.apAccountId, 'Open items in the payables ledger'],
    ] as const) {
      if (!accountId) continue;
      const ageing = await this.subledger.ageing({ id: org.id, functionalCurrency: org.functionalCurrency, arAccountId: o!.arAccountId, apAccountId: o!.apAccountId }, ledger, asOf);
      out.set(accountId, { ledger, label, balance: new D(ageing.reconciliation.subledgerBalance) });
    }
    return out;
  }

  private balanceOf(a: AccountDoc, b: { debit: Dec; credit: Dec } | undefined) {
    return naturalBalance(a.type, b?.debit ?? new D(0), b?.credit ?? new D(0));
  }

  /** Every active balance sheet account with its balance and where its reconciliation stands. */
  async list(org: OrgContext, asOf: string) {
    const scale = this.scale(org);
    const [accts, balances, controls, recs] = await Promise.all([
      this.store.collection(accounts).find({ type: { $in: [...RECONCILED_TYPES] }, isPostable: true }, { sort: { code: 1 } }),
      this.balances(org, asOf),
      this.controls(org, asOf),
      this.store.collection(accountReconciliations).find({ asOf: toDbDate(asOf) }),
    ]);
    const byAccount = new Map(recs.map((r) => [r.accountId, r]));
    const names = await this.names(recs.flatMap((r) => [r.preparedById, r.reviewedById]));
    const rows = accts
      .filter((a) => a.isActive || balances.has(a.id) || byAccount.has(a.id))
      .map((a) => {
        const balance = this.balanceOf(a, balances.get(a.id)).toDecimalPlaces(scale);
        const rec = byAccount.get(a.id) ?? null;
        const control = controls.get(a.id);
        return {
          accountId: a.id,
          code: a.code,
          name: a.name,
          type: a.type,
          isBank: BANK_SUBTYPES.has(a.subtype ?? ''),
          ledgerBalance: balance.toFixed(scale),
          subledgerBalance: control ? control.balance.toFixed(scale) : null,
          subledgerDifference: control ? balance.minus(control.balance).toFixed(scale) : null,
          state: reconState(rec, balance),
          difference: rec ? new D(rec.difference).toFixed(scale) : null,
          preparedBy: rec?.preparedById ? (names.get(rec.preparedById) ?? null) : null,
          reviewedBy: rec?.reviewedById ? (names.get(rec.reviewedById) ?? null) : null,
        };
      });
    const counts = { NOT_STARTED: 0, DRAFT: 0, PREPARED: 0, REVIEWED: 0, CHANGED: 0 } as Record<string, number>;
    for (const r of rows) counts[r.state]! += 1;
    return { asOf, currency: org.functionalCurrency, accounts: rows, counts };
  }

  private async account(accountId: string) {
    const a = await this.store.collection(accounts).findById(accountId);
    if (!a) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Account not found' });
    if (!(RECONCILED_TYPES as readonly string[]).includes(a.type)) throw new DomainError('NOT_BALANCE_SHEET', `${a.code} ${a.name} is a ${a.type.toLowerCase()} account; only asset and liability accounts are reconciled`, HttpStatus.UNPROCESSABLE_ENTITY);
    return a;
  }

  private async current(org: OrgContext, a: AccountDoc, asOf: string) {
    const scale = this.scale(org);
    const [balances, controls] = await Promise.all([this.balances(org, asOf, a.id), this.controls(org, asOf)]);
    return { balance: this.balanceOf(a, balances.get(a.id)).toDecimalPlaces(scale), control: controls.get(a.id) ?? null };
  }

  private find(accountId: string, asOf: string) {
    return this.store.collection(accountReconciliations).findOne({ accountId, asOf: toDbDate(asOf) });
  }

  /** One account at one date: its balance, the saved work (if any) and suggested supporting items. */
  async get(org: OrgContext, accountId: string, asOf: string) {
    const a = await this.account(accountId);
    const [{ balance, control }, rec] = await Promise.all([this.current(org, a, asOf), this.find(accountId, asOf)]);
    return this.detail(org, a, asOf, balance, control, rec);
  }

  private async detail(org: OrgContext, a: AccountDoc, asOf: string, balance: Dec, control: { label: string; balance: Dec } | null, rec: AccountReconciliationDoc | null) {
    const scale = this.scale(org);
    const items = rec?.items ?? [];
    const sum = reconcileAccount(balance, items, scale);
    const names = await this.names(rec ? [rec.preparedById, rec.reviewedById, ...rec.events.map((e) => e.byId)] : []);
    const suggestions = [];
    if (control && !items.some((i) => i.description === control.label)) suggestions.push({ description: control.label, reference: `Ageing at ${asOf}`, amount: control.balance.toFixed(scale), kind: 'SUPPORT' as const });
    return {
      accountId: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      isBank: BANK_SUBTYPES.has(a.subtype ?? ''),
      asOf,
      currency: org.functionalCurrency,
      ledgerBalance: balance.toFixed(scale),
      savedLedgerBalance: rec ? new D(rec.ledgerBalance).toFixed(scale) : null,
      subledgerBalance: control ? control.balance.toFixed(scale) : null,
      state: reconState(rec, balance),
      id: rec?.id ?? null,
      status: rec?.status ?? null,
      notes: rec?.notes ?? null,
      items: items.map((i) => ({ ...i, amount: new D(i.amount).toFixed(scale) })),
      supported: sum.supported.toFixed(scale),
      reconciling: sum.reconciling.toFixed(scale),
      explained: sum.explained.toFixed(scale),
      difference: sum.difference.toFixed(scale),
      balanced: sum.balanced,
      suggestions,
      preparedBy: rec?.preparedById ? (names.get(rec.preparedById) ?? null) : null,
      preparedById: rec?.preparedById ?? null,
      preparedAt: rec?.preparedAt?.toISOString() ?? null,
      reviewedBy: rec?.reviewedById ? (names.get(rec.reviewedById) ?? null) : null,
      reviewedAt: rec?.reviewedAt?.toISOString() ?? null,
      history: (rec?.events ?? []).map((e) => ({ id: e.id, kind: e.kind, note: e.note, by: names.get(e.byId) ?? null, at: e.at.toISOString() })),
    };
  }

  private event(kind: AccountReconEventKind, byId: string, note: string | null = null) {
    return { id: randomUUID(), kind, note, byId, at: new Date() };
  }

  /** Saves the items as a draft. A prepared one goes back to draft; a reviewed one must be reopened first. */
  async save(org: OrgContext, actorId: string, accountId: string, input: ReconInput) {
    const a = await this.account(accountId);
    const scale = this.scale(org);
    const issues = reconItemIssues(input.items, scale);
    if (issues.length) throw new DomainError('RECON_INVALID', issues[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    const [{ balance, control }, before] = await Promise.all([this.current(org, a, input.asOf), this.find(accountId, input.asOf)]);
    if (before?.status === 'REVIEWED') throw new DomainError('RECON_REVIEWED', 'This reconciliation has been reviewed; reopen it to change it', HttpStatus.CONFLICT);
    const items = input.items.map((i) => ({ id: randomUUID(), description: i.description.trim(), reference: i.reference?.trim() || null, amount: new D(i.amount).toFixed(scale), kind: i.kind }));
    const sum = reconcileAccount(balance, items, scale);
    const now = new Date();
    const fields = {
      ledgerBalance: balance.toFixed(scale),
      subledgerBalance: control ? control.balance.toFixed(scale) : null,
      items,
      difference: sum.difference.toFixed(scale),
      notes: input.notes?.trim() || null,
      status: 'DRAFT' as const,
      preparedById: null,
      preparedAt: null,
      reviewedById: null,
      reviewedAt: null,
      updatedAt: now,
    };
    const col = this.store.collection(accountReconciliations);
    let id: string;
    if (before) {
      await col.updateOne({ id: before.id }, { $set: { ...fields, events: [...before.events, this.event('SAVED', actorId)] } });
      id = before.id;
    } else {
      try {
        id = (await col.insertOne({ orgId: org.id, accountId, asOf: toDbDate(input.asOf), ...fields, events: [this.event('SAVED', actorId)], createdById: actorId, createdAt: now })).id;
      } catch (e) {
        if (isDuplicateKeyError(e)) throw new DomainError('RECON_CONFLICT', 'Someone else just started this reconciliation; reload it', HttpStatus.CONFLICT);
        throw e;
      }
    }
    await this.log(org.id, actorId, 'account_reconciliation.saved', id, { accountId, asOf: input.asOf, items: items.length, ledgerBalance: fields.ledgerBalance, difference: fields.difference });
    return this.detail(org, a, input.asOf, balance, control, await col.findById(id));
  }

  private async existing(accountId: string, asOf: string) {
    const rec = await this.find(accountId, asOf);
    if (!rec) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Nothing has been saved for this account and date yet' });
    return rec;
  }

  /** The preparer signs off: the items must explain today's ledger balance exactly. */
  async prepare(org: OrgContext, actorId: string, accountId: string, asOf: string) {
    const a = await this.account(accountId);
    const scale = this.scale(org);
    const [{ balance, control }, rec] = await Promise.all([this.current(org, a, asOf), this.existing(accountId, asOf)]);
    if (rec.status !== 'DRAFT') throw new DomainError('RECON_NOT_DRAFT', rec.status === 'PREPARED' ? 'This reconciliation is already prepared' : 'This reconciliation has been reviewed; reopen it to change it', HttpStatus.CONFLICT);
    const sum = reconcileAccount(balance, rec.items, scale);
    if (!sum.balanced) throw new DomainError('RECON_NOT_BALANCED', `The items leave ${sum.difference.toFixed(scale)} of the ledger balance ${balance.toFixed(scale)} unexplained`, HttpStatus.UNPROCESSABLE_ENTITY, { difference: sum.difference.toFixed(scale) });
    const now = new Date();
    await this.store.collection(accountReconciliations).updateOne({ id: rec.id }, {
      $set: { status: 'PREPARED', ledgerBalance: balance.toFixed(scale), subledgerBalance: control ? control.balance.toFixed(scale) : null, difference: sum.difference.toFixed(scale), preparedById: actorId, preparedAt: now, updatedAt: now, events: [...rec.events, this.event('PREPARED', actorId)] },
    });
    await this.log(org.id, actorId, 'account_reconciliation.prepared', rec.id, { accountId, asOf, ledgerBalance: balance.toFixed(scale) });
    return this.detail(org, a, asOf, balance, control, await this.store.collection(accountReconciliations).findById(rec.id));
  }

  /** A second person reviews prepared work, as long as the ledger has not moved since. */
  async review(org: OrgContext, actorId: string, accountId: string, asOf: string, note: string | null) {
    const a = await this.account(accountId);
    const scale = this.scale(org);
    const [{ balance, control }, rec] = await Promise.all([this.current(org, a, asOf), this.existing(accountId, asOf)]);
    if (rec.status !== 'PREPARED') throw new DomainError('RECON_NOT_PREPARED', rec.status === 'DRAFT' ? 'The preparer signs off before it is reviewed' : 'This reconciliation is already reviewed', HttpStatus.CONFLICT);
    if (rec.preparedById === actorId) throw new DomainError('SAME_PERSON', 'Someone other than the preparer reviews a reconciliation', HttpStatus.FORBIDDEN);
    if (!new D(rec.ledgerBalance).equals(balance)) throw new DomainError('RECON_CHANGED', `The ledger balance moved from ${new D(rec.ledgerBalance).toFixed(scale)} to ${balance.toFixed(scale)} after it was prepared; the preparer updates it first`, HttpStatus.CONFLICT);
    const now = new Date();
    await this.store.collection(accountReconciliations).updateOne({ id: rec.id }, { $set: { status: 'REVIEWED', reviewedById: actorId, reviewedAt: now, updatedAt: now, events: [...rec.events, this.event('REVIEWED', actorId, note?.trim() || null)] } });
    await this.log(org.id, actorId, 'account_reconciliation.reviewed', rec.id, { accountId, asOf, ledgerBalance: balance.toFixed(scale) });
    return this.detail(org, a, asOf, balance, control, await this.store.collection(accountReconciliations).findById(rec.id));
  }

  /** Back to draft, with the reason kept in its history. */
  async reopen(org: OrgContext, actorId: string, accountId: string, asOf: string, reason: string) {
    const a = await this.account(accountId);
    const [{ balance, control }, rec] = await Promise.all([this.current(org, a, asOf), this.existing(accountId, asOf)]);
    if (rec.status === 'DRAFT') throw new DomainError('RECON_NOT_SIGNED', 'This reconciliation is already a draft', HttpStatus.CONFLICT);
    const now = new Date();
    await this.store.collection(accountReconciliations).updateOne({ id: rec.id }, {
      $set: { status: 'DRAFT', preparedById: null, preparedAt: null, reviewedById: null, reviewedAt: null, updatedAt: now, events: [...rec.events, this.event('REOPENED', actorId, reason.trim())] },
    });
    await this.log(org.id, actorId, 'account_reconciliation.reopened', rec.id, { accountId, asOf, from: rec.status, reason: reason.trim() });
    return this.detail(org, a, asOf, balance, control, await this.store.collection(accountReconciliations).findById(rec.id));
  }

  private async names(ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    const rows = unique.length ? await this.store.collection(users).find({ id: { $in: unique } }) : [];
    return new Map(rows.map((u) => [u.id, u.name]));
  }

  private log(orgId: string, actorId: string, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId, action, entityType: 'account_reconciliation', entityId, data }));
  }
}
