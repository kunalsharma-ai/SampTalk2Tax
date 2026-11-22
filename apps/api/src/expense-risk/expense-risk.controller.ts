import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { ExpenseRiskService } from './expense-risk.service';

const RiskQuery = z
  .object({
    days: z.coerce.number().int().min(7).max(365).default(90),
    receiptsFrom: z.string().regex(/^\d{1,13}(\.\d{1,4})?$/, 'Enter an amount').refine((v) => /[1-9]/.test(v), 'Enter an amount above zero').optional(),
  })
  .strict();

@ApiTags('expenses')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/expense-risk')
export class ExpenseRiskController {
  constructor(private readonly risk: ExpenseRiskService) {}

  /** Expense claims with warning signs, most serious first, and the people with the most of them. */
  @Get()
  @RequirePermission('expenses.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(RiskQuery)) q: z.infer<typeof RiskQuery>) {
    return this.risk.findings(org, q);
  }
}
