import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { VIEW_REPORT_KEYS } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { ReportViewsService } from './report-views.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const ViewBody = z
  .object({
    name: z.string().trim().min(1, 'Name the view').max(80, 'Keep the name under 80 characters'),
    report: z.enum(VIEW_REPORT_KEYS as [string, ...string[]], { message: 'Choose a report that takes saved views' }),
    filters: z
      .object({
        dates: z.object({ preset: z.string().max(40), from: isoDate.nullish(), to: isoDate.nullish() }).strict(),
        basis: z.enum(['ACCRUAL', 'CASH']).nullish(),
        departmentId: z.uuid().nullish(),
        projectId: z.uuid().nullish(),
      })
      .strict(),
    shared: z.boolean().default(false),
  })
  .strict();
const ListQuery = z.object({ report: z.enum(VIEW_REPORT_KEYS as [string, ...string[]]).optional() }).strict();
type Body = z.infer<typeof ViewBody>;

@ApiTags('reports')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/report-views')
export class ReportViewsController {
  constructor(private readonly views: ReportViewsService) {}

  /** Your saved views and the ones shared with the organisation, each with the dates it opens with today. */
  @Get()
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.views.list(org, user, q.report as never);
  }

  @Post()
  @RequirePermission('reports.read')
  @ApiBody({ schema: openApi(ViewBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(ViewBody)) body: Body) {
    return this.views.create(org, user, body as never);
  }

  @Put(':id')
  @RequirePermission('reports.read')
  @ApiBody({ schema: openApi(ViewBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ViewBody)) body: Body) {
    return this.views.update(org, user, id, body as never);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('reports.read')
  remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.views.remove(org, user, id);
  }
}
