import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { PayrollReportService } from './payroll-report.service';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month such as 2026-04');
const Period = z.object({ from: month.optional(), to: month.optional() }).strict();

@ApiTags('reports')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/reports/payroll')
export class PayrollReportController {
  constructor(private readonly s: PayrollReportService) {}

  /** Posted pay runs for a range of months (the financial year to date by default): totals, statutory amounts, months and employees. */
  @Get()
  @RequirePermission('payroll.read')
  report(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(Period)) q: z.infer<typeof Period>) {
    return this.s.report(org, q);
  }

  /** The same report as CSV text; the export is kept in the audit trail. */
  @Get('export')
  @RequirePermission('payroll.read')
  exportCsv(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(Period)) q: z.infer<typeof Period>) {
    return this.s.exportCsv(org, user, q);
  }
}
