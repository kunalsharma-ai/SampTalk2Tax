import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { RevenueForecastService } from './revenue-forecast.service';

const horizon = z.coerce.number().int('Whole months').min(1, 'At least one month').max(24, 'At most 24 months');
const ForecastQuery = z.object({ months: horizon.default(12) }).strict();
const SaveBody = z.object({ months: horizon, note: z.string().trim().max(500, 'Keep the note under 500 characters').nullish() }).strict();

/** Revenue forecast from contracts, open orders, the pipeline and recent sales; saved forecasts compared with what happened. */
@ApiTags('revenue-forecast')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/sales/revenue-forecast')
export class RevenueForecastController {
  constructor(private readonly forecasts: RevenueForecastService) {}

  @Get()
  @RequirePermission('reports.read')
  forecast(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ForecastQuery)) q: z.infer<typeof ForecastQuery>) {
    return this.forecasts.forecast(org, q.months);
  }

  @Get('saved')
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.forecasts.list(org);
  }

  @Get('saved/:id')
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.forecasts.get(org, id);
  }

  /** Keep today's forecast, to compare with what is invoiced. */
  @Post('saved')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(SaveBody) })
  save(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SaveBody)) b: z.infer<typeof SaveBody>) {
    return this.forecasts.save(org, user, b);
  }
}
