import { Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { ReportStudioService } from './report-studio.service';

const ReportKey = z.string().regex(/^[a-z-]{1,40}$/, 'Unknown report');

@ApiTags('reports')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/reports/studio')
export class ReportStudioController {
  constructor(private readonly studio: ReportStudioService) {}

  /** Every report in one catalogue, which this member may open, their pins, saved views, schedules, designs and recent exports. */
  @Get()
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    return this.studio.studio(org, user);
  }

  @Put('favourites/:report')
  @RequirePermission('reports.read')
  pin(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('report', new ZodPipe(ReportKey)) report: string) {
    return this.studio.pin(org, user, report);
  }

  @Delete('favourites/:report')
  @RequirePermission('reports.read')
  unpin(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('report', new ZodPipe(ReportKey)) report: string) {
    return this.studio.unpin(org, user, report);
  }
}
