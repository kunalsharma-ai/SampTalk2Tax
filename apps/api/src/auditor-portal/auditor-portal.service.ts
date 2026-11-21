import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { AUDITOR_PORTAL_TOKEN_PATTERN, auditorPortalTokenPrefix, engagementProgress, makeAuditorPortalToken, MAX_ACTIVE_AUDITOR_LINKS, portalLinkState, sampleProgress } from '@talk2tax/accounting-engine';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { fromDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { enterOrg, runAsSystem } from '../common/tenant-context';
import { auditEngagements, type AuditEngagementDoc } from '../db/collections/audit-engagements';
import { auditEvidenceRequests } from '../db/collections/audit-evidence';
import { auditFindings } from '../db/collections/audit-findings';
import { auditSamples } from '../db/collections/audit-samples';
import { auditorPortalLinks } from '../db/collections/auditor-portal';
import { users } from '../db/collections/identity';
import { attachments } from '../db/collections/sales';
import { organizations } from '../db/collections/tenancy';
import { FileVault } from '../files/file-vault';
import { RegionsService } from '../regions/regions.service';
import { ReportsService } from '../reports/reports.service';

const DAY = 86_400_000;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const ref = (prefix: string, n: number) => `${prefix}-${String(n).padStart(3, '0')}`;

/**
 * External auditor portal (AUDIT-002). Owners and admins give a named external auditor a private,
 * read-only link to one internal audit engagement; it always expires and can be withdrawn. The
 * auditor sees the engagement's scope, work programme and sign-offs, its accepted evidence (and can
 * open those files), linked findings and samples, and the trial balance at the end of the scope.
 * Unaccepted evidence and anything outside the engagement stay hidden. Opening a file is audited.
 */
@Injectable()
export class AuditorPortalService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly reports: ReportsService,
    private readonly regions: RegionsService,
    private readonly vault: FileVault,
  ) {}

  private async names(ids: (string | null)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    return new Map((list.length ? await this.store.collection(users).find({ id: { $in: list } }) : []).map((u) => [u.id, u.name ?? u.email]));
  }

  private async engagement(id: string) {
    const e = await this.store.collection(auditEngagements).findById(id);
    if (!e) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Engagement not found' });
    return e;
  }

  // ------------------------------------------------------------------ staff

  /** The auditor links made for an engagement, newest first. */
  async links(engagementId: string) {
    await this.engagement(engagementId);
    const list = await this.store.collection(auditorPortalLinks).find({ engagementId }, { sort: { createdAt: -1 } });
    const names = await this.names(list.flatMap((l) => [l.createdById, l.revokedById]));
    const now = new Date();
    return list.map((l) => ({
      id: l.id,
      auditorName: l.auditorName,
      firm: l.firm,
      prefix: l.prefix,
      state: portalLinkState(l, now),
      expiresAt: l.expiresAt.toISOString(),
      createdBy: names.get(l.createdById) ?? 'A former member',
      createdAt: l.createdAt.toISOString(),
      lastSeenAt: l.lastSeenAt?.toISOString() ?? null,
      viewCount: l.viewCount,
      filesOpened: l.filesOpened,
      revokedAt: l.revokedAt?.toISOString() ?? null,
      revokedBy: l.revokedById ? (names.get(l.revokedById) ?? 'A former member') : null,
    }));
  }

  /** Makes a link. The secret is returned this once and never again. */
  async createLink(org: OrgContext, user: AuthUser, engagementId: string, input: { auditorName: string; firm?: string | null; expiresInDays: number }) {
    await this.engagement(engagementId);
    const now = new Date();
    const live = await this.store.collection(auditorPortalLinks).count({ engagementId, revokedAt: null, expiresAt: { $gt: now } });
    if (live >= MAX_ACTIVE_AUDITOR_LINKS) throw new DomainError('TOO_MANY_LINKS', `An engagement has at most ${MAX_ACTIVE_AUDITOR_LINKS} live auditor links; withdraw one first`, HttpStatus.CONFLICT);
    const token = makeAuditorPortalToken((n) => randomBytes(n));
    const doc = await this.store.collection(auditorPortalLinks).insertOne({
      engagementId,
      auditorName: input.auditorName.trim(),
      firm: input.firm?.trim() || null,
      prefix: auditorPortalTokenPrefix(token),
      tokenHash: hash(token),
      expiresAt: new Date(now.getTime() + input.expiresInDays * DAY),
      createdById: user.id,
      createdAt: now,
      revokedAt: null,
      revokedById: null,
      lastSeenAt: null,
      viewCount: 0,
      filesOpened: 0,
    });
    // The audit trail names the link by its prefix; the secret is never recorded.
    await this.log(org.id, user.id, 'auditor_portal.link_created', doc.id, { engagementId, auditorName: doc.auditorName, firm: doc.firm, prefix: doc.prefix, expiresAt: doc.expiresAt.toISOString() });
    return { id: doc.id, prefix: doc.prefix, token, path: `/auditor-portal/${token}`, expiresAt: doc.expiresAt.toISOString() };
  }

  async revokeLink(org: OrgContext, user: AuthUser, engagementId: string, linkId: string) {
    const l = await this.store.collection(auditorPortalLinks).findOne({ id: linkId, engagementId });
    if (!l) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Auditor link not found' });
    if (l.revokedAt) throw new DomainError('ALREADY_REVOKED', 'This link is already withdrawn', HttpStatus.CONFLICT);
    const r = await this.store.collection(auditorPortalLinks).updateOne({ id: l.id, revokedAt: null }, { $set: { revokedAt: new Date(), revokedById: user.id } });
    if (!r.matched) throw new DomainError('ALREADY_REVOKED', 'This link is already withdrawn', HttpStatus.CONFLICT);
    await this.log(org.id, user.id, 'auditor_portal.link_revoked', l.id, { engagementId, prefix: l.prefix });
    return this.links(engagementId);
  }

  // ------------------------------------------------------------------ the portal (no sign-in)

  /** Finds the live link for a token across organisations, then narrows the request to its organisation. */
  private async open(token: string, count: 'view' | 'file' | null) {
    const invalid = (message = 'This link is not valid. Ask the organisation that sent it for a new one.') => new DomainError('PORTAL_LINK_INVALID', message, HttpStatus.NOT_FOUND);
    if (!AUDITOR_PORTAL_TOKEN_PATTERN.test(token)) throw invalid();
    const found = await runAsSystem(async () => {
      const l = await this.store.collection(auditorPortalLinks).findOne({ tokenHash: hash(token) });
      if (!l) return null;
      const org = await this.store.collection(organizations).findById(l.orgId);
      return org ? { l, org } : null;
    });
    if (!found) throw invalid();
    const { l, org } = found;
    const state = portalLinkState(l, new Date());
    if (state === 'REVOKED') throw invalid(`${org.name} has withdrawn this link.`);
    if (state === 'EXPIRED') throw invalid(`This link from ${org.name} has expired. Ask them for a new one.`);
    if (org.suspendedAt) throw invalid(`${org.name}'s portal is not available right now.`);
    this.regions.assertHere(org.dataRegion);
    enterOrg(org.id);
    const e = await this.store.collection(auditEngagements).findById(l.engagementId);
    if (!e) throw invalid();
    if (count) await this.store.collection(auditorPortalLinks).updateOne({ id: l.id }, count === 'view' ? { $set: { lastSeenAt: new Date() }, $inc: { viewCount: 1 } } : { $inc: { filesOpened: 1 } });
    return { link: l, org, engagement: e };
  }

  /** Everything the auditor may see, read-only. */
  async overview(token: string) {
    const { link, org, engagement: e } = await this.open(token, 'view');
    const [evidence, findings, samples] = await Promise.all([
      this.store.collection(auditEvidenceRequests).find({ engagementId: e.id, status: 'ACCEPTED' }, { sort: { number: 1 } }),
      e.findingIds.length ? this.store.collection(auditFindings).find({ id: { $in: e.findingIds } }, { sort: { number: 1 } }) : [],
      e.sampleIds.length ? this.store.collection(auditSamples).find({ id: { $in: e.sampleIds } }, { sort: { number: 1 } }) : [],
    ]);
    const names = await this.names([e.leadId, e.reviewerId, ...e.steps.flatMap((s) => [s.doneById, s.signedOffById]), ...evidence.flatMap((r) => [r.submittedById, r.acceptedById])]);
    const who = (id: string | null) => (id ? (names.get(id) ?? 'A former member') : null);
    const through = fromDbDate(e.scopeTo);
    const tb = await this.reports.trialBalance(org.id, { asOf: through });
    return {
      organisation: { name: org.name, legalName: org.legalName },
      auditor: { name: link.auditorName, firm: link.firm },
      link: { expiresAt: link.expiresAt.toISOString() },
      engagement: this.engagementView(e, who),
      evidence: evidence.map((r) => ({
        reference: ref('ER', r.number),
        title: r.title,
        details: r.details,
        submittedBy: who(r.submittedById),
        submittedAt: r.submittedAt?.toISOString() ?? null,
        acceptedBy: who(r.acceptedById),
        acceptedAt: r.acceptedAt?.toISOString() ?? null,
        files: r.files,
      })),
      findings: findings.map((f) => ({ reference: ref('F', f.number), title: f.title, description: f.description, severity: f.severity, status: f.status, plan: f.plan, dueDate: fromDbDate(f.dueDate) })),
      samples: samples.map((s) => ({ reference: ref('S', s.number), name: s.name, method: s.method, population: s.population, from: fromDbDate(s.from), to: fromDbDate(s.to), seed: s.seed, populationCount: s.populationCount, populationTotal: s.populationTotal, status: s.status, progress: sampleProgress(s.items) })),
      trialBalance: { currency: tb.currency, asOf: tb.asOf, balanced: tb.balanced, totals: tb.totals, rows: tb.rows.map((r) => ({ code: r.code, name: r.name, type: r.type, netDebit: r.netDebit, netCredit: r.netCredit })) },
    };
  }

  private engagementView(e: AuditEngagementDoc, who: (id: string | null) => string | null) {
    return {
      reference: ref('IA', e.number),
      name: e.name,
      objective: e.objective,
      scopeFrom: fromDbDate(e.scopeFrom),
      scopeTo: fromDbDate(e.scopeTo),
      status: e.status,
      lead: who(e.leadId),
      reviewer: who(e.reviewerId),
      progress: engagementProgress(e.steps),
      steps: e.steps.map((s) => ({ title: s.title, status: s.status, work: s.status === 'OPEN' ? null : s.work, doneBy: who(s.doneById), doneAt: s.doneAt?.toISOString() ?? null, signedOffBy: who(s.signedOffById), signedOffAt: s.signedOffAt?.toISOString() ?? null })),
      conclusion: e.conclusion,
      closedAt: e.closedAt?.toISOString() ?? null,
    };
  }

  /** A file of accepted evidence on the engagement; nothing else can be opened. */
  async file(token: string, attachmentId: string) {
    const { link, org, engagement } = await this.open(token, null);
    const owner = await this.store.collection(auditEvidenceRequests).findOne({ engagementId: engagement.id, status: 'ACCEPTED', 'files.attachmentId': attachmentId });
    if (!owner) throw new NotFoundException({ error: 'NOT_FOUND', message: 'File not found' });
    const a = await this.store.collection(attachments).findById(attachmentId);
    if (!a || a.entityType !== 'AUDIT_EVIDENCE' || a.entityId !== owner.id) throw new NotFoundException({ error: 'NOT_FOUND', message: 'File not found' });
    const content = this.vault.open(a.content, a.contentKeyId, a.sha256);
    await this.store.collection(auditorPortalLinks).updateOne({ id: link.id }, { $inc: { filesOpened: 1 } });
    await this.log(org.id, null, 'auditor_portal.file_opened', link.id, { prefix: link.prefix, auditorName: link.auditorName, evidence: ref('ER', owner.number), attachmentId, fileName: a.fileName, sha256: a.sha256 });
    return { fileName: a.fileName, contentType: a.contentType, sizeBytes: a.sizeBytes, content };
  }

  private log(orgId: string, actorId: string | null, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId, action, entityType: 'auditor_portal_link', entityId, data }));
  }
}
