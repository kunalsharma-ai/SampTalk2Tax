import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { dec, minorUnits, TRIP_ESTIMATE_KEYS, tripCosts } from '@talk2tax/accounting-engine';
import { hasPermission, type Permission } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { type ExpenseTripDoc, expenseTrips, type TripStatus } from '../db/collections/expense-trips';
import { users } from '../db/collections/identity';

export interface TripInput {
  purpose: string;
  destination: string;
  startDate: string;
  endDate: string;
  estimate: { transport: string; lodging: string; meals: string; other: string };
}

const ref = (n: number) => `TRIP-${String(n).padStart(4, '0')}`;
/** A trip can be requested up to this many days after it ended (trips booked late are still recorded). */
const PAST_DAYS = 90;
const MAX_DAYS = 90;

/**
 * Business trips (EXP-007). Anyone who claims expenses requests a trip; someone else with
 * approvals.decide approves or rejects it; the traveller links their own expense claims to an
 * approved trip, and the trip shows what it cost against the estimate (engine tripCosts). Finance
 * (expenses.read) and approvers see every trip; others see their own. Every step is audited.
 */
@Injectable()
export class ExpenseTripsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly store: DocumentStoreService,
  ) {}

  private require(org: OrgContext, p: Permission, what: string) {
    if (!hasPermission(org.role, p)) throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot ${what}; it needs ${p}`, HttpStatus.FORBIDDEN);
  }

  private seesAll(org: OrgContext) {
    return hasPermission(org.role, 'expenses.read') || hasPermission(org.role, 'approvals.decide');
  }

  private invalid(message: string): never {
    throw new DomainError('VALIDATION_FAILED', message, HttpStatus.UNPROCESSABLE_ENTITY);
  }

  private async names(ids: (string | null)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    return new Map((list.length ? await this.store.collection(users).find({ id: { $in: list } }) : []).map((u) => [u.id, u.name]));
  }

  private async load(org: OrgContext, user: AuthUser, id: string) {
    const t = await this.store.collection(expenseTrips).findById(id);
    if (!t || (t.travellerId !== user.id && !this.seesAll(org))) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Trip not found' });
    return t;
  }

  async list(org: OrgContext, user: AuthUser, q: { status?: TripStatus; mine?: boolean }) {
    if (!this.seesAll(org)) this.require(org, 'expenses.submit', 'see trips');
    const all = this.seesAll(org) && !q.mine;
    const rows = await this.store.collection(expenseTrips).find({ ...(all ? {} : { travellerId: user.id }), ...(q.status ? { status: q.status } : {}) }, { sort: { number: -1 }, limit: 500 });
    const who = await this.names(rows.map((r) => r.travellerId));
    const scale = minorUnits(org.functionalCurrency);
    return rows.map((t) => ({
      id: t.id,
      reference: ref(t.number),
      traveller: who.get(t.travellerId) ?? 'Former member',
      travellerId: t.travellerId,
      purpose: t.purpose,
      destination: t.destination,
      startDate: t.startDate,
      endDate: t.endDate,
      status: t.status,
      estimate: TRIP_ESTIMATE_KEYS.reduce((a, k) => a.plus(dec(t.estimate[k])), dec('0')).toFixed(scale),
      claims: t.claimIds.length,
    }));
  }

  async get(org: OrgContext, user: AuthUser, id: string) {
    const t = await this.load(org, user, id);
    const claims = t.claimIds.length
      ? await this.prisma.expenseClaim.findMany({ where: { orgId: org.id, id: { in: t.claimIds } }, include: { lines: { orderBy: { lineNo: 'asc' }, include: { account: { select: { code: true, name: true } } } } } })
      : [];
    claims.sort((a, b) => a.number.localeCompare(b.number));
    const scale = minorUnits(org.functionalCurrency);
    const costs = tripCosts(
      t,
      claims.map((c) => ({ id: c.id, number: c.number, status: c.status, lines: c.lines.map((l) => ({ lineNo: l.lineNo, date: fromDbDate(l.date), account: `${l.account.code} ${l.account.name}`, merchant: l.merchant, amount: l.amount.toFixed() })) })),
      scale,
    );
    const who = await this.names([t.travellerId, t.decidedById]);
    const own = t.travellerId === user.id;
    const linkable =
      own && t.status === 'APPROVED' && hasPermission(org.role, 'expenses.submit')
        ? await this.linkable(org, user, t)
        : [];
    return {
      id: t.id,
      reference: ref(t.number),
      traveller: who.get(t.travellerId) ?? 'Former member',
      travellerId: t.travellerId,
      purpose: t.purpose,
      destination: t.destination,
      startDate: t.startDate,
      endDate: t.endDate,
      currency: t.currency,
      status: t.status,
      decidedBy: t.decidedById ? (who.get(t.decidedById) ?? 'Former member') : null,
      decidedAt: t.decidedAt?.toISOString() ?? null,
      decisionNote: t.decisionNote,
      createdAt: t.createdAt.toISOString(),
      claims: claims.map((c) => ({ id: c.id, number: c.number, title: c.title, status: c.status, total: c.total.toFixed(scale), canUnlink: own && ['DRAFT', 'SUBMITTED', 'REJECTED'].includes(c.status) })),
      costs,
      canDecide: t.status === 'REQUESTED' && !own && hasPermission(org.role, 'approvals.decide'),
      canCancel: own && (t.status === 'REQUESTED' || (t.status === 'APPROVED' && !t.claimIds.length)),
      linkable,
    };
  }

  /** The traveller's own claims that are not void and not linked to any trip. */
  private async linkable(org: OrgContext, user: AuthUser, t: ExpenseTripDoc) {
    const linked = new Set((await this.store.collection(expenseTrips).find({ travellerId: user.id })).flatMap((x) => x.claimIds));
    const mine = await this.prisma.expenseClaim.findMany({ where: { orgId: org.id, claimantId: user.id, status: { not: 'VOID' } }, orderBy: { createdAt: 'desc' }, take: 200 });
    const scale = minorUnits(org.functionalCurrency);
    return mine.filter((c) => !linked.has(c.id) && t.status === 'APPROVED').map((c) => ({ id: c.id, number: c.number, title: c.title, status: c.status, total: c.total.toFixed(scale) }));
  }

  async create(org: OrgContext, user: AuthUser, input: TripInput, today = todayIso()) {
    this.require(org, 'expenses.submit', 'request trips');
    if (input.endDate < input.startDate) this.invalid('The trip ends before it starts');
    const days = (Date.parse(`${input.endDate}T00:00:00Z`) - Date.parse(`${input.startDate}T00:00:00Z`)) / 86_400_000 + 1; // not money
    if (days > MAX_DAYS) this.invalid(`A trip is at most ${MAX_DAYS} days; request a longer stay as separate trips`);
    const earliest = new Date(Date.parse(`${today}T00:00:00Z`) - PAST_DAYS * 86_400_000).toISOString().slice(0, 10); // not money
    if (input.endDate < earliest) this.invalid(`A trip that ended more than ${PAST_DAYS} days ago is too old to request`);
    const estimate = { transport: dec(input.estimate.transport).toFixed(), lodging: dec(input.estimate.lodging).toFixed(), meals: dec(input.estimate.meals).toFixed(), other: dec(input.estimate.other).toFixed() };
    const number = await this.store.nextTenantSequence('expense_trip');
    const now = new Date();
    const t = await this.store.collection(expenseTrips).insertOne({
      number,
      travellerId: user.id,
      purpose: input.purpose.trim(),
      destination: input.destination.trim(),
      startDate: input.startDate,
      endDate: input.endDate,
      currency: org.functionalCurrency,
      estimate,
      status: 'REQUESTED',
      decidedById: null,
      decidedAt: null,
      decisionNote: null,
      claimIds: [],
      createdAt: now,
      updatedAt: now,
    });
    await this.log(org, user, 'expense_trip.requested', t.id, { reference: ref(number), destination: t.destination, startDate: t.startDate, endDate: t.endDate, estimate });
    return this.get(org, user, t.id);
  }

  async decide(org: OrgContext, user: AuthUser, id: string, approve: boolean, note: string | null) {
    this.require(org, 'approvals.decide', 'decide on trips');
    const t = await this.load(org, user, id);
    if (t.travellerId === user.id) throw new DomainError('SAME_PERSON', 'You cannot decide on your own trip', HttpStatus.FORBIDDEN);
    if (t.status !== 'REQUESTED') throw new DomainError('NOT_REQUESTED', `This trip is ${t.status.toLowerCase()}, not waiting for a decision`, HttpStatus.CONFLICT);
    if (!approve && !note) this.invalid('Say why the trip is rejected');
    const status: TripStatus = approve ? 'APPROVED' : 'REJECTED';
    const r = await this.store.collection(expenseTrips).updateOne({ id, status: 'REQUESTED' }, { $set: { status, decidedById: user.id, decidedAt: new Date(), decisionNote: note, updatedAt: new Date() } });
    if (!r.matched) throw new DomainError('CHANGED', 'The trip changed meanwhile; reload and try again', HttpStatus.CONFLICT);
    await this.log(org, user, approve ? 'expense_trip.approved' : 'expense_trip.rejected', id, { reference: ref(t.number), note });
    return this.get(org, user, id);
  }

  async cancel(org: OrgContext, user: AuthUser, id: string) {
    const t = await this.load(org, user, id);
    if (t.travellerId !== user.id) throw new DomainError('NOT_TRAVELLER', 'Only the traveller can cancel a trip', HttpStatus.FORBIDDEN);
    if (t.status !== 'REQUESTED' && t.status !== 'APPROVED') throw new DomainError('NOT_OPEN', `This trip is ${t.status.toLowerCase()}`, HttpStatus.CONFLICT);
    if (t.claimIds.length) throw new DomainError('HAS_CLAIMS', 'Unlink the claims before cancelling the trip', HttpStatus.CONFLICT);
    const r = await this.store.collection(expenseTrips).updateOne({ id, status: t.status, claimIds: { $size: 0 } }, { $set: { status: 'CANCELLED', updatedAt: new Date() } });
    if (!r.matched) throw new DomainError('CHANGED', 'The trip changed meanwhile; reload and try again', HttpStatus.CONFLICT);
    await this.log(org, user, 'expense_trip.cancelled', id, { reference: ref(t.number) });
    return this.get(org, user, id);
  }

  async link(org: OrgContext, user: AuthUser, id: string, claimId: string) {
    this.require(org, 'expenses.submit', 'link claims to trips');
    const t = await this.load(org, user, id);
    if (t.travellerId !== user.id) throw new DomainError('NOT_TRAVELLER', 'Only the traveller links claims to a trip', HttpStatus.FORBIDDEN);
    if (t.status !== 'APPROVED') throw new DomainError('NOT_APPROVED', 'Claims are linked to a trip once it is approved', HttpStatus.CONFLICT);
    const c = await this.prisma.expenseClaim.findFirst({ where: { id: claimId, orgId: org.id }, select: { id: true, number: true, claimantId: true, status: true } });
    if (!c || c.claimantId !== user.id) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Expense claim not found among your claims' });
    if (c.status === 'VOID') throw new DomainError('CLAIM_VOID', 'A void claim cannot be linked', HttpStatus.CONFLICT);
    const other = await this.store.collection(expenseTrips).findOne({ claimIds: claimId });
    if (other) throw new DomainError('ALREADY_LINKED', `${c.number} is already linked to ${ref(other.number)}`, HttpStatus.CONFLICT);
    const r = await this.store.collection(expenseTrips).updateOne({ id, status: 'APPROVED' }, { $push: { claimIds: claimId }, $set: { updatedAt: new Date() } });
    if (!r.matched) throw new DomainError('CHANGED', 'The trip changed meanwhile; reload and try again', HttpStatus.CONFLICT);
    await this.log(org, user, 'expense_trip.claim_linked', id, { reference: ref(t.number), claimId, claim: c.number });
    return this.get(org, user, id);
  }

  async unlink(org: OrgContext, user: AuthUser, id: string, claimId: string) {
    const t = await this.load(org, user, id);
    if (t.travellerId !== user.id) throw new DomainError('NOT_TRAVELLER', 'Only the traveller unlinks claims from a trip', HttpStatus.FORBIDDEN);
    if (!t.claimIds.includes(claimId)) throw new NotFoundException({ error: 'NOT_FOUND', message: 'That claim is not linked to this trip' });
    const c = await this.prisma.expenseClaim.findFirst({ where: { id: claimId, orgId: org.id }, select: { number: true, status: true } });
    if (c && !['DRAFT', 'SUBMITTED', 'REJECTED'].includes(c.status)) throw new DomainError('CLAIM_POSTED', `${c.number} is ${c.status.toLowerCase()}; it stays with the trip`, HttpStatus.CONFLICT);
    const r = await this.store.collection(expenseTrips).updateOne({ id, claimIds: claimId }, { $pull: { claimIds: claimId }, $set: { updatedAt: new Date() } });
    if (!r.matched) throw new DomainError('CHANGED', 'The trip changed meanwhile; reload and try again', HttpStatus.CONFLICT);
    await this.log(org, user, 'expense_trip.claim_unlinked', id, { reference: ref(t.number), claimId, claim: c?.number ?? null });
    return this.get(org, user, id);
  }

  private log(org: OrgContext, user: AuthUser, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action, entityType: 'expense_trip', entityId, data }));
  }
}
