import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { ReimbursementRoutingService } from './reimbursement-routing.service';

const buffer = z.string().regex(/^\d{1,15}(\.\d{1,2})?$/, 'Give the amount to keep in the bank, such as 10000').default('0');
const PlanQuery = z.object({ buffer });
const PayBody = z
  .object({
    claimantIds: z.array(z.string().uuid('Not a valid id')).min(1, 'Choose at least one person').max(200),
    buffer,
    reference: z.string().trim().max(100).nullish(),
  })
  .strict();

@ApiTags('reimbursement routing')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/expense-routing')
export class ReimbursementRoutingController {
  constructor(private readonly routing: ReimbursementRoutingService) {}

  /** Approved claims to pay, per person, with the route, the account and why. */
  @Get()
  @RequirePermission('expenses.reimburse')
  plan(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(PlanQuery)) q: z.infer<typeof PlanQuery>) {
    return this.routing.plan(org, q);
  }

  /** Pay the chosen people whose route is ready, from the planned accounts, dated today. */
  @Post('pay')
  @HttpCode(200)
  @RequirePermission('expenses.reimburse')
  @ApiBody({ schema: openApi(PayBody) })
  pay(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(PayBody)) body: z.infer<typeof PayBody>) {
    return this.routing.pay(org, { id: user.id }, body);
  }
}
