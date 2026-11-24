import { Controller, Get, Param, Query } from '@nestjs/common';
import { DASHBOARD_ROLES, ROLE_DASHBOARDS, type DashboardRole } from '@talk2tax/accounting-engine';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { DepartmentPerformanceService } from './department-performance.service';
import { FinancialDependenciesService } from './financial-dependencies.service';
import { FinancialTimelineService } from './financial-timeline.service';
import { FinancialVisualsService } from './financial-visuals.service';
import { RiskMonitorService } from './risk-monitor.service';
import { RoleDashboardsService } from './role-dashboards.service';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const Period = z.object({ from: month.optional(), to: month.optional() }).strict();

@ApiTags('reports')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/reports/visuals')
export class FinancialVisualsController {
  constructor(private readonly s: FinancialVisualsService) {}

  /** The profit and loss of a range of months (the last 12 by default) as a waterfall, a Sankey, a heatmap and a treemap. */
  @Get()
  @RequirePermission('reports.read')
  visuals(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(Period)) q: z.infer<typeof Period>) {
    return this.s.visuals(org, q);
  }
}

@ApiTags('reports')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/reports/department-performance')
export class DepartmentPerformanceController {
  constructor(private readonly s: DepartmentPerformanceService) {}

  /** Revenue, spending, profit and budget use per department over a range of months (the last 6 by default). */
  @Get()
  @RequirePermission('reports.read')
  report(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(Period)) q: z.infer<typeof Period>) {
    return this.s.report(org, q);
  }
}

const day = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Use YYYY-MM-DD');
const Range = z.object({ from: day.optional(), to: day.optional(), size: z.enum(['DAY', 'WEEK', 'MONTH']).optional() }).strict();

@ApiTags('reports')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/reports/timeline')
export class FinancialTimelineController {
  constructor(private readonly s: FinancialTimelineService) {}

  /** Posted entries, cash in and out with the cash balance, and compliance deadlines over a range of days (the last 90 and next 30 by default). */
  @Get()
  @RequirePermission('reports.read')
  timeline(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(Range)) q: z.infer<typeof Range>) {
    return this.s.timeline(org, q);
  }
}

@ApiTags('reports')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/reports/risk-monitor')
export class RiskMonitorController {
  constructor(private readonly s: RiskMonitorService) {}

  /** Risk across alerts, payments, expenses, bank activity, compliance deadlines and vendors, scored, with the last 90 days of daily readings. */
  @Get()
  @RequirePermission('reports.read')
  monitor(@CurrentOrg() org: OrgContext) {
    return this.s.monitor(org);
  }
}

@ApiTags('reports')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/reports/dependencies')
export class FinancialDependenciesController {
  constructor(private readonly s: FinancialDependenciesService) {}

  /** Who the business depends on: revenue by customer and spending by vendor over a range of months (the last 12 by default), and cash and borrowing by account at its end. */
  @Get()
  @RequirePermission('reports.read')
  dependencies(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(Period)) q: z.infer<typeof Period>) {
    return this.s.dependencies(org, q);
  }
}

const RoleParam = z.enum(DASHBOARD_ROLES);

@ApiTags('reports')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/reports/role-dashboards')
export class RoleDashboardsController {
  constructor(private readonly s: RoleDashboardsService) {}

  /** The dashboards there are, one per role, and the question each answers. */
  @Get()
  @RequirePermission('reports.read')
  list() {
    return { roles: DASHBOARD_ROLES.map((role) => ({ role, ...ROLE_DASHBOARDS[role] })) };
  }

  /** One role's dashboard: CEO, CFO, TREASURY, RISK, COMPLIANCE or BOARD, each with its own figures and layout. */
  @Get(':role')
  @RequirePermission('reports.read')
  brief(@CurrentOrg() org: OrgContext, @Param('role', new ZodPipe(RoleParam)) role: DashboardRole) {
    return this.s.brief(org, role);
  }
}
