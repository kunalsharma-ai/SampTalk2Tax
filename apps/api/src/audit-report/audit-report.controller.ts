import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, ZodPipe } from '../common/zod';
import { AuditReportService } from './audit-report.service';

const Period = z.object({ from: isoDate.optional(), to: isoDate.optional() }).strict();

@ApiTags('reports')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/reports/audit')
export class AuditReportController {
  constructor(private readonly s: AuditReportService) {}

  /** The audit trail and posted journals of a period (the financial year to date by default): activity, sensitive actions, journal checks and the hash chain. */
  @Get()
  @RequirePermission('audit.read')
  report(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(Period)) q: z.infer<typeof Period>) {
    return this.s.report(org, q);
  }

  /** The same report as CSV text; the export is kept in the audit trail. */
  @Get('export')
  @RequirePermission('audit.read')
  exportCsv(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(Period)) q: z.infer<typeof Period>) {
    return this.s.exportCsv(org, user, q);
  }
}
