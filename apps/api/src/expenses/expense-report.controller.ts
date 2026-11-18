import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, ZodPipe } from '../common/zod';
import { ExpenseReportService, REPORTABLE_STATUSES } from './expense-report.service';

const Query_ = z.object({
  from: isoDate,
  to: isoDate,
  status: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((x) => x.trim().toUpperCase()) : undefined))
    .pipe(z.array(z.enum(REPORTABLE_STATUSES)).optional()),
  claimantId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
});

/** Expense reports (EXP-017). expenses.read sees everyone's claims; claimants see their own. */
@ApiTags('expense-claims')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/reports/expenses')
export class ExpenseReportController {
  constructor(private readonly reports: ExpenseReportService) {}

  @Get()
  @RequirePermission('org.read')
  report(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(Query_)) q: z.infer<typeof Query_>) {
    return this.reports.report(org, user.id, { from: q.from, to: q.to, statuses: q.status, claimantId: q.claimantId, accountId: q.accountId });
  }
}
