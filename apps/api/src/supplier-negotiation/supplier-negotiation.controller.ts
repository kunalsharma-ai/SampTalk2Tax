import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { SupplierNegotiationService } from './supplier-negotiation.service';

const id = z.string().uuid('Not a valid id');

@ApiTags('supplier negotiation')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/purchases/negotiation-briefs')
export class SupplierNegotiationController {
  constructor(private readonly negotiation: SupplierNegotiationService) {}

  /** Every vendor billed in the last twelve months, with the points to raise and the possible saving. */
  @Get()
  @RequirePermission('purchases.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.negotiation.list(org);
  }

  /** One vendor's negotiation brief. */
  @Get(':contactId')
  @RequirePermission('purchases.read')
  detail(@CurrentOrg() org: OrgContext, @Param('contactId', new ZodPipe(id)) contactId: string) {
    return this.negotiation.detail(org, contactId);
  }
}
