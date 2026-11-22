import { Controller, Get, Query } from '@nestjs/common';
import { assertIsoDate } from '@talk2tax/accounting-engine';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, ZodPipe } from '../common/zod';
import { ExpenseReconciliationService } from './expense-reconciliation.service';

const realDate = (v: string) => {
  try {
    assertIsoDate(v);
    return true;
  } catch {
    return false;
  }
};
const Q = z.object({ asOf: isoDate.refine(realDate, 'Not a real date').optional() }).strict();

/** Expense reconciliation (EXP-016): the employee reimbursements account, claims and bank. */
@ApiTags('expense-claims')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/expense-reconciliation')
export class ExpenseReconciliationController {
  constructor(private readonly recon: ExpenseReconciliationService) {}

  @Get()
  @RequirePermission('expenses.read')
  get(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(Q)) q: z.infer<typeof Q>) {
    return this.recon.reconcile(org, q);
  }
}
