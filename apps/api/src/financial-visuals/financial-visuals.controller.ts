import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { DepartmentPerformanceService } from './department-performance.service';
import { FinancialTimelineService } from './financial-timeline.service';
import { FinancialVisualsService } from './financial-visuals.service';
import { RiskMonitorService } from './risk-monitor.service';

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
