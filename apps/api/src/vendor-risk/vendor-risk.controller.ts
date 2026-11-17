import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { VENDOR_RISK_DECISIONS } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { VendorRiskService } from './vendor-risk.service';

const ReviewBody = z
  .object({
    decision: z.enum(VENDOR_RISK_DECISIONS),
    note: z.string().trim().max(1000),
    reviewedOn: isoDate.nullish(),
    nextReviewOn: isoDate,
  })
  .strict();

/** Vendor risk monitoring (AP-024). */
@ApiTags('purchases')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/purchases/vendor-risk')
export class VendorRiskController {
  constructor(private readonly svc: VendorRiskService) {}

  @Get()
  @RequirePermission('purchases.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.svc.list(org.id);
  }

  @Get(':contactId')
  @RequirePermission('purchases.read')
  vendor(@CurrentOrg() org: OrgContext, @Param('contactId', ParseUUIDPipe) id: string) {
    return this.svc.forVendor(org.id, id);
  }

  @Post(':contactId/reviews')
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(ReviewBody) })
  review(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contactId', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReviewBody)) body: z.infer<typeof ReviewBody>) {
    return this.svc.review(org.id, user, id, body);
  }
}
