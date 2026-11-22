import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, ZodPipe } from '../common/zod';
import { ExpenseEvidenceService } from './expense-evidence.service';

const Period = z.object({ from: isoDate.optional(), to: isoDate.optional() });
const ListQuery = Period.extend({ gapsOnly: z.enum(['true', 'false']).optional().transform((v) => v === 'true') });
const id = z.string().uuid('Not a valid id');

@ApiTags('expense evidence')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/expense-evidence')
export class ExpenseEvidenceController {
  constructor(private readonly evidence: ExpenseEvidenceService) {}

  /** Claims decided in the period, each with its evidence and gaps. */
  @Get()
  @RequirePermission('audit.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.evidence.list(org, q);
  }

  /** The evidence index for the period as CSV text. */
  @Get('export')
  @RequirePermission('audit.read')
  exportCsv(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(Period)) q: z.infer<typeof Period>) {
    return this.evidence.exportCsv(org, q);
  }

  /** One claim's evidence pack. */
  @Get(':claimId')
  @RequirePermission('audit.read')
  detail(@CurrentOrg() org: OrgContext, @Param('claimId', new ZodPipe(id)) claimId: string) {
    return this.evidence.detail(org, claimId);
  }
}
