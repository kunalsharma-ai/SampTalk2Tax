import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { CollectionPrioritiesService } from './collection-priorities.service';
import { PaymentPredictionsService } from './payment-predictions.service';

const PredictionQuery = z.object({ contactId: z.uuid().optional() }).strict();
const ForecastQuery = z.object({ weeks: z.coerce.number().int().min(1).max(26).default(13) }).strict();

@ApiTags('sales')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/payment-predictions')
export class PaymentPredictionsController {
  constructor(private readonly predictions: PaymentPredictionsService) {}

  /** Every open invoice with when it is likely to be paid, the chance it is late and why; and the method's accuracy so far. */
  @Get()
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(PredictionQuery)) q: z.infer<typeof PredictionQuery>) {
    return this.predictions.predictions(org, q);
  }

  /** Money expected from customers week by week, from the predictions, beside what the due dates say. */
  @Get('forecast')
  @RequirePermission('reports.read')
  forecast(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ForecastQuery)) q: z.infer<typeof ForecastQuery>) {
    return this.predictions.forecast(org, q);
  }
}

@ApiTags('sales')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/collection-priorities')
export class CollectionPrioritiesController {
  constructor(private readonly priorities: CollectionPrioritiesService) {}

  /** Customers ranked by who to chase first today, with the points behind each score and a suggested action. */
  @Get()
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.priorities.priorities(org);
  }
}
