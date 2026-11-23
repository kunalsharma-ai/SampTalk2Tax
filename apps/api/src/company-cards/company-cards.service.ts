import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  CARD_FEED_TOKEN_PATTERN,
  type CardClaimLine,
  cardClaimMatches,
  cardFeedTokenPrefix,
  cardJournalLines,
  cardLimitStatus,
  type CardKind,
  D,
  type FeedCard,
  makeCardFeedToken,
  minorUnits,
  normaliseCardTransactions,
} from '@talk2tax/accounting-engine';
import { isDuplicateKeyError } from '@talk2tax/document-db';
import { hasPermission } from '@talk2tax/security';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { enterOrg, runAsSystem } from '../common/tenant-context';
import { accounts } from '../db/collections/chart';
import { cardPrograms, type CardProgramDoc, type CompanyCardDoc, type CompanyCardEvent, companyCards, cardTransactions, type CardTransactionDoc } from '../db/collections/company-cards';
import { expenseClaims } from '../db/collections/expenses';
import { users } from '../db/collections/identity';
import { contacts } from '../db/collections/sales';
import { memberships, organizations } from '../db/collections/tenancy';
import { holdLock } from '../db/locks';
import { JournalsService } from '../journals/journals.service';
import { RegionsService } from '../regions/regions.service';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const cardRef = (n: number) => `CARD-${String(n).padStart(4, '0')}`;
const KEEP_REJECTIONS = 50; // not money
const LIST_LIMIT = 500; // not money

export interface CardInput {
  programId: string;
  kind: CardKind;
  holderId: string;
  label: string;
  monthlyLimit: string | null;
  last4?: string | null;
  expires?: string | null;
  providerRef?: string | null;
  contactId?: string | null;
}

/**
 * Company cards (EXP-011 corporate cards, EXP-012 virtual cards), provider-agnostic.
 *
 * Finance (banking.manage) sets up card programmes (org.manage, which makes the provider's
 * token), adds corporate cards already in people's hands, asks for virtual cards (the provider
 * confirms them), and freezes, unfreezes or cancels cards and sets monthly limits. The provider
 * reads those controls and sends transactions with the programme's token. Cardholders explain
 * their own spending (account and note); finance (journals.post) posts settled spending to the
 * books, debit the expense and credit the programme's liability account, or excludes it with a
 * reason. Spending that an expense claim by the same person also asks to be paid back for is
 * shown next to the transaction. Full card numbers never reach Talk2Tax.
 */
@Injectable()
export class CompanyCardsService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journals: JournalsService,
    private readonly regions: RegionsService,
  ) {}

  // ------------------------------------------------------------------ overview

  /** Programmes, cards with this month's spending against their limits, and what is waiting. */
  async overview(org: OrgContext, user: AuthUser) {
    const finance = hasPermission(org.role, 'expenses.read');
    const [programs, cards] = await Promise.all([
      this.store.collection(cardPrograms).find({}, { sort: { createdAt: -1 } }),
      this.store.collection(companyCards).find(finance ? {} : { holderId: user.id }, { sort: { number: 1 } }),
    ]);
    const spent = await this.spentThisMonth(cards.map((c) => c.id));
    const names = await this.names([...cards.map((c) => c.holderId), ...programs.map((p) => p.createdById)]);
    const waiting = await this.store.collection(cardTransactions).find({ status: { $in: ['UNCODED', 'CODED'] }, ...(finance ? {} : { holderId: user.id }) });
    const accountIds = programs.map((p) => p.liabilityAccountId);
    const chart = accountIds.length ? await this.store.collection(accounts).find({ id: { $in: accountIds } }) : [];
    const canManage = hasPermission(org.role, 'banking.manage');
    const postable = await this.store.collection(accounts).find({ isPostable: true, isActive: true, type: { $in: ['EXPENSE', 'LIABILITY'] } }, { sort: { code: 1 } });
    const people = canManage ? await this.store.collection(memberships).find({}) : [];
    const peopleNames = await this.names(people.map((m) => m.userId));
    return {
      currency: org.functionalCurrency,
      /** Accounts spending can be explained against. */
      accounts: postable.filter((a) => a.type === 'EXPENSE').map((a) => ({ id: a.id, code: a.code, name: a.name })),
      /** For setting up a programme: liability accounts, credit card ones first. */
      liabilityAccounts: hasPermission(org.role, 'org.manage') ? postable.filter((a) => a.type === 'LIABILITY').sort((a, b) => Number(b.subtype === 'CREDIT_CARD') - Number(a.subtype === 'CREDIT_CARD')).map((a) => ({ id: a.id, code: a.code, name: a.name })) : [],  // not money
      /** For giving a card to someone. */
      members: people.map((m) => ({ id: m.userId, name: peopleNames.get(m.userId) ?? 'A member', role: m.role })).sort((a, b) => a.name.localeCompare(b.name)),
      canManage,
      canPost: hasPermission(org.role, 'journals.post') && finance,
      canSetUp: hasPermission(org.role, 'org.manage'),
      programs: finance
        ? programs.map((p) => {
            const a = chart.find((x) => x.id === p.liabilityAccountId);
            return this.programView(p, a ? `${a.code} ${a.name}` : 'Removed account', names);
          })
        : [],
      cards: cards.map((c) => this.cardView(c, programs.find((p) => p.id === c.programId), names, spent.get(c.id) ?? '0')),
      waiting: { uncoded: waiting.filter((t) => t.status === 'UNCODED').length, coded: waiting.filter((t) => t.status === 'CODED').length },
    };
  }

  // ------------------------------------------------------------------ programmes

  /** Sets up a card programme. The provider's token is shown once; only its hash is kept. */
  async createProgram(org: OrgContext, actor: AuthUser, input: { name: string; provider: string; liabilityAccountId: string }) {
    const a = await this.store.collection(accounts).findById(input.liabilityAccountId);
    if (!a || a.type !== 'LIABILITY' || !a.isPostable || !a.isActive) throw new DomainError('INVALID_ACCOUNT', 'Pay the cards through an active liability account, such as Credit Card Payable');
    const token = makeCardFeedToken((n) => randomBytes(n));
    const p = await this.store.collection(cardPrograms).insertOne({
      name: input.name.trim(),
      provider: input.provider.trim(),
      liabilityAccountId: a.id,
      currency: org.functionalCurrency,
      status: 'ACTIVE',
      prefix: cardFeedTokenPrefix(token),
      tokenHash: hash(token),
      createdById: actor.id,
      createdAt: new Date(),
      revokedAt: null,
      revokedById: null,
      lastDeliveryAt: null,
      deliveryCount: 0,
      transactionsReceived: 0,
    });
    // The audit trail names the programme by its token prefix; the secret is never recorded.
    await this.log(org.id, actor.id, 'card_program.created', 'card_program', p.id, { name: p.name, provider: p.provider, liabilityAccountId: p.liabilityAccountId, prefix: p.prefix });
    return { ...this.programView(p, `${a.code} ${a.name}`, await this.names([actor.id])), token };
  }

  /** A new token for the provider; the old one stops working at once. */
  async rotateToken(org: OrgContext, actor: AuthUser, id: string) {
    const p = await this.program(id);
    if (p.status === 'REVOKED') throw new DomainError('PROGRAM_DISCONNECTED', 'This card programme is disconnected', HttpStatus.CONFLICT);
    const token = makeCardFeedToken((n) => randomBytes(n));
    const r = await this.store.collection(cardPrograms).updateOne({ id: p.id, tokenHash: p.tokenHash, status: 'ACTIVE' }, { $set: { tokenHash: hash(token), prefix: cardFeedTokenPrefix(token) } });
    if (!r.matched) throw new DomainError('PROGRAM_STATE', 'Someone changed this programme at the same moment; refresh and try again', HttpStatus.CONFLICT);
    await this.log(org.id, actor.id, 'card_program.token_rotated', 'card_program', p.id, { previousPrefix: p.prefix, prefix: cardFeedTokenPrefix(token) });
    return { id: p.id, prefix: cardFeedTokenPrefix(token), token };
  }

  /** Disconnects the provider for good: its token stops working. Cards and transactions stay. */
  async disconnect(org: OrgContext, actor: AuthUser, id: string) {
    const p = await this.program(id);
    const r = await this.store.collection(cardPrograms).updateOne({ id: p.id, status: 'ACTIVE' }, { $set: { status: 'REVOKED', revokedAt: new Date(), revokedById: actor.id } });
    if (!r.matched) throw new DomainError('PROGRAM_DISCONNECTED', 'This card programme is already disconnected', HttpStatus.CONFLICT);
    await this.log(org.id, actor.id, 'card_program.disconnected', 'card_program', p.id, { prefix: p.prefix });
    return this.overview(org, actor);
  }

  // ------------------------------------------------------------------ cards

  /** Adds a corporate card already issued (its last four digits), or asks for a virtual card. */
  async createCard(org: OrgContext, actor: AuthUser, input: CardInput) {
    const p = await this.program(input.programId);
    if (p.status !== 'ACTIVE') throw new DomainError('PROGRAM_DISCONNECTED', 'This card programme is disconnected', HttpStatus.CONFLICT);
    const member = await this.store.collection(memberships).findOne({ userId: input.holderId });
    if (!member) throw new DomainError('INVALID_HOLDER', 'Give the card to a member of this organisation');
    if (input.contactId) {
      const c = await this.store.collection(contacts).findById(input.contactId);
      if (!c) throw new DomainError('INVALID_CONTACT', 'Choose a supplier from your contacts');
    }
    const limit = this.limit(input.monthlyLimit, p.currency);
    const corporate = input.kind === 'CORPORATE';
    if (corporate && !input.last4) throw new DomainError('LAST4_REQUIRED', 'Enter the last four digits of the card');
    if (!corporate && (input.last4 || input.expires)) throw new DomainError('VIRTUAL_FROM_PROVIDER', 'A virtual card gets its digits and expiry from the provider when it is issued');
    if (input.expires && input.expires < todayIso().slice(0, 7)) throw new DomainError('CARD_EXPIRED', 'This card has already expired');
    const number = await this.store.nextTenantSequence('company_card');
    let card: CompanyCardDoc;
    try {
      card = await this.store.collection(companyCards).insertOne({
        programId: p.id,
        number,
        kind: input.kind,
        holderId: input.holderId,
        label: input.label.trim(),
        monthlyLimit: limit,
        status: corporate ? 'ACTIVE' : 'REQUESTED',
        last4: corporate ? input.last4! : null,
        providerRef: corporate ? input.providerRef?.trim() || null : null,
        expires: corporate ? (input.expires ?? null) : null,
        contactId: input.contactId ?? null,
        createdById: actor.id,
        createdAt: new Date(),
        history: [{ at: new Date(), byId: actor.id, action: corporate ? 'ISSUED' : 'REQUESTED', note: null }],
      });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new DomainError('CARD_EXISTS', 'Another card in this programme has that provider reference', HttpStatus.CONFLICT);
      throw e;
    }
    await this.log(org.id, actor.id, corporate ? 'company_card.added' : 'company_card.requested', 'company_card', card.id, { reference: cardRef(number), kind: card.kind, holderId: card.holderId, monthlyLimit: limit, last4: card.last4 });
    return this.cardView(card, p, await this.names([card.holderId]), '0');
  }

  /** Freeze, unfreeze or cancel a card, or change its monthly limit. The provider reads the new controls. */
  async control(org: OrgContext, actor: AuthUser, id: string, input: { action: 'FREEZE' | 'UNFREEZE' | 'CANCEL' | 'LIMIT'; monthlyLimit?: string | null; note?: string | null }) {
    const card = await this.card(id);
    const p = await this.program(card.programId);
    if (card.status === 'CANCELLED') throw new DomainError('CARD_CANCELLED', 'This card is cancelled', HttpStatus.CONFLICT);
    const set: Partial<CompanyCardDoc> = {};
    let action: CompanyCardEvent['action'];
    if (input.action === 'FREEZE') {
      if (card.status !== 'ACTIVE') throw new DomainError('CARD_STATE', card.status === 'FROZEN' ? 'This card is already frozen' : 'Only an issued card can be frozen', HttpStatus.CONFLICT);
      set.status = 'FROZEN';
      action = 'FROZEN';
    } else if (input.action === 'UNFREEZE') {
      if (card.status !== 'FROZEN') throw new DomainError('CARD_STATE', 'This card is not frozen', HttpStatus.CONFLICT);
      set.status = 'ACTIVE';
      action = 'UNFROZEN';
    } else if (input.action === 'CANCEL') {
      set.status = 'CANCELLED';
      action = 'CANCELLED';
    } else {
      set.monthlyLimit = this.limit(input.monthlyLimit ?? null, p.currency);
      action = 'LIMIT_CHANGED';
    }
    const event: CompanyCardEvent = { at: new Date(), byId: actor.id, action, note: input.note?.trim() || (action === 'LIMIT_CHANGED' ? `Limit ${set.monthlyLimit ?? 'removed'}` : null) };
    const r = await this.store.collection(companyCards).updateOne({ id: card.id, status: card.status }, { $set: set, $push: { history: event } } as never);
    if (!r.matched) throw new DomainError('CARD_STATE', 'Someone changed this card at the same moment; refresh and try again', HttpStatus.CONFLICT);
    await this.log(org.id, actor.id, `company_card.${action.toLowerCase()}`, 'company_card', card.id, { reference: cardRef(card.number), from: card.status, ...set, note: event.note });
    const after = await this.card(id);
    return this.cardView(after, p, await this.names([after.holderId]), (await this.spentThisMonth([after.id])).get(after.id) ?? '0');
  }

  // ------------------------------------------------------------------ transactions

  /** Card transactions, newest first. Finance sees every card; a cardholder sees their own. */
  async transactions(org: OrgContext, user: AuthUser, filter: { cardId?: string; status?: CardTransactionDoc['status'] }) {
    const finance = hasPermission(org.role, 'expenses.read');
    const list = await this.store.collection(cardTransactions).find(
      { ...(finance ? {} : { holderId: user.id }), ...(filter.cardId ? { cardId: filter.cardId } : {}), ...(filter.status ? { status: filter.status } : {}) },
      { sort: { date: -1, receivedAt: -1 }, limit: LIST_LIMIT },
    );
    const cards = await this.store.collection(companyCards).find({ id: { $in: [...new Set(list.map((t) => t.cardId))] } });
    const accountIds = [...new Set(list.flatMap((t) => (t.accountId ? [t.accountId] : [])))];
    const chart = accountIds.length ? await this.store.collection(accounts).find({ id: { $in: accountIds } }) : [];
    const names = await this.names([...list.map((t) => t.holderId), ...list.flatMap((t) => [t.codedById, t.postedById, t.excludedById].filter((x): x is string => !!x))]);
    const claimLines = await this.claimLines([...new Set(list.map((t) => t.holderId))]);
    const entries = list.flatMap((t) => (t.journalEntryId ? [t.journalEntryId] : []));
    const numbers = new Map<string, number | null>();
    if (entries.length) for (const e of await this.prisma.journalEntry.findMany({ where: { id: { in: entries } }, select: { id: true, entryNumber: true } })) numbers.set(e.id, e.entryNumber);
    return list.map((t) => {
      const c = cards.find((x) => x.id === t.cardId);
      const a = t.accountId ? chart.find((x) => x.id === t.accountId) : undefined;
      return {
        ...this.txnView(t, names),
        card: c ? { id: c.id, reference: cardRef(c.number), label: c.label, last4: c.last4, kind: c.kind } : null,
        account: a ? { id: a.id, code: a.code, name: a.name } : null,
        journalEntryNumber: t.journalEntryId ? (numbers.get(t.journalEntryId) ?? null) : null,
        claimMatches: t.status === 'EXCLUDED' ? [] : cardClaimMatches({ holderId: t.holderId, date: t.date, amount: t.amount }, claimLines),
        canCode: (t.status === 'UNCODED' || t.status === 'CODED') && (t.holderId === user.id || hasPermission(org.role, 'banking.manage')),
      };
    });
  }

  /** The cardholder (or finance) says which account the spending belongs to and why. */
  async code(org: OrgContext, actor: AuthUser, id: string, input: { accountId: string; note: string | null }) {
    const t = await this.txn(id);
    if (t.holderId !== actor.id && !hasPermission(org.role, 'banking.manage')) throw new DomainError('FORBIDDEN', 'Only the cardholder or finance can explain this spending', HttpStatus.FORBIDDEN);
    if (t.status === 'POSTED' || t.status === 'EXCLUDED') throw new DomainError('TXN_FINAL', `This transaction is already ${t.status.toLowerCase()}`, HttpStatus.CONFLICT);
    const p = await this.program(t.programId);
    const a = await this.store.collection(accounts).findById(input.accountId);
    if (!a || !a.isPostable || !a.isActive || (a.type !== 'EXPENSE' && a.type !== 'ASSET') || a.id === p.liabilityAccountId) throw new DomainError('INVALID_ACCOUNT', 'Choose an active expense or asset account');
    const note = input.note?.trim() || null;
    const r = await this.store.collection(cardTransactions).updateOne({ id: t.id, status: { $in: ['UNCODED', 'CODED'] } }, { $set: { status: 'CODED', accountId: a.id, note, codedById: actor.id, codedAt: new Date(), updatedAt: new Date() } });
    if (!r.matched) throw new DomainError('TXN_FINAL', 'This transaction was posted or excluded at the same moment', HttpStatus.CONFLICT);
    await this.log(org.id, actor.id, 'card_transaction.coded', 'card_transaction', t.id, { accountId: a.id, note, previousAccountId: t.accountId });
    return this.one(org, actor, t.id);
  }

  /** Finance posts settled, explained spending: debit the account, credit the card programme's account. */
  async post(org: OrgContext, actor: AuthUser, id: string) {
    if (!hasPermission(org.role, 'expenses.read')) throw new DomainError('FORBIDDEN', 'Posting card spending needs access to expenses', HttpStatus.FORBIDDEN);
    const je = await this.prisma.$transaction(async (tx) => {
      await holdLock(`card_transaction:${id}`);
      const t = await this.txn(id);
      if (t.status !== 'CODED') throw new DomainError('NOT_CODED', t.status === 'UNCODED' ? 'Say which account this spending belongs to first' : `This transaction is already ${t.status.toLowerCase()}`, HttpStatus.CONFLICT);
      if (t.state !== 'SETTLED') throw new DomainError('NOT_SETTLED', 'This spending is only authorised; post it once the provider sends it settled', HttpStatus.CONFLICT);
      const p = await this.program(t.programId);
      const c = await this.card(t.cardId);
      const entry = await this.journals.postSystemEntry(tx, org, actor, {
        date: t.date,
        source: 'EXPENSE',
        memo: `Card ${cardRef(c.number)} ··${c.last4 ?? ''} · ${t.merchant}`,
        reference: t.externalId.slice(0, 50),
        lines: cardJournalLines({ amount: t.amount, merchant: t.merchant, note: t.note }, t.accountId!, p.liabilityAccountId),
      });
      const r = await this.store.collection(cardTransactions).updateOne({ id: t.id, status: 'CODED' }, { $set: { status: 'POSTED', journalEntryId: entry.id, postedById: actor.id, postedAt: new Date(), updatedAt: new Date() } });
      if (!r.matched) throw new DomainError('TXN_FINAL', 'This transaction changed at the same moment; refresh and try again', HttpStatus.CONFLICT);
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'card_transaction.posted', entityType: 'card_transaction', entityId: t.id, data: { journalEntryId: entry.id, amount: t.amount, accountId: t.accountId, liabilityAccountId: p.liabilityAccountId } });
      return entry;
    });
    return { ...(await this.one(org, actor, id)), journalEntryId: je.id };
  }

  /** Leaves spending out of the books (a test charge, or one the provider reversed), with a reason. */
  async exclude(org: OrgContext, actor: AuthUser, id: string, reason: string) {
    const t = await this.txn(id);
    if (t.status === 'POSTED' || t.status === 'EXCLUDED') throw new DomainError('TXN_FINAL', `This transaction is already ${t.status.toLowerCase()}`, HttpStatus.CONFLICT);
    const r = await this.store.collection(cardTransactions).updateOne({ id: t.id, status: t.status }, { $set: { status: 'EXCLUDED', excludedReason: reason.trim(), excludedById: actor.id, updatedAt: new Date() } });
    if (!r.matched) throw new DomainError('TXN_FINAL', 'This transaction changed at the same moment; refresh and try again', HttpStatus.CONFLICT);
    await this.log(org.id, actor.id, 'card_transaction.excluded', 'card_transaction', t.id, { reason: reason.trim(), amount: t.amount });
    return this.one(org, actor, t.id);
  }

  // ------------------------------------------------------------------ the provider (token, no sign-in)

  async whoAmI(token: string) {
    const { p, org } = await this.open(token);
    const cards = await this.store.collection(companyCards).find({ programId: p.id });
    return { programme: { name: p.name, provider: p.provider, currency: p.currency }, organisation: org.name, cards: cards.length, waitingToIssue: cards.filter((c) => c.status === 'REQUESTED').length, lastDeliveryAt: p.lastDeliveryAt?.toISOString() ?? null };
  }

  /** Every card in the programme with the controls finance set, so the provider enforces them. */
  async feedCards(token: string) {
    const { p } = await this.open(token);
    const cards = await this.store.collection(companyCards).find({ programId: p.id }, { sort: { number: 1 } });
    const names = await this.names(cards.map((c) => c.holderId));
    const spent = await this.spentThisMonth(cards.map((c) => c.id));
    return {
      currency: p.currency,
      cards: cards.map((c) => ({
        id: c.id,
        reference: cardRef(c.number),
        kind: c.kind,
        label: c.label,
        holder: names.get(c.holderId) ?? 'A former member',
        status: c.status,
        monthlyLimit: c.monthlyLimit,
        spentThisMonth: new D(spent.get(c.id) ?? '0').toFixed(minorUnits(p.currency)),
        last4: c.last4,
        providerRef: c.providerRef,
        expires: c.expires,
      })),
    };
  }

  /** The provider confirms a virtual card it issued: its reference, last four digits and expiry. */
  async issued(token: string, cardId: string, input: { providerRef: string; last4: string; expires: string }) {
    const { p, org } = await this.open(token);
    const card = await this.store.collection(companyCards).findOne({ id: cardId, programId: p.id });
    if (!card) throw new NotFoundException({ error: 'NOT_FOUND', message: 'No such card in this programme' });
    if (card.status !== 'REQUESTED') throw new DomainError('CARD_STATE', card.status === 'CANCELLED' ? 'This card was cancelled before it was issued' : 'This card is already issued', HttpStatus.CONFLICT);
    if (input.expires < todayIso().slice(0, 7)) throw new DomainError('CARD_EXPIRED', 'The expiry is in the past');
    try {
      const r = await this.store
        .collection(companyCards)
        .updateOne({ id: card.id, status: 'REQUESTED' }, { $set: { status: 'ACTIVE', providerRef: input.providerRef.trim(), last4: input.last4, expires: input.expires }, $push: { history: { at: new Date(), byId: null, action: 'ISSUED', note: `Issued by ${p.provider}` } } } as never);
      if (!r.matched) throw new DomainError('CARD_STATE', 'This card changed at the same moment', HttpStatus.CONFLICT);
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new DomainError('CARD_EXISTS', 'Another card in this programme has that provider reference', HttpStatus.CONFLICT);
      throw e;
    }
    await this.log(org.id, null, 'company_card.issued', 'company_card', card.id, { reference: cardRef(card.number), last4: input.last4, expires: input.expires, prefix: p.prefix });
    return { id: card.id, reference: cardRef(card.number), status: 'ACTIVE', last4: input.last4, expires: input.expires };
  }

  /** Card transactions from the provider. Sending one again never adds it twice; a settled one replaces its authorisation. */
  async deliver(token: string, transactions: unknown[]) {
    const { p, org } = await this.open(token);
    const cards = await this.store.collection(companyCards).find({ programId: p.id });
    const feedCards: FeedCard[] = cards.map((c) => ({ id: c.id, last4: c.last4, providerRef: c.providerRef, status: c.status }));
    const checked = normaliseCardTransactions(transactions, { currency: p.currency, today: todayIso(), cards: feedCards });
    let added = 0; // not money
    let settled = 0; // not money
    let duplicates = 0; // not money
    const rejections = [...checked.rejected];
    const now = new Date();
    for (const l of checked.lines) {
      const card = cards.find((c) => c.id === l.cardId)!;
      const amount = l.amount.toFixed();
      try {
        await this.store.collection(cardTransactions).insertOne({
          programId: p.id,
          cardId: card.id,
          holderId: card.holderId,
          externalId: l.externalId,
          date: l.date,
          amount,
          currency: p.currency,
          merchant: l.merchant,
          mcc: l.mcc,
          state: l.state,
          status: 'UNCODED',
          accountId: null,
          note: null,
          codedById: null,
          codedAt: null,
          journalEntryId: null,
          postedById: null,
          postedAt: null,
          excludedReason: null,
          excludedById: null,
          receivedAt: now,
          updatedAt: now,
        });
        added += 1;
      } catch (e) {
        if (!isDuplicateKeyError(e)) throw e;
        const before = await this.store.collection(cardTransactions).findOne({ programId: p.id, externalId: l.externalId });
        if (!before) throw e;
        if (before.cardId !== card.id) {
          rejections.push({ position: checked.lines.indexOf(l) + 1, id: l.externalId, reasons: ['this id was sent earlier for another card'] });
          continue;
        }
        if (before.state === 'AUTHORISED' && l.state === 'SETTLED' && before.status !== 'POSTED') {
          await this.store.collection(cardTransactions).updateOne({ id: before.id, state: 'AUTHORISED' }, { $set: { state: 'SETTLED', amount, date: l.date, merchant: l.merchant, mcc: l.mcc, updatedAt: now } });
          settled += 1;
        } else duplicates += 1;
      }
    }
    await this.store.collection(cardPrograms).updateOne({ id: p.id }, { $set: { lastDeliveryAt: now }, $inc: { deliveryCount: 1, transactionsReceived: added } });
    if (rejections.length) await this.log(org.id, null, 'card_program.transactions_refused', 'card_program', p.id, { prefix: p.prefix, received: transactions.length, rejected: rejections.length });
    return { received: transactions.length, added, settled, duplicates, rejected: rejections.length, rejections: rejections.slice(0, KEEP_REJECTIONS) };
  }

  // ------------------------------------------------------------------ helpers

  private async open(token: string) {
    const invalid = () => new DomainError('CARD_TOKEN_INVALID', 'This card programme token is not valid. Ask the organisation for a new one.', HttpStatus.UNAUTHORIZED);
    if (!CARD_FEED_TOKEN_PATTERN.test(token)) throw invalid();
    const found = await runAsSystem(async () => {
      const p = await this.store.collection(cardPrograms).findOne({ tokenHash: hash(token), status: 'ACTIVE' });
      if (!p) return null;
      const org = await this.store.collection(organizations).findById(p.orgId);
      return org ? { p, org } : null;
    });
    if (!found) throw invalid();
    if (found.org.suspendedAt) throw new DomainError('PROGRAM_UNAVAILABLE', `${found.org.name} cannot take card deliveries right now`, HttpStatus.FORBIDDEN);
    this.regions.assertHere(found.org.dataRegion);
    enterOrg(found.org.id, found.org.timeZone);
    return found;
  }

  private limit(v: string | null | undefined, currency: string) {
    if (v === null || v === undefined || v === '') return null;
    const scale = Math.min(2, minorUnits(currency));
    const l = new D(v);
    if (l.isNeg() || l.decimalPlaces() > scale) throw new DomainError('INVALID_LIMIT', `Enter the monthly limit with at most ${scale} decimals`);
    return l.toFixed(scale);
  }

  /** Spending this calendar month on each card: settled and authorised, less refunds, leaving out excluded transactions. */
  private async spentThisMonth(cardIds: string[]) {
    const out = new Map<string, string>();
    if (!cardIds.length) return out;
    const month = todayIso().slice(0, 7);
    const rows = await this.store.collection(cardTransactions).find({ cardId: { $in: cardIds }, date: { $gte: `${month}-01`, $lte: `${month}-31` }, status: { $ne: 'EXCLUDED' } });
    for (const r of rows) out.set(r.cardId, new D(out.get(r.cardId) ?? '0').plus(r.amount).toFixed());
    return out;
  }

  private async claimLines(holderIds: string[]): Promise<CardClaimLine[]> {
    if (!holderIds.length) return [];
    const claims = await this.store.collection(expenseClaims).find({ claimantId: { $in: holderIds }, status: { $nin: ['VOID', 'REJECTED', 'DRAFT'] } });
    return claims.flatMap((c) => c.lines.map((l) => ({ claimId: c.id, claimNumber: c.number, claimStatus: c.status, claimantId: c.claimantId, lineNo: l.lineNo, date: fromDbDate(l.date), amount: String(l.amount), merchant: l.merchant })));
  }

  private async one(org: OrgContext, user: AuthUser, id: string) {
    const t = await this.txn(id);
    const all = await this.transactions(org, user, { cardId: t.cardId });
    const found = all.find((x) => x.id === id);
    if (!found) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Card transaction not found' });
    return found;
  }

  private async program(id: string) {
    const p = await this.store.collection(cardPrograms).findById(id);
    if (!p) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Card programme not found' });
    return p;
  }

  private async card(id: string) {
    const c = await this.store.collection(companyCards).findById(id);
    if (!c) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Card not found' });
    return c;
  }

  private async txn(id: string) {
    const t = await this.store.collection(cardTransactions).findById(id);
    if (!t) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Card transaction not found' });
    return t;
  }

  private async names(ids: (string | null)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    const rows = list.length ? await this.store.collection(users).find({ id: { $in: list } }) : [];
    return new Map(rows.map((u) => [u.id, u.name || u.email]));
  }

  private programView(p: CardProgramDoc, account: string, names: Map<string, string>) {
    return {
      id: p.id,
      name: p.name,
      provider: p.provider,
      currency: p.currency,
      account: { id: p.liabilityAccountId, name: account },
      status: p.status,
      prefix: p.prefix,
      createdBy: names.get(p.createdById) ?? 'A former member',
      createdAt: p.createdAt.toISOString(),
      lastDeliveryAt: p.lastDeliveryAt?.toISOString() ?? null,
      deliveryCount: p.deliveryCount,
      transactionsReceived: p.transactionsReceived,
    };
  }

  private cardView(c: CompanyCardDoc, p: CardProgramDoc | undefined, names: Map<string, string>, spent: string) {
    return {
      id: c.id,
      reference: cardRef(c.number),
      programId: c.programId,
      program: p?.name ?? '',
      currency: p?.currency ?? '',
      kind: c.kind,
      label: c.label,
      holder: { id: c.holderId, name: names.get(c.holderId) ?? 'A former member' },
      status: c.status,
      last4: c.last4,
      providerRef: c.providerRef,
      expires: c.expires,
      contactId: c.contactId,
      ...cardLimitStatus(c.monthlyLimit, spent),
      history: c.history.map((h) => ({ at: h.at instanceof Date ? h.at.toISOString() : String(h.at), action: h.action, by: h.byId ? (names.get(h.byId) ?? null) : null, note: h.note })),
    };
  }

  private txnView(t: CardTransactionDoc, names: Map<string, string>) {
    return {
      id: t.id,
      externalId: t.externalId,
      cardId: t.cardId,
      holder: { id: t.holderId, name: names.get(t.holderId) ?? 'A former member' },
      date: t.date,
      amount: t.amount,
      currency: t.currency,
      merchant: t.merchant,
      mcc: t.mcc,
      state: t.state,
      status: t.status,
      note: t.note,
      codedBy: t.codedById ? (names.get(t.codedById) ?? null) : null,
      postedBy: t.postedById ? (names.get(t.postedById) ?? null) : null,
      postedAt: t.postedAt?.toISOString() ?? null,
      journalEntryId: t.journalEntryId,
      excludedReason: t.excludedReason,
      receivedAt: t.receivedAt.toISOString(),
    };
  }

  private log(orgId: string, actorId: string | null, action: string, entityType: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId, action, entityType, entityId, data }));
  }
}
