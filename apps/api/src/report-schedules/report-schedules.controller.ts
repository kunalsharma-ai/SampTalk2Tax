import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { REPORT_SCHEDULE_FREQUENCIES, SCHEDULE_FORMATS, SCHEDULE_PERIODS, SCHEDULED_REPORTS } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { ReportSchedulesService } from './report-schedules.service';

const ScheduleBody = z
  .object({
    name: z.string().max(200),
    report: z.enum(SCHEDULED_REPORTS),
    format: z.enum(SCHEDULE_FORMATS),
    period: z.enum(SCHEDULE_PERIODS),
    frequency: z.enum(REPORT_SCHEDULE_FREQUENCIES),
    weekday: z.number().int().nullable().default(null),
    dayOfMonth: z.number().int().nullable().default(null),
    recipientIds: z.array(z.uuid()).max(50),
    isActive: z.boolean().optional(),
  })
  .strict();

@ApiTags('reports')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/report-schedules')
export class ReportSchedulesController {
  constructor(private readonly schedules: ReportSchedulesService) {}

  @Get()
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.schedules.list(org.id);
  }

  @Get(':id')
  @RequirePermission('reports.read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.schedules.get(id);
  }

  @Post()
  @RequirePermission('reports.design')
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(ScheduleBody)) body: z.infer<typeof ScheduleBody>) {
    return this.schedules.create(org, user, body);
  }

  @Put(':id')
  @RequirePermission('reports.design')
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ScheduleBody)) body: z.infer<typeof ScheduleBody>) {
    return this.schedules.update(org, user, id, body);
  }

  @Delete(':id')
  @RequirePermission('reports.design')
  remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.schedules.remove(org, user, id);
  }

  @Post(':id/send')
  @RequirePermission('reports.design')
  sendNow(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.schedules.sendNow(org, user, id);
  }
}
