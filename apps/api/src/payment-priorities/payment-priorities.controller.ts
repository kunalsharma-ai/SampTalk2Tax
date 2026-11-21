import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, ZodPipe } from '../common/zod';
import { PaymentPrioritiesService } from './payment-priorities.service';

const PriorityQuery = z
  .object({
    buffer: decimalString.default('0'),
    rate: decimalString.refine((x) => Number(x) <= 100, 'The target return is a percentage up to 100').default('12'), // not money
  })
  .strict();

@ApiTags('purchases')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/payment-priorities')
export class PaymentPrioritiesController {
  constructor(private readonly priorities: PaymentPrioritiesService) {}

  /** Open bills ranked against the cash in the bank: pay now, on the due date, short or blocked; with early-payment discount offers. */
  @Get()
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(PriorityQuery)) q: z.infer<typeof PriorityQuery>) {
    return this.priorities.priorities(org, q);
  }
}
