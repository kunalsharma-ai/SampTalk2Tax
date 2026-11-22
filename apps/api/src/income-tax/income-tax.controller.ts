import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { ADVANCE_TAX_REGIMES } from '@talk2tax/tax-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { IncomeTaxService } from './income-tax.service';

const year = z.string().regex(/^\d{4}-\d{2}$/, 'A financial year such as 2025-26');
const amount = z.string().trim().regex(/^\d{1,15}(\.\d{1,2})?$/, 'An amount such as "150000" or "4500.50"');
const Body_ = z
  .object({
    regime: z.enum(ADVANCE_TAX_REGIMES),
    taxDepreciation: amount.nullable(),
    broughtForwardLoss: amount,
    adjustments: z.array(z.object({ label: z.string().trim().min(1).max(200), section: z.string().trim().max(20).nullable(), kind: z.enum(['ADD', 'DEDUCT']), amount }).strict()).max(50),
    otherCredits: amount,
  })
  .strict();

/**
 * Income tax computation (TAX-019, TAX-020): total income and tax for a financial year from the
 * books, with the preparer's adjustments; save while a draft, finalise once the year has ended.
 */
@ApiTags('tax')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/tax/income-computation')
export class IncomeTaxController {
  constructor(private readonly incomeTax: IncomeTaxService) {}

  @Get()
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(z.object({ year: year.optional() }))) q: { year?: string }) {
    return this.incomeTax.get(org, q.year);
  }

  @Put(':year')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(Body_) })
  save(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('year', new ZodPipe(year)) y: string, @Body(new ZodPipe(Body_)) body: z.infer<typeof Body_>) {
    return this.incomeTax.save(org, user, y, body);
  }

  @Post(':year/finalise')
  @HttpCode(200)
  @RequirePermission('accounts.manage')
  finalise(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('year', new ZodPipe(year)) y: string) {
    return this.incomeTax.finalise(org, user, y);
  }
}
