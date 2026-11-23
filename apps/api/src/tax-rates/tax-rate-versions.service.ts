import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { dec, nextRateChange, type RateVersion, rateEffectiveOn, rateTimeline, rateVersionIssues } from '@talk2tax/accounting-engine';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/decorators';
import { todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { expenseClaims } from '../db/collections/expenses';
import { users } from '../db/collections/identity';
import { documents } from '../db/collections/sales';
import { taxRateVersions } from '../db/collections/tax-rate-versions';

/**
 * Effective-dated, version-controlled tax rates (TAX-003). A rate keeps its original percentage as
 * version 1; later versions take effect from their dates. Documents use the rate in force on their
 * issue date and expense claim lines the rate on the line's date, so a change never alters what is
 * already recorded. Versions are appended in date order and never reach back past posted use; a
 * scheduled version can be withdrawn before it takes effect. accounts.read to read;
 * accounts.manage to change; every change is audited.
 */
@Injectable()
export class TaxRateVersionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly store: DocumentStoreService,
  ) {}

  /** Active versions for these rates (the tenant comes from the request). */
  async versionsFor(ids: readonly string[]): Promise<Map<string, RateVersion[]>> {
    const out = new Map<string, RateVersion[]>(ids.map((id) => [id, []]));
    if (!ids.length) return out;
    for (const v of await this.store.collection(taxRateVersions).find({ taxRateId: { $in: [...ids] }, status: 'ACTIVE' })) out.get(v.taxRateId)?.push({ effectiveFrom: v.effectiveFrom, rate: v.rate });
    return out;
  }

  /** Each rate's percentage on `date`, with the next change after it. */
  async ratesOn<T extends { id: string; rate: { toFixed(): string } }>(rates: readonly T[], date: string) {
    const versions = await this.versionsFor(rates.map((r) => r.id));
    return new Map(rates.map((r) => [r.id, { rate: rateEffectiveOn(r.rate.toFixed(), versions.get(r.id) ?? [], date), versions: versions.get(r.id) ?? [], next: nextRateChange(versions.get(r.id) ?? [], date) }]));
  }

  private async rate(orgId: string, id: string) {
    const t = await this.prisma.taxRate.findFirst({ where: { id, orgId } });
    if (!t) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Tax rate not found' });
    return t;
  }

  async history(orgId: string, id: string, today = todayIso()) {
    const t = await this.rate(orgId, id);
    const rows = (await this.store.collection(taxRateVersions).find({ taxRateId: id })).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.createdAt.getTime() - b.createdAt.getTime());
    const active = rows.filter((r) => r.status === 'ACTIVE');
    const who = new Map((await this.store.collection(users).find({ id: { $in: [...new Set(rows.flatMap((r) => [r.createdById, r.withdrawnById]).filter((x): x is string => !!x))] } })).map((u) => [u.id, u.name]));
    const name = (x: string | null) => (x ? (who.get(x) ?? 'Former member') : null);
    const timeline = rateTimeline(t.rate.toFixed(), active, today);
    return {
      id: t.id,
      name: t.name,
      kind: t.kind,
      gstCategory: t.gstCategory,
      originalRate: t.rate.toFixed(),
      createdAt: t.createdAt.toISOString(),
      rateToday: rateEffectiveOn(t.rate.toFixed(), active, today),
      next: nextRateChange(active, today),
      canChange: !(t.kind === 'GST' && t.gstCategory !== 'TAXABLE'),
      timeline: timeline.map((e, i) => {
        const row = i === 0 ? null : active[i - 1]!;
        return { ...e, id: row?.id ?? null, reason: row?.reason ?? null, recordedBy: row ? name(row.createdById) : null, recordedAt: row?.createdAt.toISOString() ?? null, canWithdraw: !!row && e.state === 'SCHEDULED' };
      }),
      withdrawn: rows.filter((r) => r.status === 'WITHDRAWN').map((r) => ({ id: r.id, rate: r.rate, effectiveFrom: r.effectiveFrom, reason: r.reason, withdrawnReason: r.withdrawnReason, withdrawnBy: name(r.withdrawnById), withdrawnAt: r.withdrawnAt!.toISOString() })),
    };
  }

  /** Posted documents and approved claims using the rate dated on or after `date`. */
  private async usedOnOrAfter(id: string, date: string) {
    const [docs, claims] = await Promise.all([
      this.store.collection(documents).count({ status: 'POSTED', issueDate: { $gte: toDbDate(date) }, 'lines.taxRateId': id }),
      this.store.collection(expenseClaims).count({ status: { $in: ['APPROVED', 'REIMBURSED'] }, lines: { $elemMatch: { taxRateId: id, date: { $gte: toDbDate(date) } } } }),
    ]);
    return docs + claims; // not money
  }

  async add(orgId: string, user: AuthUser, id: string, input: { rate: string; effectiveFrom: string; reason: string }, today = todayIso()) {
    const t = await this.rate(orgId, id);
    if (!t.isActive) throw new DomainError('RATE_INACTIVE', 'Reactivate the rate before changing it', HttpStatus.CONFLICT);
    const versions = (await this.versionsFor([id])).get(id)!;
    const issues = rateVersionIssues({ baseRate: t.rate.toFixed(), fixedAtZero: t.kind === 'GST' && t.gstCategory !== 'TAXABLE', versions, usedOnOrAfter: await this.usedOnOrAfter(id, input.effectiveFrom) }, input);
    if (issues.length) throw new DomainError('VERSION_INVALID', issues.join(' '), HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    const v = await this.store.collection(taxRateVersions).insertOne({ taxRateId: id, rate: dec(input.rate).toFixed(), effectiveFrom: input.effectiveFrom, reason: input.reason.trim(), status: 'ACTIVE', withdrawnReason: null, withdrawnById: null, withdrawnAt: null, createdById: user.id, createdAt: new Date() });
    await this.log(orgId, user, 'tax_rate.version_added', id, { versionId: v.id, name: t.name, from: rateEffectiveOn(t.rate.toFixed(), versions, input.effectiveFrom), to: v.rate, effectiveFrom: v.effectiveFrom, backdated: v.effectiveFrom < today, reason: v.reason });
    return this.history(orgId, id, today);
  }

  async withdraw(orgId: string, user: AuthUser, id: string, versionId: string, reason: string, today = todayIso()) {
    const t = await this.rate(orgId, id);
    const v = await this.store.collection(taxRateVersions).findOne({ id: versionId, taxRateId: id });
    if (!v) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Rate version not found' });
    if (v.status === 'WITHDRAWN') throw new DomainError('ALREADY_WITHDRAWN', 'This version is already withdrawn', HttpStatus.CONFLICT);
    if (v.effectiveFrom <= today) throw new DomainError('VERSION_IN_EFFECT', `This version took effect on ${v.effectiveFrom}; add a new version instead`, HttpStatus.CONFLICT);
    const r = await this.store.collection(taxRateVersions).updateOne({ id: v.id, status: 'ACTIVE' }, { $set: { status: 'WITHDRAWN', withdrawnReason: reason.trim(), withdrawnById: user.id, withdrawnAt: new Date() } });
    if (!r.matched) throw new DomainError('CHANGED', 'The version changed meanwhile; reload and try again', HttpStatus.CONFLICT);
    await this.log(orgId, user, 'tax_rate.version_withdrawn', id, { versionId: v.id, name: t.name, rate: v.rate, effectiveFrom: v.effectiveFrom, reason: reason.trim() });
    return this.history(orgId, id, today);
  }

  private log(orgId: string, user: AuthUser, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId: user.id, action, entityType: 'tax_rate', entityId, data }));
  }
}
