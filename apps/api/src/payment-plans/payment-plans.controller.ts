import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { PAYMENT_PLAN_MAX_INSTALMENTS } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { PaymentPlansService } from './payment-plans.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const SuggestQuery = z
  .object({
    contactId: z.uuid(),
    instalments: z.coerce.number().int().min(1).max(PAYMENT_PLAN_MAX_INSTALMENTS).optional(),
    firstDueDate: isoDate.optional(),
  })
  .strict();
const CreateBody = z
  .object({
    contactId: z.uuid(),
    instalments: z.number().int().min(1).max(PAYMENT_PLAN_MAX_INSTALMENTS),
    firstDueDate: isoDate,
    note: z.string().max(1000, 'Keep the note under 1000 characters').nullish(),
  })
  .strict();
const CancelBody = z.object({ reason: z.string().trim().min(3, 'Say why the plan is cancelled').max(1000, 'Keep the reason under 1000 characters') }).strict();

@ApiTags('sales')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/payment-plans')
export class PaymentPlansController {
  constructor(private readonly plans: PaymentPlansService) {}

  /** Every payment plan with how it is going, and the customers a plan could be offered to, each with a suggested plan. */
  @Get()
  @RequirePermission('sales.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.plans.list(org);
  }

  /** A suggested plan for one customer, with the instalments and first date chosen or the recommended ones. */
  @Get('suggest')
  @RequirePermission('sales.read')
  suggest(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(SuggestQuery)) q: z.infer<typeof SuggestQuery>) {
    return this.plans.suggest(org, q);
  }

  /** Agree a plan with a customer: the overdue, undisputed invoices in the chosen number of monthly instalments. */
  @Post()
  @RequirePermission('collections.manage')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    return this.plans.create(org, user, body);
  }

  @Get(':id')
  @RequirePermission('sales.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.plans.get(org, id);
  }

  /** Cancel a plan, saying why. It is kept as a record. */
  @Post(':id/cancel')
  @RequirePermission('collections.manage')
  @ApiBody({ schema: openApi(CancelBody) })
  cancel(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(CancelBody)) body: z.infer<typeof CancelBody>) {
    return this.plans.cancel(org, user, id, body.reason);
  }
}
