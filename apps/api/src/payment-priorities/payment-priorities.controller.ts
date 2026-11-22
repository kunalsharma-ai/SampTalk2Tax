import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, openApi, ZodPipe } from '../common/zod';
import { PaymentPrioritiesService } from './payment-priorities.service';
import { PredictivePaymentsService } from './predictive-payments.service';

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

const PredictedQuery = z
  .object({
    days: z.enum(['30', '60', '90']).default('60').transform(Number),
    buffer: decimalString.default('0'),
  })
  .strict();
const ApplyBody = z.object({ documentIds: z.array(z.uuid()).min(1).max(500).optional() }).strict();

@ApiTags('purchases')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/purchases/payment-schedule/predicted')
export class PredictivePaymentsController {
  constructor(private readonly predictive: PredictivePaymentsService) {}

  /** A suggested payment date for each open bill, from the cash in the bank and the receipts expected from customers. */
  @Get()
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(PredictedQuery)) q: z.infer<typeof PredictedQuery>) {
    return this.predictive.predicted(org, q);
  }

  /** Plan the suggested dates as payment plans (all, or the bills listed). */
  @Post('apply')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(ApplyBody) })
  apply(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(PredictedQuery)) q: z.infer<typeof PredictedQuery>, @Body(new ZodPipe(ApplyBody)) body: z.infer<typeof ApplyBody>) {
    return this.predictive.apply(org, user, { ...q, ...body });
  }
}
