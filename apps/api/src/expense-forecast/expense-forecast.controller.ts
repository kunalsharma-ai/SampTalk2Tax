import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { EXPENSE_FORECAST_MAX_MONTHS } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { ExpenseForecastService } from './expense-forecast.service';

const ForecastQuery = z.object({ months: z.coerce.number().int().min(1).max(EXPENSE_FORECAST_MAX_MONTHS).default(3) }).strict();

@ApiTags('expenses')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/expense-forecast')
export class ExpenseForecastController {
  constructor(private readonly forecasts: ExpenseForecastService) {}

  /** Expected spending on expense claims by account for the coming months (EXP-025). */
  @Get()
  @RequirePermission('expenses.read')
  get(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ForecastQuery)) q: z.infer<typeof ForecastQuery>) {
    return this.forecasts.forecast(org, q.months);
  }
}
