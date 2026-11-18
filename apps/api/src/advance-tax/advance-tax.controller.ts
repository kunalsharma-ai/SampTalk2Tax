import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { ADVANCE_TAX_REGIMES } from '@talk2tax/tax-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { AdvanceTaxService } from './advance-tax.service';

const amount = z.string().trim().regex(/^-?\d{1,13}(\.\d{1,2})?$/, 'An amount with up to 2 decimals');
const YearQuery = z.object({ taxYear: z.string().regex(/^\d{4}-\d{2}$/, 'A tax year such as 2026-27').optional() }).strict();
const PlanBody = z
  .object({
    taxYear: z.string().regex(/^\d{4}-\d{2}$/, 'A tax year such as 2026-27'),
    regime: z.enum(ADVANCE_TAX_REGIMES),
    method: z.enum(['ANNUALISE', 'ESTIMATE']),
    estimatedIncome: amount.nullable(),
    adjustments: z.array(z.object({ label: z.string().trim().min(1).max(100), amount }).strict()).max(30),
    paidAccountId: z.string().uuid().nullable(),
    tdsAccountId: z.string().uuid().nullable(),
    otherCredits: amount.refine((x) => !x.startsWith('-'), 'Credits cannot be negative'),
  })
  .strict();

@ApiTags('tax')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/tax/advance-tax')
export class AdvanceTaxController {
  constructor(private readonly s: AdvanceTaxService) {}

  /** The year's estimated income, tax, credits and the four instalments with what was paid by each (current tax year by default). */
  @Get()
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(YearQuery)) q: z.infer<typeof YearQuery>) {
    return this.s.get(org, q.taxYear);
  }

  /** Saves how the year's income is estimated and which accounts hold advance tax paid and tax deducted at source. */
  @Put()
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(PlanBody) })
  save(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(PlanBody)) b: z.infer<typeof PlanBody>) {
    const { taxYear, ...plan } = b;
    return this.s.save(org, user.id, taxYear, plan);
  }
}
