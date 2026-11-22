import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, ZodPipe } from '../common/zod';
import { TaxReportService } from './tax-report.service';

const Period = z.object({ from: isoDate.optional(), to: isoDate.optional() }).strict();

@ApiTags('reports')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/reports/tax')
export class TaxReportController {
  constructor(private readonly s: TaxReportService) {}

  /** Output and input tax by rate and by month, withholding by section and the tax accounts, for a period (the financial year to date by default). */
  @Get()
  @RequirePermission('reports.read')
  report(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(Period)) q: z.infer<typeof Period>) {
    return this.s.report(org, q);
  }

  /** The same report as CSV text; the export is kept in the audit trail. */
  @Get('export')
  @RequirePermission('reports.read')
  exportCsv(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(Period)) q: z.infer<typeof Period>) {
    return this.s.exportCsv(org, user, q);
  }
}
