import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { ADVANCE_TAX_REGIMES, SCENARIO_GST_RATES } from '@talk2tax/tax-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { TaxScenariosService } from './tax-scenarios.service';

const signed = z.string().trim().regex(/^-?\d{1,13}(\.\d{1,2})?$/, 'An amount with up to 2 decimals');
const amount = z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/, 'An amount of zero or more, with up to 2 decimals');
const YearQuery = z.object({ taxYear: z.string().regex(/^\d{4}-\d{2}$/, 'A tax year such as 2026-27').optional() }).strict();
const Scenario = z
  .object({
    regime: z.enum(ADVANCE_TAX_REGIMES).nullish(),
    revenueChange: signed.default('0'),
    revenueGstRate: z.enum(SCENARIO_GST_RATES).default('18'),
    expenseChange: signed.default('0'),
    expenseGstRate: z.enum(SCENARIO_GST_RATES).default('18'),
    extraDepreciation: amount.default('0'),
    disallowed: amount.default('0'),
  })
  .strict();
const SaveBody = Scenario.extend({ name: z.string().trim().min(1, 'Give the scenario a name').max(100), note: z.string().max(1000).nullish() }).strict();

@ApiTags('tax')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/tax/scenarios')
export class TaxScenariosController {
  constructor(private readonly s: TaxScenariosService) {}

  /** The year's estimate, the tax under each regime open to the business and every saved scenario worked out against it. */
  @Get()
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(YearQuery)) q: z.infer<typeof YearQuery>) {
    return this.s.list(org, q.taxYear);
  }

  /** Works out one scenario without saving it. */
  @Post('simulate')
  @HttpCode(200)
  @RequirePermission('reports.read')
  @ApiBody({ schema: openApi(Scenario) })
  simulate(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(YearQuery)) q: z.infer<typeof YearQuery>, @Body(new ZodPipe(Scenario)) b: z.infer<typeof Scenario>) {
    return this.s.simulate(org, q.taxYear, b);
  }

  /** Saves a named scenario for the tax year. */
  @Post()
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(SaveBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(YearQuery)) q: z.infer<typeof YearQuery>, @Body(new ZodPipe(SaveBody)) b: z.infer<typeof SaveBody>) {
    return this.s.create(org, user, q.taxYear, b);
  }

  @Delete(':scenarioId')
  @RequirePermission('accounts.manage')
  remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('scenarioId', new ZodPipe(z.string().uuid('Not a valid id'))) id: string) {
    return this.s.remove(org, user, id);
  }
}
