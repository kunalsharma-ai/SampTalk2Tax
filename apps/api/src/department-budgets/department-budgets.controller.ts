import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, openApi, ZodPipe } from '../common/zod';
import { DepartmentBudgetsService } from './department-budgets.service';

const Year = z.coerce.number().int().min(2000).max(2200);
const ReportQuery = z.object({ fiscalYear: Year.optional() }).strict();
const SetBody = z.object({ departmentId: z.uuid('Choose a department'), fiscalYear: Year, amount: decimalString, note: z.string().trim().max(500).nullish() }).strict();

/** Department budgets (EXP-014). */
@ApiTags('expenses')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId')
export class DepartmentBudgetsController {
  constructor(private readonly budgets: DepartmentBudgetsService) {}

  /** Active departments, for an expense claim line. */
  @Get('expense-departments')
  @RequirePermission('expenses.submit')
  departments(@CurrentOrg() org: OrgContext) {
    return this.budgets.departments(org);
  }

  @Get('department-budgets')
  @RequirePermission('expenses.read')
  report(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ReportQuery)) q: z.infer<typeof ReportQuery>) {
    return this.budgets.report(org, q.fiscalYear);
  }

  @Put('department-budgets')
  @RequirePermission('budgets.manage')
  @ApiBody({ schema: openApi(SetBody) })
  set(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(SetBody)) b: z.infer<typeof SetBody>) {
    return this.budgets.set(org, user, b);
  }

  /** What approving a claim waiting for approval would do to each department's budget. */
  @Get('expense-claims/:claimId/budget-impact')
  @RequirePermission('expenses.read')
  impact(@CurrentOrg() org: OrgContext, @Param('claimId', ParseUUIDPipe) claimId: string) {
    return this.budgets.claimImpact(org, claimId);
  }
}
