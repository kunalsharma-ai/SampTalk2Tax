import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { PaymentFraudService } from './payment-fraud.service';

@ApiTags('purchases')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/payment-fraud')
export class PaymentFraudController {
  constructor(private readonly fraud: PaymentFraudService) {}

  /** Vendor payments in open batches and recorded in the last 90 days with fraud warning signs, most serious first. */
  @Get()
  @RequirePermission('reports.read')
  report(@CurrentOrg() org: OrgContext) {
    return this.fraud.report(org);
  }
}
