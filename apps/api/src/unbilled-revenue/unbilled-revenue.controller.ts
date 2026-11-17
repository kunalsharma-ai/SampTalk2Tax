import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { UnbilledRevenueService } from './unbilled-revenue.service';

const DismissBody = z
  .object({
    fingerprint: z.string().regex(/^(MILESTONE|CONTRACT_PERIOD|DRAFT_INVOICE|ORDER|PRO_FORMA|REGULAR_CUSTOMER):[0-9a-f-]{36}$/, 'Not a finding'),
    action: z.enum(['DISMISS', 'RESTORE']),
    reason: z.string().trim().min(3, 'Say why').max(500),
  })
  .strict();

/** Unbilled revenue detection (AR-042). */
@ApiTags('sales')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/sales/unbilled-revenue')
export class UnbilledRevenueController {
  constructor(private readonly svc: UnbilledRevenueService) {}

  @Get()
  @RequirePermission('sales.read')
  report(@CurrentOrg() org: OrgContext) {
    return this.svc.report(org.id);
  }

  @Post('dismissals')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(DismissBody) })
  dismiss(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(DismissBody)) body: z.infer<typeof DismissBody>) {
    return this.svc.dismiss(org.id, user, body);
  }
}
