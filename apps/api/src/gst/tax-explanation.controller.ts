import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { TaxExplanationService } from './tax-explanation.service';

/** Source-backed tax explanations (TAX-052): how the tax on a document was worked out, with sources. */
@ApiTags('gst')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId')
export class TaxExplanationController {
  constructor(private readonly s: TaxExplanationService) {}

  @Get('sales/documents/:documentId/tax-explanation')
  @RequirePermission('sales.read')
  sales(@CurrentOrg() org: OrgContext, @Param('documentId', ParseUUIDPipe) id: string) {
    return this.s.explain(org, 'SALES', id);
  }

  @Get('purchases/documents/:documentId/tax-explanation')
  @RequirePermission('purchases.read')
  purchases(@CurrentOrg() org: OrgContext, @Param('documentId', ParseUUIDPipe) id: string) {
    return this.s.explain(org, 'PURCHASES', id);
  }
}
