import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { KPI_KEYS, KpisService } from './kpis.service';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month as YYYY-MM');
const MonthQuery = z.object({ month: month.optional() });
const kpi = z.enum(KPI_KEYS);
const TargetBody = z
  .object({
    comparator: z.enum(['AT_LEAST', 'AT_MOST']),
    target: z.string().trim().regex(/^-?\d{1,15}(\.\d{1,4})?$/, 'A number such as "45", "1.5" or "-50000" (at most 4 decimals)'),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();
const CommentaryBody = z.object({ commentary: z.string().max(10000) }).strict();

@ApiTags('kpis')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId')
export class KpisController {
  constructor(private readonly kpis: KpisService) {}

  /**
   * Every KPI for a month (the last complete month by default), with the previous month,
   * the same month last year, 13 months of history, its target and the figures behind it;
   * and revenue by customer over the last 12 months.
   */
  @Get('kpis')
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(MonthQuery)) q: z.infer<typeof MonthQuery>) {
    return this.kpis.kpis(org.id, q);
  }

  @Get('kpis/targets')
  @RequirePermission('reports.read')
  targets(@CurrentOrg() org: OrgContext) {
    return this.kpis.listTargets(org.id);
  }

  @Put('kpis/targets/:kpi')
  @RequirePermission('budgets.manage')
  @ApiBody({ schema: openApi(TargetBody) })
  setTarget(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('kpi', new ZodPipe(kpi)) key: z.infer<typeof kpi>, @Body(new ZodPipe(TargetBody)) body: z.infer<typeof TargetBody>) {
    return this.kpis.setTarget(org.id, user, key, body);
  }

  @Delete('kpis/targets/:kpi')
  @RequirePermission('budgets.manage')
  removeTarget(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('kpi', new ZodPipe(kpi)) key: z.infer<typeof kpi>) {
    return this.kpis.removeTarget(org.id, user, key);
  }

  /** The last 24 months and the state of each month's report. */
  @Get('management-reports')
  @RequirePermission('reports.read')
  reports(@CurrentOrg() org: OrgContext) {
    return this.kpis.listReports(org.id);
  }

  /** A month's management report: live figures while a draft, the frozen copy once final. */
  @Get('management-reports/:month')
  @RequirePermission('reports.read')
  report(@CurrentOrg() org: OrgContext, @Param('month', new ZodPipe(month)) m: string) {
    return this.kpis.report(org.id, m);
  }

  @Put('management-reports/:month/commentary')
  @RequirePermission('budgets.manage')
  @ApiBody({ schema: openApi(CommentaryBody) })
  commentary(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('month', new ZodPipe(month)) m: string, @Body(new ZodPipe(CommentaryBody)) body: z.infer<typeof CommentaryBody>) {
    return this.kpis.saveCommentary(org.id, user, m, body.commentary);
  }

  /** Freeze the report's figures and commentary. Only for a month that has ended. */
  @Post('management-reports/:month/finalise')
  @HttpCode(200)
  @RequirePermission('budgets.manage')
  finalise(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('month', new ZodPipe(month)) m: string) {
    return this.kpis.finalise(org.id, user, m);
  }
}
