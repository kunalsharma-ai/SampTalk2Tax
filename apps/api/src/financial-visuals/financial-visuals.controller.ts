import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { FinancialVisualsService } from './financial-visuals.service';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const Period = z.object({ from: month.optional(), to: month.optional() }).strict();

@ApiTags('reports')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/reports/visuals')
export class FinancialVisualsController {
  constructor(private readonly s: FinancialVisualsService) {}

  /** The profit and loss of a range of months (the last 12 by default) as a waterfall, a Sankey, a heatmap and a treemap. */
  @Get()
  @RequirePermission('reports.read')
  visuals(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(Period)) q: z.infer<typeof Period>) {
    return this.s.visuals(org, q);
  }
}
