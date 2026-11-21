import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ACCOUNTING_FRAMEWORKS,
  agentOnFor,
  AI_PREFERENCES,
  BUSINESS_SIZES,
  canActivate,
  INDUSTRIES,
  setupChecks,
  suggestSetup,
  type AccountingFramework,
  type AiPreference,
  type BusinessSize,
  type Industry,
  type SetupProfile,
} from '@talk2tax/accounting-engine';
import { hasPermission } from '@talk2tax/security';
import { AGENT_KEYS, AGENTS, AiControlService } from '../ai-control/ai-control.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runInOrg } from '../common/tenant-context';
import { accounts, fiscalPeriods } from '../db/collections/chart';
import { orgSetup, type OrgSetupDoc } from '../db/collections/org-setup';
import { approvalPolicies } from '../db/collections/sales';
import { memberships, organizations } from '../db/collections/tenancy';
import { OpeningBalancesService } from '../opening-balances/opening-balances.service';
import { MailerService } from '../workflows/email';

export interface ProfileInput {
  industry: Industry;
  size: BusinessSize;
  framework: AccountingFramework;
  aiPreference: AiPreference;
}

/**
 * Organisation setup (UX-004 to UX-006, UX-014, UX-017 to UX-019): the business profile, the
 * checks that say whether the books are ready, and activation once every required one is done.
 */
@Injectable()
export class SetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
    private readonly audit: AuditService,
    private readonly ai: AiControlService,
    private readonly opening: OpeningBalancesService,
    private readonly mailer: MailerService,
  ) {}

  private record(orgId: string) {
    return runInOrg(orgId, () => this.store.collection(orgSetup).findOne({}));
  }

  private profileOf(doc: OrgSetupDoc | null): SetupProfile {
    return {
      industry: (doc?.industry ?? null) as Industry | null,
      size: (doc?.size ?? null) as BusinessSize | null,
      framework: (doc?.framework ?? null) as AccountingFramework | null,
      aiPreference: (doc?.aiPreference ?? null) as AiPreference | null,
    };
  }

  async overview(org: OrgContext) {
    const [doc, o] = await Promise.all([this.record(org.id), this.store.collection(organizations).findById(org.id)]);
    const countryCode = o?.countryCode ?? 'IN';
    const profile = this.profileOf(doc);
    const [periods, banks, members, rules, gst, taxRates, customers, vendors, ob, mail] = await Promise.all([
      runInOrg(org.id, () => this.store.collection(fiscalPeriods).count({ status: 'OPEN' })),
      runInOrg(org.id, () => this.store.collection(accounts).count({ subtype: 'BANK', isActive: true })),
      runInOrg(org.id, () => this.store.collection(memberships).count({})),
      runInOrg(org.id, () => this.store.collection(approvalPolicies).count({ isActive: true })),
      countryCode === 'IN' ? this.prisma.gstRegistration.findUnique({ where: { orgId: org.id } }) : Promise.resolve(null),
      this.prisma.taxRate.count({ where: { orgId: org.id, isActive: true } }),
      this.prisma.contact.count({ where: { orgId: org.id, isCustomer: true, isActive: true } }),
      this.prisma.contact.count({ where: { orgId: org.id, isVendor: true, isActive: true } }),
      this.opening.get(org),
      this.mailer.status(org.id),
    ]);
    const checks = setupChecks({
      countryCode,
      profile,
      fiscalPeriods: periods,
      bankAccounts: banks,
      taxConfigured: countryCode === 'IN' ? !!gst : taxRates > 0,
      openingBalancesPosted: !!ob.current,
      customers,
      vendors,
      members,
      approvalRules: rules,
      mailReady: mail.ready,
    });
    const frameworks = ACCOUNTING_FRAMEWORKS.filter((f) => !f.countries.length || (f.countries as readonly string[]).includes(countryCode));
    return {
      countryCode,
      canManage: hasPermission(org.role, 'org.manage'),
      profile,
      suggestion: suggestSetup(countryCode, profile),
      /** The suggestion for each size, so the page can follow the size being chosen before it is saved. */
      suggestionsBySize: Object.fromEntries(BUSINESS_SIZES.map((s) => [s.key, suggestSetup(countryCode, { industry: profile.industry, size: s.key })])),
      options: {
        industries: INDUSTRIES.map((i) => ({ id: i.key, name: i.label })),
        sizes: BUSINESS_SIZES.map((s) => ({ id: s.key, name: s.label })),
        frameworks: frameworks.map((f) => ({ id: f.id, name: f.name })),
        aiPreferences: AI_PREFERENCES,
      },
      checks,
      activation: { ...canActivate(checks), activatedAt: doc?.activatedAt?.toISOString() ?? null, activatedById: doc?.activatedById ?? null },
    };
  }

  /** Saves the profile; a new AI preference turns agents on or off by their action level, keeping their budgets. */
  async saveProfile(org: OrgContext, user: AuthUser, input: ProfileInput) {
    const o = await this.store.collection(organizations).findById(org.id);
    if (!ACCOUNTING_FRAMEWORKS.some((f) => f.id === input.framework && (!f.countries.length || (f.countries as readonly string[]).includes(o?.countryCode ?? '')))) {
      throw new DomainError('INVALID_FRAMEWORK', `${input.framework} is not offered for this organisation's country`);
    }
    const before = await this.record(org.id);
    const now = new Date();
    const c = this.store.collection(orgSetup);
    const set = { industry: input.industry, size: input.size, framework: input.framework, aiPreference: input.aiPreference, updatedById: user.id, updatedAt: now };
    if (before) await runInOrg(org.id, () => c.updateOne({ id: before.id }, { $set: set }));
    else await runInOrg(org.id, () => c.insertOne({ ...set, activatedAt: null, activatedById: null, createdAt: now }));
    if (before?.aiPreference !== input.aiPreference) {
      for (const agent of AGENT_KEYS) {
        const current = await this.prisma.aiAgentSetting.findUnique({ where: { orgId_agent: { orgId: org.id, agent } } });
        const enabled = agentOnFor(input.aiPreference, AGENTS[agent].level);
        if ((current?.enabled ?? true) !== enabled) await this.ai.updateAgent({ orgId: org.id, role: org.role }, user, agent, { enabled, monthlyTokenLimit: current?.monthlyTokenLimit ?? null });
      }
    }
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'setup.profile_saved', entityType: 'org_setup', entityId: org.id, data: { from: this.profileOf(before), to: input } }),
    );
    return this.overview(org);
  }

  /** Records that the organisation is set up (UX-019): every required check must be done. */
  async activate(org: OrgContext, user: AuthUser) {
    const view = await this.overview(org);
    if (view.activation.activatedAt) throw new DomainError('ALREADY_ACTIVE', 'This organisation is already active', HttpStatus.CONFLICT);
    if (!view.activation.ok) throw new DomainError('SETUP_INCOMPLETE', `Finish these first: ${view.activation.missing.join(', ')}`, HttpStatus.UNPROCESSABLE_ENTITY, { missing: view.activation.missing });
    const doc = await this.record(org.id);
    const now = new Date();
    await runInOrg(org.id, () => this.store.collection(orgSetup).updateOne({ id: doc!.id }, { $set: { activatedAt: now, activatedById: user.id, updatedById: user.id, updatedAt: now } }));
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, {
        orgId: org.id,
        actorId: user.id,
        action: 'setup.activated',
        entityType: 'org_setup',
        entityId: org.id,
        data: { checks: view.checks.map((c) => ({ id: c.id, status: c.status, required: c.required })) },
      }),
    );
    return this.overview(org);
  }
}
