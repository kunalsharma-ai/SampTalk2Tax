import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { todayIso } from '../common/dates';
import { ZodPipe } from '../common/zod';
import { InvoiceRequirementsService } from './invoice-requirements.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const Overview = z
  .object({
    turnover: z
      .string()
      .regex(/^\d{1,15}(\.\d{1,2})?$/, 'Enter the turnover as a number')
      .optional(),
  })
  .strict();
const Check = z.object({ from: isoDate.optional(), to: isoDate.optional() }).strict();

/** Country-specific invoice formats (TAX-039) and electronic invoicing requirements (TAX-040). */
@ApiTags('tax')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/invoice-requirements')
export class InvoiceRequirementsController {
  constructor(private readonly requirements: InvoiceRequirementsService) {}

  @Get()
  @RequirePermission('sales.read')
  overview(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(Overview)) q: z.infer<typeof Overview>) {
    return this.requirements.overview(org, q.turnover ?? null);
  }

  /** Sales invoices and credit notes dated in the period (default: the last 90 days) against the country's rules. */
  @Get('check')
  @RequirePermission('sales.read')
  check(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(Check)) q: z.infer<typeof Check>) {
    const to = q.to ?? todayIso();
    const from = q.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 89 * 86_400_000).toISOString().slice(0, 10);
    return this.requirements.check(org, from, to);
  }

  @Get('documents/:documentId')
  @RequirePermission('sales.read')
  document(@CurrentOrg() org: OrgContext, @Param('documentId', ParseUUIDPipe) documentId: string) {
    return this.requirements.document(org, documentId);
  }
}
