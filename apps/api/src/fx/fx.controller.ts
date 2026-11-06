import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission, RequireFeature } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { FxService } from './fx.service';

const Currency = z.string().regex(/^[A-Z]{3}$/, 'A three-letter currency code, such as USD');
// Formats only; the engine checks the rate itself and explains it in words.
const Rate = z.string().trim().min(1).max(30);
const RateBody = z.object({ currency: Currency, date: isoDate, rate: Rate, source: z.string().trim().max(200).nullable().optional() }).strict();
const RatesQuery = z.object({ currency: Currency.optional() }).strict();
const RateOverrides = z.record(Currency, Rate).refine((r) => Object.keys(r).length <= 30, 'At most 30 rates');
const ExposureQuery = z.object({ asOf: isoDate }).catchall(z.string());
const RevalueBody = z.object({ date: isoDate, rates: RateOverrides.optional() }).strict();

@ApiTags('fx')
@ApiBearerAuth()
@RequireFeature('MULTI_CURRENCY')
@Controller('v1/orgs/:orgId/fx')
export class FxController {
  constructor(private readonly fx: FxService) {}

  @Get('rates')
  @RequirePermission('reports.read')
  rates(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(RatesQuery)) q: z.infer<typeof RatesQuery>) {
    return this.fx.listRates(org.id, q.currency);
  }

  @Put('rates')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(RateBody) })
  setRate(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(RateBody)) body: z.infer<typeof RateBody>) {
    return this.fx.setRate(org, user, body);
  }

  @Delete('rates/:rateId')
  @HttpCode(204)
  @RequirePermission('accounts.manage')
  async deleteRate(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('rateId', ParseUUIDPipe) id: string) {
    await this.fx.deleteRate(org, user, id);
  }

  /** Foreign balances at `asOf` and a preview of the revaluation; `rate.USD=84.1` tries another rate. */
  @Get('exposure')
  @RequirePermission('reports.read')
  exposure(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ExposureQuery)) q: z.infer<typeof ExposureQuery>) {
    const overrides = Object.fromEntries(Object.entries(q).filter(([k]) => /^rate\.[A-Z]{3}$/.test(k)).map(([k, v]) => [k.slice(5), String(v)]));
    return this.fx.exposure(org, q.asOf, overrides);
  }

  @Get('revaluations')
  @RequirePermission('reports.read')
  revaluations(@CurrentOrg() org: OrgContext) {
    return this.fx.listRevaluations(org);
  }

  /** Posts the revaluation at `date` and its reversal the next day. */
  @Post('revaluations')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(RevalueBody) })
  revalue(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(RevalueBody)) body: z.infer<typeof RevalueBody>) {
    return this.fx.revalue(org, user, body);
  }
}
