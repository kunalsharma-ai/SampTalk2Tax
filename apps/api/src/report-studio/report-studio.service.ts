import { HttpStatus, Injectable } from '@nestjs/common';
import { isStudioReport, STUDIO_CATEGORIES, STUDIO_CATEGORY_NAME, STUDIO_REPORTS, studioTools } from '@talk2tax/accounting-engine';
import { hasPermission } from '@talk2tax/security';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { users } from '../db/collections/identity';
import { reportFavourites } from '../db/collections/report-favourites';
import { reportSchedules } from '../db/collections/report-schedules';
import { reportViews } from '../db/collections/report-views';

/**
 * The reporting studio (RPT-001): one place to find every report, see which of them this person
 * may open, the saved views and schedules each has, the designs built in the report designer,
 * the latest exports, and the reports this person pinned.
 */
@Injectable()
export class ReportStudioService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
  ) {}

  async studio(org: OrgContext, user: AuthUser) {
    const [favourites, views, schedules, designs, exports] = await Promise.all([
      this.store.collection(reportFavourites).find({ userId: user.id }, { sort: { createdAt: 1 } }),
      this.store.collection(reportViews).find({ $or: [{ ownerId: user.id }, { shared: true }] }),
      this.store.collection(reportSchedules).find({}),
      this.prisma.reportDesign.findMany({ where: { orgId: org.id }, orderBy: { number: 'asc' }, select: { id: true, name: true, updatedAt: true } }),
      this.prisma.auditEvent.findMany({
        where: { orgId: org.id, action: 'report.exported' },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, actorId: true, createdAt: true, data: true },
      }),
    ]);
    const pinned = new Set(favourites.map((f) => f.report));
    const count = <T extends { report: string }>(rows: T[], key: string) => rows.filter((r) => r.report === key).length;
    const reports = STUDIO_REPORTS.map((r) => ({
      key: r.key,
      name: r.name,
      category: r.category,
      question: r.question,
      href: r.href,
      exports: r.exports,
      ...studioTools(r.key),
      available: hasPermission(org.role, r.permission),
      favourite: pinned.has(r.key),
      views: count(views, r.key),
      schedules: count(
        schedules.filter((s) => s.isActive),
        r.key,
      ),
    }));
    const people = new Map((await this.store.collection(users).find({ id: { $in: [...new Set(exports.map((e) => e.actorId).filter((x): x is string => !!x))] } })).map((u) => [u.id, u.name]));
    const nameOf = new Map(STUDIO_REPORTS.map((r) => [r.key, r.name]));
    return {
      categories: STUDIO_CATEGORIES.map((c) => ({ key: c, name: STUDIO_CATEGORY_NAME[c], reports: reports.filter((r) => r.category === c).length })),
      reports,
      favourites: favourites.map((f) => f.report).filter((k) => isStudioReport(k)),
      totals: {
        reports: reports.length,
        available: reports.filter((r) => r.available).length,
        savedViews: views.length,
        schedules: schedules.filter((s) => s.isActive).length,
        designs: designs.length,
      },
      designs: designs.slice(0, 6).map((d) => ({ id: d.id, name: d.name, updatedAt: d.updatedAt.toISOString() })),
      recentExports: exports.map((e) => {
        const data = (e.data ?? {}) as { report?: string; format?: string; rows?: number };
        return {
          id: String(e.id),
          report: data.report ?? '',
          name: nameOf.get(data.report ?? '') ?? data.report ?? '',
          format: (data.format ?? '').toUpperCase(),
          rows: typeof data.rows === 'number' ? data.rows : null,
          by: e.actorId ? (people.get(e.actorId) ?? 'Former member') : null,
          at: e.createdAt.toISOString(),
        };
      }),
    };
  }

  private known(report: string) {
    if (!isStudioReport(report)) throw new DomainError('NOT_FOUND', 'There is no such report', HttpStatus.NOT_FOUND);
  }

  /** Pins a report to the top of this person's studio; pinning twice keeps one. */
  async pin(org: OrgContext, user: AuthUser, report: string) {
    this.known(report);
    const c = this.store.collection(reportFavourites);
    if (!(await c.findOne({ userId: user.id, report }))) await c.insertOne({ userId: user.id, report, createdAt: new Date() });
    return this.studio(org, user);
  }

  async unpin(org: OrgContext, user: AuthUser, report: string) {
    this.known(report);
    await this.store.collection(reportFavourites).deleteOne({ userId: user.id, report });
    return this.studio(org, user);
  }
}
