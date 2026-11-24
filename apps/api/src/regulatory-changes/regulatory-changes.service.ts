import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { knownChange, regulatoryWatch, type ScheduledRateChange } from '@talk2tax/tax-engine';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { users } from '../db/collections/identity';
import { regulatoryChangeAcks } from '../db/collections/regulatory-changes';
import { taxRateVersions } from '../db/collections/tax-rate-versions';

/**
 * Regulatory change monitoring (TAX-046): the known law changes for the organisation's country,
 * coming up or recent, with the ones it has dealt with; the tax rules built into Talk2Tax with when
 * each was last checked; and the organisation's own scheduled tax rate changes. Talk2Tax does not
 * watch government websites, which the page says.
 */
@Injectable()
export class RegulatoryChangesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
    private readonly audit: AuditService,
  ) {}

  private async country(org: OrgContext) {
    return (await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { countryCode: true } })).countryCode;
  }

  /** Future rate versions, each with the rate it replaces. */
  private async rateChanges(org: OrgContext, today: string): Promise<ScheduledRateChange[]> {
    const versions = (await this.store.collection(taxRateVersions).find({ status: 'ACTIVE' })).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    const future = versions.filter((v) => v.effectiveFrom > today);
    if (!future.length) return [];
    const rates = new Map(
      (await this.prisma.taxRate.findMany({ where: { orgId: org.id, id: { in: [...new Set(future.map((v) => v.taxRateId))] } }, select: { id: true, name: true, rate: true } })).map((r) => [r.id, r]),
    );
    return future.flatMap((v) => {
      const r = rates.get(v.taxRateId);
      if (!r) return [];
      const before = versions.filter((x) => x.taxRateId === v.taxRateId && x.effectiveFrom < v.effectiveFrom).at(-1);
      return [{ taxRateId: v.taxRateId, name: r.name, from: before?.rate ?? r.rate.toFixed(), to: v.rate, effectiveFrom: v.effectiveFrom, reason: v.reason }];
    });
  }

  async overview(org: OrgContext) {
    const today = todayIso();
    const [country, acks, rateChanges] = await Promise.all([this.country(org), this.store.collection(regulatoryChangeAcks).find({}), this.rateChanges(org, today)]);
    const who = new Map((await this.store.collection(users).find({ id: { $in: [...new Set(acks.map((a) => a.acknowledgedById))] } })).map((u) => [u.id, u.name]));
    return {
      country,
      today,
      ...regulatoryWatch({
        country,
        today,
        rateChanges,
        acknowledgements: acks.map((a) => ({ changeKey: a.changeKey, note: a.note, by: who.get(a.acknowledgedById) ?? 'Former member', at: a.createdAt.toISOString() })),
      }),
    };
  }

  async acknowledge(org: OrgContext, user: AuthUser, key: string, note: string) {
    const change = knownChange(key);
    const country = await this.country(org);
    if (!change || change.country !== country) throw new NotFoundException({ error: 'NOT_FOUND', message: 'No such change for your country' });
    const col = this.store.collection(regulatoryChangeAcks);
    if (await col.findOne({ changeKey: key })) throw new DomainError('ALREADY_RECORDED', 'This change was already recorded as dealt with', HttpStatus.CONFLICT);
    await col.insertOne({ changeKey: key, note: note.trim() || null, acknowledgedById: user.id, createdAt: new Date() });
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, {
        orgId: org.id,
        actorId: user.id,
        action: 'regulatory_change.dealt_with',
        entityType: 'regulatory_change',
        entityId: key,
        data: { title: change.title, effectiveOn: change.effectiveOn, note: note.trim() || null },
      }),
    );
    return this.overview(org);
  }
}
