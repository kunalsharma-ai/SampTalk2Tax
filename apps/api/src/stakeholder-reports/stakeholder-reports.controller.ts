import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { STAKEHOLDER_AUDIENCES } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { StakeholderReportsService } from './stakeholder-reports.service';

const audience = z.preprocess((v) => (typeof v === 'string' ? v.toUpperCase() : v), z.enum(STAKEHOLDER_AUDIENCES));
const period = z.string().regex(/^FY\d{4}(-Q[1-4])?$/, 'A period such as FY2027 or FY2027-Q2');
const text = z.string().max(5000);
const NarrativeBody = z.object({ highlights: text, challenges: text, outlook: text, asks: text }).strict();

/**
 * Executive and investor reports (RPT-022, RPT-023) for a fiscal quarter or year: headline figures,
 * profit and loss against the period before and last year, cash and runway, customers (named only
 * for executives), points for attention (executives) and a narrative; finalising freezes them.
 */
@ApiTags('reports')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/stakeholder-reports')
export class StakeholderReportsController {
  constructor(private readonly reports: StakeholderReportsService) {}

  @Get()
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.reports.list(org);
  }

  @Get(':audience/:period')
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Param('audience', new ZodPipe(audience)) a: z.infer<typeof audience>, @Param('period', new ZodPipe(period)) p: string) {
    return this.reports.get(org, a, p);
  }

  @Put(':audience/:period/narrative')
  @RequirePermission('budgets.manage')
  @ApiBody({ schema: openApi(NarrativeBody) })
  narrative(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('audience', new ZodPipe(audience)) a: z.infer<typeof audience>, @Param('period', new ZodPipe(period)) p: string, @Body(new ZodPipe(NarrativeBody)) body: z.infer<typeof NarrativeBody>) {
    return this.reports.saveNarrative(org, user, a, p, body);
  }

  @Post(':audience/:period/finalise')
  @HttpCode(200)
  @RequirePermission('budgets.manage')
  finalise(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('audience', new ZodPipe(audience)) a: z.infer<typeof audience>, @Param('period', new ZodPipe(period)) p: string) {
    return this.reports.finalise(org, user, a, p);
  }
}
