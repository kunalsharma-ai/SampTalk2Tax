import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { REGISTRATION_STATUSES, TAXPAYER_TYPES } from '@talk2tax/tax-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { SupplierTaxService } from './supplier-tax.service';

const CheckBody = z
  .object({
    status: z.enum(REGISTRATION_STATUSES),
    taxpayerType: z.enum(TAXPAYER_TYPES).nullish(),
    legalName: z.string().trim().max(200).nullish(),
    effectiveDate: isoDate.nullish(),
    checkedOn: isoDate,
    note: z.string().trim().max(500).nullish(),
  })
  .strict();

/** Supplier tax validation (AP-019). */
@ApiTags('purchases')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/purchases/supplier-tax')
export class SupplierTaxController {
  constructor(private readonly svc: SupplierTaxService) {}

  @Get()
  @RequirePermission('purchases.read')
  report(@CurrentOrg() org: OrgContext) {
    return this.svc.report(org);
  }

  @Get(':contactId')
  @RequirePermission('purchases.read')
  vendor(@CurrentOrg() org: OrgContext, @Param('contactId', ParseUUIDPipe) id: string) {
    return this.svc.forVendor(org, id);
  }

  @Post(':contactId/checks')
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(CheckBody) })
  record(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contactId', ParseUUIDPipe) id: string, @Body(new ZodPipe(CheckBody)) body: z.infer<typeof CheckBody>) {
    return this.svc.recordCheck(org, user, id, body);
  }
}
