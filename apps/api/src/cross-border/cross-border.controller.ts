import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, ZodPipe } from '../common/zod';
import { CrossBorderService } from './cross-border.service';

const Period = z.object({ from: isoDate.optional(), to: isoDate.optional() }).strict();

/** Cross-border tax reporting (TAX-038). */
@ApiTags('tax')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/tax/cross-border')
export class CrossBorderController {
  constructor(private readonly s: CrossBorderService) {}

  /** Sales and purchases with contacts abroad, by country, for a period (the financial year to date by default). */
  @Get()
  @RequirePermission('reports.read')
  report(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(Period)) q: z.infer<typeof Period>) {
    return this.s.report(org, q);
  }

  /** The same as CSV text; the export is kept in the audit trail. */
  @Get('export')
  @RequirePermission('reports.read')
  exportCsv(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(Period)) q: z.infer<typeof Period>) {
    return this.s.exportCsv(org, user, q);
  }
}
