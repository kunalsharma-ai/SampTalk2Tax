import { HttpStatus, Injectable } from '@nestjs/common';
import { evaluateFlag, FEATURE_FLAGS, FlagKey, isFlagKey } from '@talk2tax/accounting-engine';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/decorators';
import { DomainError } from '../common/errors';
import { PrismaService, withSystemAccess } from '../common/prisma.service';

/** How long flag settings are reused before they are read again (a change shows within this). */
const CACHE_MS = 10_000;

type Snapshot = { at: number; settings: Map<string, { enabled: boolean; rolloutPercent: number }>; overrides: Map<string, boolean> };

/**
 * Feature flags (ADMIN-007). Declared in the engine with their defaults; administrators turn a
 * flag off for everyone, roll it out to a share of organisations, or set it for one organisation.
 * The API refuses a route behind a flag that is off (403 FEATURE_OFF) and the menus hide it.
 */
@Injectable()
export class FlagsService {
  private cache: Snapshot | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async snapshot(): Promise<Snapshot> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache;
    const [flags, overrides] = await this.prisma.$transaction(async (tx) =>
      withSystemAccess(tx, async () => Promise.all([tx.featureFlag.findMany(), tx.featureFlagOverride.findMany({ select: { flagKey: true, orgId: true, enabled: true } })])),
    );
    this.cache = {
      at: Date.now(),
      settings: new Map(flags.map((f) => [f.key, { enabled: f.enabled, rolloutPercent: f.rolloutPercent }])),
      overrides: new Map(overrides.map((o) => [`${o.flagKey}:${o.orgId}`, o.enabled])),
    };
    return this.cache;
  }

  private evaluate(s: Snapshot, key: FlagKey, orgId: string) {
    const def = FEATURE_FLAGS.find((f) => f.key === key)!;
    return evaluateFlag(def, s.settings.get(key) ?? null, orgId, s.overrides.get(`${key}:${orgId}`) ?? null);
  }

  async isOn(key: FlagKey, orgId: string): Promise<boolean> {
    return this.evaluate(await this.snapshot(), key, orgId).on;
  }

  /** Every flag for one organisation, for its menus. */
  async forOrg(orgId: string): Promise<Record<string, boolean>> {
    const s = await this.snapshot();
    return Object.fromEntries(FEATURE_FLAGS.map((f) => [f.key, this.evaluate(s, f.key, orgId).on]));
  }

  /** Every flag with its setting, its overrides and how many organisations it is on for. */
  async list() {
    return this.prisma.$transaction(async (tx) =>
      withSystemAccess(tx, async () => {
        const [flags, overrides, orgs] = await Promise.all([
          tx.featureFlag.findMany(),
          tx.featureFlagOverride.findMany({ orderBy: { createdAt: 'desc' } }),
          tx.organization.findMany({ select: { id: true, name: true } }),
        ]);
        const people = await tx.user.findMany({ where: { id: { in: [...new Set([...flags.map((f) => f.updatedBy), ...overrides.map((o) => o.createdBy)])] } }, select: { id: true, name: true } });
        const who = (id: string) => people.find((p) => p.id === id)?.name ?? null;
        return FEATURE_FLAGS.map((def) => {
          const row = flags.find((f) => f.key === def.key) ?? null;
          const own = overrides.filter((o) => o.flagKey === def.key);
          const on = orgs.filter((o) => evaluateFlag(def, row, o.id, own.find((x) => x.orgId === o.id)?.enabled ?? null).on).length;
          return {
            ...def,
            setting: row ? { enabled: row.enabled, rolloutPercent: row.rolloutPercent, note: row.note, updatedBy: who(row.updatedBy), updatedAt: row.updatedAt } : null,
            overrides: own.map((o) => ({ orgId: o.orgId, orgName: orgs.find((x) => x.id === o.orgId)?.name ?? null, enabled: o.enabled, reason: o.reason, createdBy: who(o.createdBy), createdAt: o.createdAt })),
            organisations: { on, total: orgs.length },
          };
        });
      }),
    );
  }

  private key(k: string): FlagKey {
    if (!isFlagKey(k)) throw new DomainError('NOT_FOUND', 'There is no feature flag with this key', HttpStatus.NOT_FOUND);
    return k;
  }

  async set(actor: AuthUser, k: string, input: { enabled: boolean; rolloutPercent: number; note?: string | null }) {
    const key = this.key(k);
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.featureFlag.findUnique({ where: { key } });
      const data = { enabled: input.enabled, rolloutPercent: input.rolloutPercent, note: input.note?.trim() || null, updatedBy: actor.id, updatedAt: new Date() };
      if (before) await tx.featureFlag.update({ where: { key }, data });
      else await tx.featureFlag.create({ data: { key, ...data } });
      await this.audit.append(tx, { orgId: null, actorId: actor.id, action: 'platform.flag_changed', entityType: 'feature_flag', entityId: null, data: { key, before: before ? { enabled: before.enabled, rolloutPercent: before.rolloutPercent } : 'default', after: { enabled: input.enabled, rolloutPercent: input.rolloutPercent } } });
    });
    this.cache = null;
    return (await this.list()).find((f) => f.key === key);
  }

  /** Back to the flag's default. */
  async reset(actor: AuthUser, k: string) {
    const key = this.key(k);
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.featureFlag.findUnique({ where: { key } });
      if (!before) return;
      await tx.featureFlag.delete({ where: { key } });
      await this.audit.append(tx, { orgId: null, actorId: actor.id, action: 'platform.flag_reset', entityType: 'feature_flag', entityId: null, data: { key, before: { enabled: before.enabled, rolloutPercent: before.rolloutPercent } } });
    });
    this.cache = null;
    return (await this.list()).find((f) => f.key === key);
  }

  async override(actor: AuthUser, k: string, orgId: string, input: { enabled: boolean; reason: string }) {
    const key = this.key(k);
    await this.prisma.$transaction(async (tx) =>
      withSystemAccess(tx, async () => {
        const org = await tx.organization.findUnique({ where: { id: orgId }, select: { id: true } });
        if (!org) throw new DomainError('NOT_FOUND', 'Organization not found', HttpStatus.NOT_FOUND);
        const existing = await tx.featureFlagOverride.findUnique({ where: { flagKey_orgId: { flagKey: key, orgId } } });
        if (existing) await tx.featureFlagOverride.update({ where: { flagKey_orgId: { flagKey: key, orgId } }, data: { enabled: input.enabled, reason: input.reason.trim(), createdBy: actor.id, createdAt: new Date() } });
        else await tx.featureFlagOverride.create({ data: { flagKey: key, orgId, enabled: input.enabled, reason: input.reason.trim(), createdBy: actor.id } });
        // In the organisation's own audit trail too, so its owners can see why a module changed.
        await this.audit.append(tx, { orgId, actorId: actor.id, action: 'platform.flag_override_set', entityType: 'feature_flag', entityId: null, data: { key, enabled: input.enabled, reason: input.reason.trim() } });
      }),
    );
    this.cache = null;
    return (await this.list()).find((f) => f.key === key);
  }

  async removeOverride(actor: AuthUser, k: string, orgId: string) {
    const key = this.key(k);
    await this.prisma.$transaction(async (tx) =>
      withSystemAccess(tx, async () => {
        const existing = await tx.featureFlagOverride.findUnique({ where: { flagKey_orgId: { flagKey: key, orgId } } });
        if (!existing) throw new DomainError('NOT_FOUND', 'This organisation has no setting of its own for this flag', HttpStatus.NOT_FOUND);
        await tx.featureFlagOverride.delete({ where: { flagKey_orgId: { flagKey: key, orgId } } });
        await this.audit.append(tx, { orgId, actorId: actor.id, action: 'platform.flag_override_removed', entityType: 'feature_flag', entityId: null, data: { key, was: existing.enabled } });
      }),
    );
    this.cache = null;
    return (await this.list()).find((f) => f.key === key);
  }
}
