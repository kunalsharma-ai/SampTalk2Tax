import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TAX_FORECAST_MAX_MONTHS } from '@talk2tax/tax-engine';
import { z } from 'zod';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { TaxForecastService } from './tax-forecast.service';

const Q = z.object({ months: z.coerce.number().int().min(1).max(TAX_FORECAST_MAX_MONTHS).default(3) }).strict();

/** Tax liability forecast (TAX-048). */
@ApiTags('tax')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/tax-forecast')
export class TaxForecastController {
  constructor(private readonly forecast: TaxForecastService) {}

  @Get()
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(Q)) q: z.infer<typeof Q>) {
    return this.forecast.forecast(org, q.months);
  }
}
