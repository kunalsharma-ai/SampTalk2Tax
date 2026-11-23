import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  BANK_FEED_TOKEN_PATTERN,
  type BankFeedKind,
  bankFeedHealth,
  bankFeedLineKey,
  bankFeedOutcome,
  bankFeedTokenPrefix,
  detectStatementFormat,
  makeBankFeedToken,
  normaliseFeedTransactions,
  parseStatementFile,
  StatementImportError,
  statementLineKeys,
} from '@talk2tax/accounting-engine';
import { isDuplicateKeyError } from '@talk2tax/document-db';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { BankingService } from '../banking/banking.service';
import { todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { enterOrg, runAsSystem } from '../common/tenant-context';
import { bankFeedConnections, type BankFeedConnectionDoc, bankFeedDeliveries, type BankFeedDeliveryDoc } from '../db/collections/bank-feeds';
import { users } from '../db/collections/identity';
import { organizations } from '../db/collections/tenancy';
import { RegionsService } from '../regions/regions.service';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const KEEP_REJECTIONS = 50;

type FeedOrg = { id: string; role: OrgContext['role']; functionalCurrency: string };

/**
 * Bank feeds (BANK-004): connections that let a bank channel, an aggregator partner or a script
 * send one bank account's transactions (JSON) or statement files (OFX, QIF, MT940) with a secret
 * token, and the record of every delivery. Lines arrive unmatched, like an imported file.
 */
@Injectable()
export class BankFeedsService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly banking: BankingService,
    private readonly regions: RegionsService,
  ) {}

  // ------------------------------------------------------------------ staff

  async list(org: OrgContext) {
    const rows = await this.store.collection(bankFeedConnections).find({}, { sort: { createdAt: -1 } });
    return Promise.all(rows.map((c) => this.view(org, c)));
  }

  async get(org: OrgContext, id: string) {
    const c = await this.connection(id);
    const deliveries = await this.store.collection(bankFeedDeliveries).find({ connectionId: c.id }, { sort: { receivedAt: -1 }, limit: 50 });
    return { ...(await this.view(org, c)), deliveries: deliveries.map((d) => this.deliveryView(d)) };
  }

  /** Sets up a feed for a bank account. The token is shown once; only its hash is kept. */
  async create(org: OrgContext, actor: AuthUser, input: { accountId: string; name: string; kind: BankFeedKind; expectEveryHours: number }) {
    const account = await this.banking.accountCurrency(org, input.accountId);
    if (!account.isActive) throw new DomainError('ACCOUNT_INACTIVE', `${account.code} ${account.name} is inactive`);
    const token = makeBankFeedToken((n) => randomBytes(n));
    const now = new Date();
    let doc: BankFeedConnectionDoc;
    try {
      doc = await this.store.collection(bankFeedConnections).insertOne({
        accountId: input.accountId,
        name: input.name.trim(),
        kind: input.kind,
        status: 'ACTIVE',
        live: true,
        prefix: bankFeedTokenPrefix(token),
        tokenHash: hash(token),
        expectEveryHours: input.expectEveryHours,
        createdById: actor.id,
        createdAt: now,
        tokenIssuedAt: now,
        revokedAt: null,
        revokedById: null,
        lastDeliveryAt: null,
        lastOutcome: null,
        lastAcceptedAt: null,
        deliveryCount: 0,
        linesImported: 0,
      });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new DomainError('FEED_EXISTS', `${account.code} ${account.name} already has a feed; disconnect it first so the same money is never added twice`, HttpStatus.CONFLICT);
      throw e;
    }
    // The audit trail names the feed by its token prefix; the secret is never recorded.
    await this.log(org.id, actor.id, 'bank_feed.created', doc.id, { accountId: doc.accountId, name: doc.name, kind: doc.kind, prefix: doc.prefix, expectEveryHours: doc.expectEveryHours });
    return { ...(await this.view(org, doc)), token };
  }

  async update(org: OrgContext, actor: AuthUser, id: string, input: { name?: string; expectEveryHours?: number }) {
    const c = await this.connection(id);
    if (c.status === 'REVOKED') throw new DomainError('FEED_DISCONNECTED', 'This feed is disconnected', HttpStatus.CONFLICT);
    const set: Partial<BankFeedConnectionDoc> = {};
    if (input.name !== undefined) set.name = input.name.trim();
    if (input.expectEveryHours !== undefined) set.expectEveryHours = input.expectEveryHours;
    await this.store.collection(bankFeedConnections).updateOne({ id: c.id }, { $set: set });
    await this.log(org.id, actor.id, 'bank_feed.updated', c.id, { prefix: c.prefix, ...set });
    return this.get(org, c.id);
  }

  /** Pauses (deliveries are refused with FEED_PAUSED) or resumes a feed. */
  async setPaused(org: OrgContext, actor: AuthUser, id: string, paused: boolean) {
    const c = await this.connection(id);
    const from = paused ? 'ACTIVE' : 'PAUSED';
    if (c.status !== from) throw new DomainError('FEED_STATE', c.status === 'REVOKED' ? 'This feed is disconnected' : paused ? 'This feed is already paused' : 'This feed is not paused', HttpStatus.CONFLICT);
    const r = await this.store.collection(bankFeedConnections).updateOne({ id: c.id, status: from }, { $set: { status: paused ? 'PAUSED' : 'ACTIVE' } });
    if (!r.matched) throw new DomainError('FEED_STATE', 'Someone changed this feed at the same moment; refresh and try again', HttpStatus.CONFLICT);
    await this.log(org.id, actor.id, paused ? 'bank_feed.paused' : 'bank_feed.resumed', c.id, { prefix: c.prefix });
    return this.get(org, c.id);
  }

  /** A new token for the sender; the old one stops working at once. */
  async rotateToken(org: OrgContext, actor: AuthUser, id: string) {
    const c = await this.connection(id);
    if (c.status === 'REVOKED') throw new DomainError('FEED_DISCONNECTED', 'This feed is disconnected', HttpStatus.CONFLICT);
    const token = makeBankFeedToken((n) => randomBytes(n));
    const r = await this.store.collection(bankFeedConnections).updateOne({ id: c.id, tokenHash: c.tokenHash, live: true }, { $set: { tokenHash: hash(token), prefix: bankFeedTokenPrefix(token), tokenIssuedAt: new Date() } });
    if (!r.matched) throw new DomainError('FEED_STATE', 'Someone changed this feed at the same moment; refresh and try again', HttpStatus.CONFLICT);
    await this.log(org.id, actor.id, 'bank_feed.token_rotated', c.id, { previousPrefix: c.prefix, prefix: bankFeedTokenPrefix(token) });
    return { ...(await this.get(org, c.id)), token };
  }

  /** Disconnects for good: the token stops working and the account can have a new feed. Lines already in stay. */
  async disconnect(org: OrgContext, actor: AuthUser, id: string) {
    const c = await this.connection(id);
    if (c.status === 'REVOKED') throw new DomainError('FEED_DISCONNECTED', 'This feed is already disconnected', HttpStatus.CONFLICT);
    const r = await this.store.collection(bankFeedConnections).updateOne({ id: c.id, live: true }, { $set: { status: 'REVOKED', live: false, revokedAt: new Date(), revokedById: actor.id } });
    if (!r.matched) throw new DomainError('FEED_DISCONNECTED', 'This feed is already disconnected', HttpStatus.CONFLICT);
    await this.log(org.id, actor.id, 'bank_feed.disconnected', c.id, { prefix: c.prefix, accountId: c.accountId });
    return this.get(org, c.id);
  }

  // ------------------------------------------------------------------ the sender (token, no sign-in)

  /** What the token is for: a sender's check that it is set up right. */
  async whoAmI(token: string) {
    const { c, org, account } = await this.open(token, false);
    return { feed: { name: c.name, kind: c.kind, status: c.status, expectEveryHours: c.expectEveryHours }, organisation: org.name, account: { code: account.code, name: account.name, currency: account.currency }, lastDeliveryAt: c.lastDeliveryAt?.toISOString() ?? null };
  }

  /** Transactions as JSON, each with the sender's own id. Sending one again never adds it twice. */
  async deliverTransactions(token: string, transactions: unknown[]) {
    const { c, feedOrg, account } = await this.open(token, true, 'TRANSACTIONS');
    const payloadHash = hash(JSON.stringify(transactions));
    const checked = normaliseFeedTransactions(transactions, { currency: account.currency, today: todayIso() });
    const lines = checked.lines.map((l) => ({ key: bankFeedLineKey(c.accountId, l.externalId), date: l.date, description: l.description, reference: l.reference, amount: l.amount }));
    const r = await this.banking.importFedLines(feedOrg, {
      accountId: c.accountId,
      importedById: c.createdById,
      fileName: `Bank feed: ${c.name}`,
      fileHash: payloadHash,
      lines,
      audit: { feedId: c.id, prefix: c.prefix, kind: c.kind },
    });
    const blocked = r.blocked.map((i) => ({ position: 0, id: checked.lines[i]!.externalId, reasons: [`dated on or before ${r.reconciledUntil}, when this account was last reconciled`] }));
    const positions = new Map(transactions.map((t, i) => [t && typeof t === 'object' ? String((t as { id?: unknown }).id ?? '') : '', i + 1])); // not money
    for (const b of blocked) b.position = positions.get(b.id) ?? 0;
    const rejections = [...checked.rejected, ...blocked].sort((a, b) => a.position - b.position);
    return this.record(c, feedOrg.id, {
      fileName: null,
      payloadHash,
      received: transactions.length,
      imported: r.imported.length,
      duplicates: r.duplicates.length,
      rejections,
      importId: r.importId,
      error: null,
      reconciledUntil: r.reconciledUntil,
    });
  }

  /** A statement file (OFX, QIF or MT940), deduplicated like an uploaded one. */
  async deliverStatement(token: string, input: { fileName: string; content: string }) {
    const { c, feedOrg, account } = await this.open(token, true, 'STATEMENT_FILE');
    const payloadHash = hash(input.content);
    const format = detectStatementFormat(input.content);
    let parsed: ReturnType<typeof parseStatementFile> | null = null;
    let error: string | null = format ? null : 'Not an OFX, QIF or MT940 statement file';
    if (format) {
      try {
        parsed = parseStatementFile(format, input.content, account.currency);
        if (!parsed.lines.length) error = 'The file has no transactions';
      } catch (e) {
        if (!(e instanceof StatementImportError)) throw e;
        error = e.issues.slice(0, 5).join('; ');
      }
    }
    if (error || !parsed) {
      const d = await this.record(c, feedOrg.id, { fileName: input.fileName, payloadHash, received: 0, imported: 0, duplicates: 0, rejections: [], importId: null, error, reconciledUntil: null });
      throw new DomainError('FEED_FILE_UNREADABLE', error ?? 'The file could not be read', HttpStatus.UNPROCESSABLE_ENTITY, { deliveryId: d.deliveryId });
    }
    const keys = statementLineKeys(c.accountId, parsed.lines);
    const r = await this.banking.importFedLines(feedOrg, {
      accountId: c.accountId,
      importedById: c.createdById,
      fileName: input.fileName,
      fileHash: payloadHash,
      lines: parsed.lines.map((l, i) => ({ key: keys[i]!, date: l.date, description: l.description, reference: l.reference, amount: l.amount, balance: l.balance ?? null })),
      audit: { feedId: c.id, prefix: c.prefix, kind: c.kind, format, fileName: input.fileName },
    });
    const rejections = r.blocked.map((i) => ({ position: parsed!.lines[i]!.row, id: null, reasons: [`dated on or before ${r.reconciledUntil}, when this account was last reconciled`] }));
    return this.record(c, feedOrg.id, { fileName: input.fileName, payloadHash, received: parsed.lines.length, imported: r.imported.length, duplicates: r.duplicates.length, rejections, importId: r.importId, error: null, reconciledUntil: r.reconciledUntil });
  }

  // ------------------------------------------------------------------ helpers

  /** Finds the live feed for a token across organisations, then narrows the request to its organisation. */
  private async open(token: string, delivering: boolean, kind?: BankFeedKind) {
    const invalid = () => new DomainError('FEED_TOKEN_INVALID', 'This bank feed token is not valid. Ask the organisation for a new one.', HttpStatus.UNAUTHORIZED);
    if (!BANK_FEED_TOKEN_PATTERN.test(token)) throw invalid();
    const found = await runAsSystem(async () => {
      const c = await this.store.collection(bankFeedConnections).findOne({ tokenHash: hash(token), live: true });
      if (!c) return null;
      const org = await this.store.collection(organizations).findById(c.orgId);
      return org ? { c, org } : null;
    });
    if (!found) throw invalid();
    const { c, org } = found;
    if (org.suspendedAt) throw new DomainError('FEED_UNAVAILABLE', `${org.name} cannot take bank feed deliveries right now`, HttpStatus.FORBIDDEN);
    this.regions.assertHere(org.dataRegion);
    enterOrg(org.id, org.timeZone);
    if (delivering && c.status === 'PAUSED') throw new DomainError('FEED_PAUSED', `${org.name} has paused this feed; deliveries are refused until it is resumed`, HttpStatus.CONFLICT);
    if (kind && c.kind !== kind) throw new DomainError('FEED_KIND', c.kind === 'TRANSACTIONS' ? 'This feed takes transactions; post them to /v1/bank-feed/transactions' : 'This feed takes statement files; post them to /v1/bank-feed/statement', HttpStatus.CONFLICT);
    const feedOrg: FeedOrg = { id: org.id, role: 'ACCOUNTANT', functionalCurrency: org.functionalCurrency };
    const account = await this.banking.accountCurrency(feedOrg, c.accountId);
    if (delivering && !account.isActive) throw new DomainError('ACCOUNT_INACTIVE', `${account.code} ${account.name} is inactive in ${org.name}`, HttpStatus.CONFLICT);
    return { c, org, feedOrg, account };
  }

  private async record(
    c: BankFeedConnectionDoc,
    orgId: string,
    r: { fileName: string | null; payloadHash: string; received: number; imported: number; duplicates: number; rejections: BankFeedDeliveryDoc['rejections']; importId: string | null; error: string | null; reconciledUntil: string | null },
  ) {
    const outcome = r.error ? 'FAILED' : bankFeedOutcome({ imported: r.imported, duplicates: r.duplicates, rejected: r.rejections.length });
    const now = new Date();
    const d = await this.store.collection(bankFeedDeliveries).insertOne({
      connectionId: c.id,
      accountId: c.accountId,
      receivedAt: now,
      outcome,
      fileName: r.fileName,
      payloadHash: r.payloadHash,
      received: r.received,
      imported: r.imported,
      duplicates: r.duplicates,
      rejected: r.rejections.length,
      rejections: r.rejections.slice(0, KEEP_REJECTIONS),
      importId: r.importId,
      error: r.error,
    });
    const accepted = outcome === 'IMPORTED' || outcome === 'NOTHING_NEW';
    await this.store.collection(bankFeedConnections).updateOne(
      { id: c.id },
      { $set: { lastDeliveryAt: now, lastOutcome: outcome, ...(accepted ? { lastAcceptedAt: now } : {}) }, $inc: { deliveryCount: 1, linesImported: r.imported } },
    );
    if (!accepted) await this.log(orgId, null, 'bank_feed.delivery_refused', c.id, { prefix: c.prefix, deliveryId: d.id, outcome, received: r.received, rejected: r.rejections.length, error: r.error });
    return { deliveryId: d.id, outcome, received: r.received, imported: r.imported, duplicates: r.duplicates, rejected: r.rejections.length, rejections: r.rejections, reconciledUntil: r.reconciledUntil };
  }

  private async connection(id: string) {
    const c = await this.store.collection(bankFeedConnections).findById(id);
    if (!c) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Bank feed not found' });
    return c;
  }

  private async view(org: OrgContext, c: BankFeedConnectionDoc) {
    const account = await this.banking.accountCurrency(org, c.accountId).catch(() => null);
    const people = await this.store.collection(users).find({ id: { $in: [c.createdById, c.revokedById].filter((x): x is string => !!x) } });
    const name = (id: string | null) => (id ? (people.find((u) => u.id === id)?.name ?? people.find((u) => u.id === id)?.email ?? 'A former member') : null);
    const health = bankFeedHealth(c, new Date());
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      status: c.status,
      health: health.health,
      healthMessage: health.message,
      account: account ? { id: c.accountId, code: account.code, name: account.name, currency: account.currency } : { id: c.accountId, code: '', name: 'Removed account', currency: org.functionalCurrency },
      prefix: c.prefix,
      expectEveryHours: c.expectEveryHours,
      createdBy: name(c.createdById),
      createdAt: c.createdAt.toISOString(),
      tokenIssuedAt: c.tokenIssuedAt.toISOString(),
      revokedAt: c.revokedAt?.toISOString() ?? null,
      revokedBy: name(c.revokedById),
      lastDeliveryAt: c.lastDeliveryAt?.toISOString() ?? null,
      lastOutcome: c.lastOutcome,
      lastAcceptedAt: c.lastAcceptedAt?.toISOString() ?? null,
      deliveryCount: c.deliveryCount,
      linesImported: c.linesImported,
    };
  }

  private deliveryView(d: BankFeedDeliveryDoc) {
    return {
      id: d.id,
      receivedAt: d.receivedAt.toISOString(),
      outcome: d.outcome,
      fileName: d.fileName,
      received: d.received,
      imported: d.imported,
      duplicates: d.duplicates,
      rejected: d.rejected,
      rejections: d.rejections,
      importId: d.importId,
      error: d.error,
    };
  }

  private log(orgId: string, actorId: string | null, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId, action, entityType: 'bank_feed', entityId, data }));
  }
}
