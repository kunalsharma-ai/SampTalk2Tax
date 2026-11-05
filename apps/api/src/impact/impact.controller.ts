import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { hasPermission } from '@talk2tax/security';
import type { ImpactChange } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { ImpactService, type AssessmentInput } from './impact.service';

// Field formats only; ranges and meaning are checked by the engine, which explains them in words.
const n = z.string().trim().max(24);
const int = z.number().int();
const month = int.optional();
const label = z.string().trim().max(80, 'Keep the description under 80 characters').nullish();
const contactId = z.string().uuid('Choose from the list');
const Change = z.discriminatedUnion('lever', [
  z.object({ lever: z.literal('NEW_CUSTOMER'), label, monthlyRevenue: n, rampMonths: int, month }).strict(),
  z.object({ lever: z.literal('LOSE_CUSTOMER'), contactId, month }).strict(),
  z.object({ lever: z.literal('PRICE_CHANGE'), pricePercent: n, volumePercent: n, month }).strict(),
  z.object({ lever: z.literal('SALES_HIRES'), count: int, monthlyCostPerHead: n, oneOffCostPerHead: n, monthlyRevenuePerHead: n, rampMonths: int, month }).strict(),
  z.object({ lever: z.literal('CUSTOMER_TERMS'), collectionDaysChange: int, month }).strict(),
  z.object({ lever: z.literal('HIRE'), count: int, monthlyCostPerHead: n, oneOffCostPerHead: n, month }).strict(),
  z.object({ lever: z.literal('PAY_RISE'), percent: n, month }).strict(),
  z.object({ lever: z.literal('HEADCOUNT_REDUCTION'), count: int, monthlyCostPerHead: n, severancePerHead: n, month }).strict(),
  z.object({ lever: z.literal('SUPPLIER_PRICE'), contactId: contactId.nullable(), percent: n, month }).strict(),
  z.object({ lever: z.literal('SUPPLIER_TERMS'), paymentDaysChange: int, month }).strict(),
  z.object({ lever: z.literal('NEW_SITE'), label, oneOffCost: n, monthlyCost: n, monthlyRevenue: n, rampMonths: int, month }).strict(),
  z.object({ lever: z.literal('EQUIPMENT'), label, cost: n, usefulLifeMonths: int, monthlySaving: n, month }).strict(),
  z.object({ lever: z.literal('RUNNING_COSTS'), percent: n, monthlyAmount: n, month }).strict(),
]);
const baselineMonths = z.union([z.literal(3), z.literal(6), z.literal(12)]);
const horizonMonths = z.number().int().min(1, 'Choose a horizon from 1 to 60 months').max(60, 'Choose a horizon from 1 to 60 months');
const AssessBody = z.object({ baselineMonths, horizonMonths, changes: z.array(Change).min(1, 'Add at least one change').max(15, 'At most 15 changes in an assessment') }).strict();
const AssessmentBody = AssessBody.extend({
  name: z.string().trim().min(1, 'Give the assessment a name').max(120, 'Keep the name under 120 characters'),
  description: z.string().trim().max(1000, 'Keep the description under 1000 characters').nullish(),
}).strict();
const MonthsQuery = z.object({ baselineMonths: z.coerce.number().pipe(baselineMonths).default(6), horizonMonths: z.coerce.number().pipe(horizonMonths).default(12) }).strict();

/** Changes name customers and suppliers and use their sales and bills, so both ledgers are needed. */
function ledgers(org: OrgContext) {
  if (!hasPermission(org.role, 'sales.read') || !hasPermission(org.role, 'purchases.read')) throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Business impact assessments need access to sales and purchases' });
}

/**
 * Business impact engine. Reading and running need reports.read plus sales.read and
 * purchases.read; saving, changing and deleting assessments, and turning one into a digital-twin
 * scenario, need scenarios.manage. Nothing here posts to the books.
 */
@ApiTags('business-impact')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/impact')
export class ImpactController {
  constructor(private readonly svc: ImpactService) {}

  @Get('options')
  @RequirePermission('reports.read')
  options(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(MonthsQuery)) q: z.infer<typeof MonthsQuery>) {
    ledgers(org);
    return this.svc.options(org.id, q as { baselineMonths: 3 | 6 | 12; horizonMonths: number });
  }

  /** Runs changes without saving them. */
  @Post('assess')
  @HttpCode(200)
  @RequirePermission('reports.read')
  @ApiBody({ schema: openApi(AssessBody) })
  assess(@CurrentOrg() org: OrgContext, @Body(new ZodPipe(AssessBody)) b: z.infer<typeof AssessBody>) {
    ledgers(org);
    return this.svc.assess(org.id, { ...b, changes: b.changes as ImpactChange[] } as never);
  }

  @Get('assessments')
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext) {
    ledgers(org);
    return this.svc.list(org.id);
  }

  @Post('assessments')
  @RequirePermission('scenarios.manage')
  @ApiBody({ schema: openApi(AssessmentBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(AssessmentBody)) b: z.infer<typeof AssessmentBody>) {
    ledgers(org);
    return this.svc.create(org.id, user, b as AssessmentInput);
  }

  @Get('assessments/:id')
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    ledgers(org);
    return this.svc.get(org.id, id);
  }

  @Put('assessments/:id')
  @RequirePermission('scenarios.manage')
  @ApiBody({ schema: openApi(AssessmentBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(AssessmentBody)) b: z.infer<typeof AssessmentBody>) {
    ledgers(org);
    return this.svc.update(org.id, user, id, b as AssessmentInput);
  }

  @Delete('assessments/:id')
  @HttpCode(204)
  @RequirePermission('scenarios.manage')
  async remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    ledgers(org);
    await this.svc.remove(org.id, user, id);
  }

  /** Saves the changes as a digital-twin scenario, to take them through the war room. */
  @Post('assessments/:id/scenario')
  @RequirePermission('scenarios.manage')
  toScenario(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    ledgers(org);
    return this.svc.toScenario(org.id, user, id);
  }
}
