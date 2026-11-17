import { Controller, ForbiddenException, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { hasPermission } from '@talk2tax/security';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission, RequireFlag } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { OpportunitiesService, type OpportunityQuery } from './opportunities.service';

// Formats only; the engine checks the ranges and explains them in words.
const rate = (d: string) => z.string().trim().max(8).default(d);
const Query_ = z
  .object({
    horizonMonths: z.coerce.number().int().min(1, 'Choose a horizon from 1 to 60 months').max(60, 'Choose a horizon from 1 to 60 months').default(12),
    winBackRatePercent: rate('25'),
    crossSellRatePercent: rate('15'),
    segmentGrowthPercent: rate('10'),
  })
  .strict();

/** Opportunities name customers and their sales, so the sales ledger is needed as well as reports. */
function salesData(org: OrgContext) {
  if (!hasPermission(org.role, 'sales.read')) throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Opportunity intelligence needs access to sales' });
}

/**
 * Opportunity intelligence. Reading needs reports.read and sales.read. Taking an opportunity
 * forward saves it as an impact assessment and needs scenarios.manage plus purchases.read (the
 * business impact engine's own requirement). Nothing here posts to the books.
 */
@ApiTags('opportunities')
@ApiBearerAuth()
@RequireFlag('opportunities')
@Controller('v1/orgs/:orgId/opportunities')
export class OpportunitiesController {
  constructor(private readonly svc: OpportunitiesService) {}

  @Get()
  @RequirePermission('reports.read')
  find(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(Query_)) q: z.infer<typeof Query_>) {
    salesData(org);
    return this.svc.find(org, q as OpportunityQuery);
  }

  @Post(':key/assessment')
  @RequirePermission('scenarios.manage')
  toAssessment(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('key') key: string, @Query(new ZodPipe(Query_)) q: z.infer<typeof Query_>) {
    salesData(org);
    if (!hasPermission(org.role, 'purchases.read')) throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Business impact assessments need access to sales and purchases' });
    return this.svc.toAssessment(org, user, key.slice(0, 80), q as OpportunityQuery);
  }
}
