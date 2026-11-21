import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D, drawSample, populationFingerprint, sampleProgress, type SampleMethod, type SamplePopulation } from '@talk2tax/accounting-engine';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { fromDbDate, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { auditSamples, type AuditSampleDoc } from '../db/collections/audit-samples';
import { users } from '../db/collections/identity';
import { journalEntries } from '../db/collections/ledger';
import { contacts, documents, payments } from '../db/collections/sales';

export interface DrawInput {
  name: string;
  population: SamplePopulation;
  from: string;
  to: string;
  method: SampleMethod;
  size: number;
  threshold?: string;
  seed?: string;
}

interface Candidate {
  id: string;
  amount: string;
  label: string;
  date: Date;
}

const MAX_POPULATION = 50000;
const POPULATION_WORDS: Record<SamplePopulation, string> = { JOURNALS: 'Posted journals', BILLS: 'Posted bills', INVOICES: 'Posted invoices', PAYMENTS: 'Payments to suppliers' };

/**
 * Audit sampling (AUDIT-009). Anyone with audit.read draws a sample of posted journals, bills,
 * invoices or supplier payments for a date range, by random, monetary unit or high-value
 * selection, and records each item's result once. The seed is kept, so the sample can be drawn
 * again from the books to show it was not hand-picked, and the population's fingerprint shows
 * whether the books changed since. Every step is audited.
 */
@Injectable()
export class AuditSamplingService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The population, in the functional currency: posted items dated in the range. */
  private async population(kind: SamplePopulation, from: string, to: string): Promise<Candidate[]> {
    const range = { $gte: toDbDate(from), $lte: toDbDate(to) };
    if (kind === 'JOURNALS') {
      const list = await this.store.collection(journalEntries).find({ status: 'POSTED', date: range });
      return list.map((j) => ({ id: j.id, amount: new D(String(j.totalDebit)).toFixed(2), date: j.date, label: `Journal ${j.entryNumber}${j.memo ? `: ${j.memo.slice(0, 60)}` : ''}` }));
    }
    const names = async (ids: string[]) => new Map((ids.length ? await this.store.collection(contacts).find({ id: { $in: [...new Set(ids)] } }) : []).map((c) => [c.id, c.name]));
    if (kind === 'PAYMENTS') {
      const list = await this.store.collection(payments).find({ kind: 'PAYMENT', status: 'POSTED', date: range });
      const who = await names(list.map((p) => p.contactId));
      return list.map((p) => ({ id: p.id, amount: new D(String(p.amount)).times(String(p.exchangeRate)).toFixed(2), date: p.date, label: `${p.number}, ${who.get(p.contactId) ?? 'a supplier'}` }));
    }
    const list = await this.store.collection(documents).find({ kind: kind === 'BILLS' ? 'BILL' : 'INVOICE', status: 'POSTED', issueDate: range });
    const who = await names(list.map((d) => d.contactId));
    return list.map((d) => ({ id: d.id, amount: new D(String(d.total)).times(String(d.exchangeRate)).toFixed(2), date: d.issueDate, label: `${d.number}, ${who.get(d.contactId) ?? 'a contact'}` }));
  }

  private async sample(id: string) {
    const s = await this.store.collection(auditSamples).findById(id);
    if (!s) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Sample not found' });
    return s;
  }

  private async names(ids: string[]) {
    const list = ids.length ? await this.store.collection(users).find({ id: { $in: [...new Set(ids)] } }) : [];
    return new Map(list.map((u) => [u.id, u.name ?? u.email]));
  }

  private summary(s: AuditSampleDoc, names: Map<string, string>) {
    return {
      id: s.id,
      reference: `S-${String(s.number).padStart(3, '0')}`,
      name: s.name,
      population: s.population,
      populationLabel: POPULATION_WORDS[s.population],
      from: fromDbDate(s.from),
      to: fromDbDate(s.to),
      method: s.method,
      size: s.size,
      threshold: s.threshold,
      interval: s.interval,
      seed: s.seed,
      populationCount: s.populationCount,
      populationTotal: s.populationTotal,
      status: s.status,
      progress: sampleProgress(s.items),
      createdBy: { id: s.createdById, name: names.get(s.createdById) ?? 'A former member' },
      createdAt: s.createdAt.toISOString(),
      completedAt: s.completedAt?.toISOString() ?? null,
    };
  }

  async list() {
    const all = await this.store.collection(auditSamples).find({}, { sort: { number: -1 }, limit: 200 });
    const names = await this.names(all.map((s) => s.createdById));
    return { samples: all.map((s) => this.summary(s, names)), populations: POPULATION_WORDS };
  }

  /** One sample, with whether the books still give the same population and the same items. */
  async get(id: string) {
    const s = await this.sample(id);
    const names = await this.names([s.createdById, ...s.items.flatMap((i) => (i.testedById ? [i.testedById] : []))]);
    const now = await this.population(s.population, fromDbDate(s.from), fromDbDate(s.to));
    const fingerprint = populationFingerprint(now);
    const redrawn = drawSample(now, s.method, s.size, s.seed, s.threshold).items.map((i) => i.id);
    return {
      ...this.summary(s, names),
      populationChanged: fingerprint !== s.fingerprint,
      redrawMatches: redrawn.length === s.items.length && redrawn.every((x, i) => x === s.items[i]!.refId),
      items: s.items.map((i) => ({
        refId: i.refId,
        label: i.label,
        date: fromDbDate(i.date),
        amount: i.amount,
        reason: i.reason,
        result: i.result,
        note: i.note,
        testedBy: i.testedById ? { id: i.testedById, name: names.get(i.testedById) ?? 'A former member' } : null,
        testedAt: i.testedAt?.toISOString() ?? null,
      })),
    };
  }

  /** Draws and keeps a sample. */
  async draw(org: OrgContext, user: AuthUser, input: DrawInput) {
    if (input.to < input.from) throw new DomainError('INVALID_RANGE', 'The end date cannot be before the start date', HttpStatus.UNPROCESSABLE_ENTITY);
    if (input.method === 'HIGH_VALUE' && !input.threshold) throw new DomainError('THRESHOLD_REQUIRED', 'Give the amount at or above which every item is tested', HttpStatus.UNPROCESSABLE_ENTITY);
    const pop = await this.population(input.population, input.from, input.to);
    if (!pop.length) throw new DomainError('EMPTY_POPULATION', `No ${POPULATION_WORDS[input.population].toLowerCase()} are dated in that range`, HttpStatus.UNPROCESSABLE_ENTITY);
    if (pop.length > MAX_POPULATION) throw new DomainError('POPULATION_TOO_LARGE', `More than ${MAX_POPULATION} items: use a shorter range`, HttpStatus.UNPROCESSABLE_ENTITY);
    const seed = input.seed?.trim() || randomUUID();
    const threshold = input.method === 'HIGH_VALUE' ? new D(input.threshold!).toFixed(2) : null;
    const drawn = drawSample(pop, input.method, input.size, seed, threshold);
    if (!drawn.items.length) throw new DomainError('EMPTY_POPULATION', 'Every item in that range is zero', HttpStatus.UNPROCESSABLE_ENTITY);
    const total = pop.reduce((t, i) => t.plus(new D(i.amount).abs()), new D(0)).toFixed(2);
    const number = await this.store.nextTenantSequence('audit_sample');
    const doc = await this.store.collection(auditSamples).insertOne({
      number,
      name: input.name.trim(),
      population: input.population,
      from: toDbDate(input.from),
      to: toDbDate(input.to),
      method: input.method,
      size: input.size,
      seed,
      threshold,
      interval: drawn.interval,
      populationCount: pop.length,
      populationTotal: total,
      fingerprint: populationFingerprint(pop),
      items: drawn.items.map((i) => ({ refId: i.id, label: i.label, date: i.date, amount: i.amount, reason: i.reason, result: null, note: null, testedById: null, testedAt: null })),
      status: 'OPEN',
      createdById: user.id,
      createdAt: new Date(),
      completedAt: null,
    });
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, {
        orgId: org.id,
        actorId: user.id,
        action: 'audit_sample.drawn',
        entityType: 'audit_sample',
        entityId: doc.id,
        data: { number, population: input.population, from: input.from, to: input.to, method: input.method, size: input.size, seed, threshold, populationCount: pop.length, picked: doc.items.length },
      }),
    );
    return this.get(doc.id);
  }

  /** Records one item's result, once; the sample completes when every item is tested. */
  async record(org: OrgContext, user: AuthUser, id: string, refId: string, input: { result: 'OK' | 'EXCEPTION'; note?: string | null }) {
    const s = await this.sample(id);
    if (s.status === 'COMPLETED') throw new DomainError('SAMPLE_COMPLETED', 'This sample is complete', HttpStatus.CONFLICT);
    const idx = s.items.findIndex((i) => i.refId === refId);
    if (idx < 0) throw new DomainError('NOT_IN_SAMPLE', 'That item is not in this sample', HttpStatus.NOT_FOUND);
    if (s.items[idx]!.result) throw new DomainError('ALREADY_TESTED', 'That item was already tested', HttpStatus.CONFLICT);
    const note = input.note?.trim() || null;
    if (input.result === 'EXCEPTION' && (note?.length ?? 0) < 10) throw new DomainError('NOTE_REQUIRED', 'Say what was wrong, in at least 10 characters', HttpStatus.UNPROCESSABLE_ENTITY);
    const now = new Date();
    const r = await this.store.collection(auditSamples).updateOne(
      { id, status: 'OPEN', [`items.${idx}.result`]: null },
      { $set: { [`items.${idx}.result`]: input.result, [`items.${idx}.note`]: note, [`items.${idx}.testedById`]: user.id, [`items.${idx}.testedAt`]: now } },
    );
    if (!r.matched) throw new DomainError('ALREADY_TESTED', 'That item was already tested. Open the sample again.', HttpStatus.CONFLICT);
    // Completing is a separate step so two testers finishing the last items at once still complete it.
    const after = await this.sample(id);
    const done = after.items.every((i) => i.result) && (await this.store.collection(auditSamples).updateOne({ id, status: 'OPEN' }, { $set: { status: 'COMPLETED', completedAt: now } })).modified > 0;
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'audit_sample.item_tested', entityType: 'audit_sample', entityId: id, data: { refId, label: s.items[idx]!.label, result: input.result, note, completed: done } }),
    );
    return this.get(id);
  }
}
