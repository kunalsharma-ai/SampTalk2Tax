import { Controller, Get, Param, Query } from '@nestjs/common';
import { DASHBOARD_ROLES, LANDSCAPE_VIEWS, ROLE_DASHBOARDS, type DashboardRole } from '@talk2tax/accounting-engine';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { CashFlowNetworkService } from './cash-flow-network.service';
import { DepartmentPerformanceService } from './department-performance.service';
import { FinancialLandscapeService } from './financial-landscape.service';
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

@ApiTags('reports')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/reports/cash-flow-network')
export class CashFlowNetworkController {
  constructor(private readonly s: CashFlowNetworkService) {}

  /** Where cash came from and went to, month by month and per cash or bank account, over a range of months (the last 12 by default). */
  @Get()
  @RequirePermission('reports.read')
  network(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(Period)) q: z.infer<typeof Period>) {
    return this.s.network(org, q);
  }
}

const LandscapeQuery = z.object({ from: month.optional(), to: month.optional(), view: z.enum(LANDSCAPE_VIEWS).optional() }).strict();

@ApiTags('reports')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/reports/landscape')
export class FinancialLandscapeController {
  constructor(private readonly s: FinancialLandscapeService) {}

  /** Income or spending by account and month (the last 12 by default), for the 3D financial landscape. */
  @Get()
  @RequirePermission('reports.read')
  landscape(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(LandscapeQuery)) q: z.infer<typeof LandscapeQuery>) {
    return this.s.landscape(org, q);
  }
}

const RoleParam = z.enum(DASHBOARD_ROLES);
const BriefQuery = z.object({ departmentId: z.string().uuid().optional() }).strict();

@ApiTags('reports')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/reports/role-dashboards')
export class RoleDashboardsController {
  constructor(private readonly s: RoleDashboardsService) {}

  /** The dashboards there are, one per role, and the question each answers. */
  @Get()
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext) {
    return { roles: DASHBOARD_ROLES.map((role) => ({ role, ...ROLE_DASHBOARDS[role], available: RoleDashboardsService.available(org, role) })) };
  }

  /** One role's dashboard: CEO, CFO, TREASURY, RISK, COMPLIANCE or BOARD, each with its own figures and layout. */
  @Get(':role')
  @RequirePermission('reports.read')
  brief(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('role', new ZodPipe(RoleParam)) role: DashboardRole, @Query(new ZodPipe(BriefQuery)) q: z.infer<typeof BriefQuery>) {
    return this.s.brief(org, user, role, q);
  }
}
