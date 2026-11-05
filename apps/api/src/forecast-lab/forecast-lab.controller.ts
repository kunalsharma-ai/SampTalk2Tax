import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { ForecastLabService } from './forecast-lab.service';

const window = z.union([z.literal(6), z.literal(12), z.literal(18)], { message: 'Choose 6, 12 or 18 months' });
const OverviewQuery = z.object({ window: z.coerce.number().pipe(window).default(12) }).strict();
const SaveBody = z.object({ window: window.default(12), note: z.string().trim().max(1000, 'Keep the note under 1000 characters').nullish() }).strict();

/**
 * The forecast evaluation lab: models compared on the organisation's own history, and saved
 * forecasts measured later. Reading needs reports.read; saving a run needs budgets.manage.
 */
@ApiTags('forecast-lab')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/forecast-lab')
export class ForecastLabController {
  constructor(private readonly svc: ForecastLabService) {}

  @Get()
  @RequirePermission('reports.read')
  overview(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(OverviewQuery)) q: z.infer<typeof OverviewQuery>) {
    return this.svc.overview(org.id, q);
  }

  @Get('runs')
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.svc.list(org.id);
  }

  @Post('runs')
  @RequirePermission('budgets.manage')
  @ApiBody({ schema: openApi(SaveBody) })
  save(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SaveBody)) b: z.infer<typeof SaveBody>) {
    return this.svc.save(org.id, user, b);
  }

  @Get('runs/:id')
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(org.id, id);
  }
}
