import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { PaymentPredictionsService } from './payment-predictions.service';

const PredictionQuery = z.object({ contactId: z.uuid().optional() }).strict();

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
}
