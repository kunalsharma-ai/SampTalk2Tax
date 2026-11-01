import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { TaxRatesService } from './tax-rates.service';

const rate = z.string().regex(/^\d{1,3}(\.\d{1,6})?$/, 'Percentage as a decimal string, e.g. "18" or "12.5"');
const CreateBody = z.object({
  name: z.string().trim().min(1).max(100),
  rate,
  /** GST rates split into CGST + SGST/UTGST or IGST and post to the GST registration's accounts. */
  kind: z.enum(['SIMPLE', 'GST']).default('SIMPLE'),
  gstCategory: z.enum(['TAXABLE', 'NIL_RATED', 'EXEMPT', 'NON_GST']).optional(),
  salesAccountId: z.uuid().nullable().optional(),
  purchaseAccountId: z.uuid().nullable().optional(),
});
const UpdateBody = z.object({ name: z.string().trim().min(1).max(100).optional(), isActive: z.boolean().optional(), salesAccountId: z.uuid().nullable().optional(), purchaseAccountId: z.uuid().nullable().optional() }).strict();
const ListQuery = z.object({ includeInactive: z.enum(['true', 'false']).optional().transform((v) => v === 'true') });

@ApiTags('tax-rates')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/tax-rates')
export class TaxRatesController {
  constructor(private readonly taxRates: TaxRatesService) {}

  @Get()
  @RequirePermission('accounts.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.taxRates.list(org.id, q.includeInactive);
  }

  @Post()
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    return this.taxRates.create(org.id, user, body);
  }

  /** The rate itself cannot change once created, so posted documents keep their meaning; create a new rate instead. */
  @Patch(':taxRateId')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(UpdateBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('taxRateId', ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateBody)) body: z.infer<typeof UpdateBody>) {
    return this.taxRates.update(org.id, user, id, body);
  }
}
