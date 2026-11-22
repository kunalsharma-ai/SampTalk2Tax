import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { ExpenseCategorizationService } from './expense-categorization.service';

const ClaimLine = z.object({ merchant: z.string().trim().max(200).nullish(), description: z.string().trim().max(500).nullish() }).strict();
const BillLine = z.object({ contactId: z.uuid().nullish(), description: z.string().trim().max(500).nullish() }).strict();

/** Expense account suggestions (EXP-020, AP-020): the service checks expenses.submit or purchases.read. */
@ApiTags('expense-claims')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/expense-categorization')
export class ExpenseCategorizationController {
  constructor(private readonly categories: ExpenseCategorizationService) {}

  @Post('claim-line')
  @HttpCode(200)
  @RequirePermission('org.read')
  @ApiBody({ schema: openApi(ClaimLine) })
  claimLine(@CurrentOrg() org: OrgContext, @Body(new ZodPipe(ClaimLine)) body: z.infer<typeof ClaimLine>) {
    return this.categories.forClaimLine(org, body);
  }

  @Post('bill-line')
  @HttpCode(200)
  @RequirePermission('purchases.read')
  @ApiBody({ schema: openApi(BillLine) })
  billLine(@CurrentOrg() org: OrgContext, @Body(new ZodPipe(BillLine)) body: z.infer<typeof BillLine>) {
    return this.categories.forBillLine(org, body);
  }
}
