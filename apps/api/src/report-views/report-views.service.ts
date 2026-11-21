import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { normaliseViewFilters, resolveView, VIEW_REPORTS, viewFilterIssues, type ViewFilters, type ViewReport } from '@talk2tax/accounting-engine';
import { hasPermission } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { users } from '../db/collections/identity';
import { reportViews, type ReportViewDoc } from '../db/collections/report-views';
import { organizations } from '../db/collections/tenancy';

export interface ViewInput {
  name: string;
  report: ViewReport;
  filters: ViewFilters;
  shared: boolean;
}

/** Most views one person can keep for one report, so the list stays usable. */
export const MAX_VIEWS_PER_REPORT = 30;

/**
 * Saved report views (RPT-028, RPT-029, RPT-037). Anyone who can read reports saves views for
 * themselves and may share one with the organisation; a shared view is changed or removed only by
 * the person who saved it or an owner or admin. Opening a view resolves its period on the day.
 */
@Injectable()
export class ReportViewsService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private canChange(org: OrgContext, user: AuthUser, v: ReportViewDoc) {
    return v.ownerId === user.id || (v.shared && hasPermission(org.role, 'org.manage'));
  }

  private async serialize(org: OrgContext, user: AuthUser, list: ReportViewDoc[]) {
    const o = await this.store.collection(organizations).findById(org.id);
    const today = todayIso();
    const owners = new Map((await this.store.collection(users).find({ id: { $in: [...new Set(list.map((v) => v.ownerId))] } })).map((u) => [u.id, u.name]));
    return list.map((v) => ({
      id: v.id,
      name: v.name,
      report: v.report,
      reportTitle: VIEW_REPORTS[v.report as ViewReport]?.title ?? v.report,
      filters: v.filters,
      shared: v.shared,
      owner: { id: v.ownerId, name: owners.get(v.ownerId) ?? null },
      mine: v.ownerId === user.id,
      canChange: this.canChange(org, user, v),
      opensWith: resolveView(v.report as ViewReport, v.filters as unknown as ViewFilters, today, o?.fiscalYearStartMonth ?? 4),
      updatedAt: v.updatedAt.toISOString(),
    }));
  }

  /** The views this person can see: their own and the shared ones, for one report or all. */
  async list(org: OrgContext, user: AuthUser, report?: ViewReport) {
    const rows = await this.store.collection(reportViews).find({ ...(report ? { report } : {}), $or: [{ ownerId: user.id }, { shared: true }] }, { sort: { name: 1 } });
    return this.serialize(org, user, rows);
  }

  private async find(org: OrgContext, user: AuthUser, id: string) {
    const v = await this.store.collection(reportViews).findOne({ id });
    if (!v || (!v.shared && v.ownerId !== user.id)) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Saved view not found' });
    return v;
  }

  private check(input: ViewInput) {
    const issues = viewFilterIssues(input.report, input.filters);
    if (issues.length) throw new DomainError('VIEW_INVALID', issues[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    return normaliseViewFilters(input.report, input.filters);
  }

  async create(org: OrgContext, user: AuthUser, input: ViewInput) {
    const filters = this.check(input);
    const c = this.store.collection(reportViews);
    if ((await c.count({ report: input.report, ownerId: user.id })) >= MAX_VIEWS_PER_REPORT) throw new DomainError('TOO_MANY_VIEWS', `Keep at most ${MAX_VIEWS_PER_REPORT} views for one report; delete one first`);
    const now = new Date();
    const v = await c.insertOne({ name: input.name.trim(), report: input.report, filters: filters as unknown as Record<string, unknown>, shared: input.shared, ownerId: user.id, createdAt: now, updatedAt: now, updatedById: user.id });
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'report_view.saved', entityType: 'report_view', entityId: v.id, data: { name: v.name, report: v.report, shared: v.shared, filters } }));
    return (await this.serialize(org, user, [v]))[0]!;
  }

  async update(org: OrgContext, user: AuthUser, id: string, input: ViewInput) {
    const before = await this.find(org, user, id);
    if (!this.canChange(org, user, before)) throw new DomainError('FORBIDDEN', 'Only the person who saved this view, or an owner or admin, can change it', HttpStatus.FORBIDDEN);
    if (before.report !== input.report) throw new DomainError('VIEW_INVALID', 'A saved view keeps its report; save a new view for another report');
    const filters = this.check(input);
    const now = new Date();
    await this.store.collection(reportViews).updateOne({ id }, { $set: { name: input.name.trim(), filters: filters as unknown as Record<string, unknown>, shared: input.shared, updatedAt: now, updatedById: user.id } });
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'report_view.updated', entityType: 'report_view', entityId: id, data: { from: { name: before.name, shared: before.shared, filters: before.filters }, to: { name: input.name.trim(), shared: input.shared, filters } } }),
    );
    return (await this.serialize(org, user, [(await this.store.collection(reportViews).findOne({ id }))!]))[0]!;
  }

  async remove(org: OrgContext, user: AuthUser, id: string) {
    const v = await this.find(org, user, id);
    if (!this.canChange(org, user, v)) throw new DomainError('FORBIDDEN', 'Only the person who saved this view, or an owner or admin, can delete it', HttpStatus.FORBIDDEN);
    await this.store.collection(reportViews).deleteOne({ id });
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'report_view.deleted', entityType: 'report_view', entityId: id, data: { name: v.name, report: v.report, shared: v.shared, ownerId: v.ownerId } }));
  }
}
