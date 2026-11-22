import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { TaxAuditService } from './tax-audit.service';

const Q = z.object({ year: z.string().regex(/^\d{4}-\d{2}$/, 'Give the financial year as 2025-26').optional() }).strict();

/** Tax audit support (TAX-026): Form 3CD working papers for a financial year. */
@ApiTags('tax')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/tax-audit')
export class TaxAuditController {
  constructor(private readonly taxAudit: TaxAuditService) {}

  /** Applicability, cash payments over 10,000 (40A(3)), cash receipts of 2 lakh or more (269ST), late TDS with interest and expenditure by GST registration. Defaults to the last financial year. */
  @Get()
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(Q)) q: z.infer<typeof Q>) {
    return this.taxAudit.report(org, q.year);
  }
}
