import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { BudgetsService } from './budgets.service';

const fiscalYear = z.coerce.number().int().min(2000).max(2200);
const name = z.string().trim().min(1).max(100);
const note = z.string().trim().max(1000).nullable().optional();
const CreateBody = z.discriminatedUnion('basis', [
  z.object({ basis: z.literal('EMPTY'), fiscalYear, name, note }).strict(),
  z.object({ basis: z.literal('COPY'), fiscalYear, name, note, sourceBudgetId: z.uuid() }).strict(),
  z.object({ basis: z.literal('PRIOR_ACTUALS'), fiscalYear, name, note, changePercent: z.string().trim().regex(/^-?\d{1,4}(\.\d{1,2})?$/, 'A percentage such as "10" or "-2.5"') }).strict(),
]);
const RenameBody = z.object({ name, note }).strict();
const LinesBody = z
  .object({
    lines: z
      .array(z.object({ accountId: z.uuid(), amounts: z.array(z.string().max(40)).length(12).nullable() }).strict())
      .min(1)
      .max(500),
  })
  .strict();
const ReturnBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const ListQuery = z.object({ fiscalYear: fiscalYear.optional() });
const VarianceQuery = z.object({ granularity: z.enum(['MONTH', 'QUARTER', 'YEAR']).default('MONTH'), asOf: isoDate.optional() });

@ApiTags('budgets')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/budgets')
export class BudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  /** The versions of one fiscal year (the current one by default) with their totals, and the years to choose from. */
  @Get()
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.budgets.overview(org.id, q.fiscalYear);
  }

  /** A new version: empty, a copy of another version, or last year's actuals changed by a percentage. */
  @Post()
  @RequirePermission('budgets.manage')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    return this.budgets.create(org.id, user, body);
  }

  @Get(':id')
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.budgets.get(org.id, id);
  }

  @Patch(':id')
  @RequirePermission('budgets.manage')
  @ApiBody({ schema: openApi(RenameBody) })
  rename(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(RenameBody)) body: z.infer<typeof RenameBody>) {
    return this.budgets.rename(org.id, user, id, body);
  }

  /** Replace the twelve monthly amounts of the accounts given; `amounts: null` removes an account. Drafts only. */
  @Put(':id/lines')
  @RequirePermission('budgets.manage')
  @ApiBody({ schema: openApi(LinesBody) })
  lines(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(LinesBody)) body: z.infer<typeof LinesBody>) {
    return this.budgets.saveLines(org.id, user, id, body);
  }

  @Delete(':id')
  @RequirePermission('budgets.manage')
  remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.budgets.remove(org.id, user, id);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @RequirePermission('budgets.manage')
  submit(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.budgets.submit(org.id, user, id);
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @RequirePermission('budgets.manage')
  withdraw(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.budgets.withdraw(org.id, user, id);
  }

  @Post(':id/return')
  @HttpCode(200)
  @RequirePermission('approvals.decide')
  @ApiBody({ schema: openApi(ReturnBody) })
  sendBack(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReturnBody)) body: z.infer<typeof ReturnBody>) {
    return this.budgets.sendBack(org.id, user, id, body.reason);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('approvals.decide')
  approve(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.budgets.approve(org.id, user, id);
  }

  /** Budget against posted actuals by MONTH, QUARTER or YEAR, as of a date (today by default). */
  @Get(':id/variance')
  @RequirePermission('reports.read')
  variance(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(VarianceQuery)) q: z.infer<typeof VarianceQuery>) {
    return this.budgets.variance(org.id, id, q);
  }
}
